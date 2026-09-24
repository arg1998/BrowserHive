/** @module features/system/SystemPage.test — section mapping (tab param, settings groups, runtime problems, degraded 503 health body, notices shown once), Status KPIs and health, Configuration provenance with shadowed values and redacted secrets, tab state in the URL, one page-level 403, axe clean */

import { describe, expect, it } from 'bun:test';
import type { SystemInfo } from '@browserhive/contracts/http';
import { AppError } from '@/lib/api/errors.ts';
import { NOW, systemConfig, systemInfo } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { configDisplay, filterConfig } from './config/ConfigTable.tsx';
import { browserRows, readHealth, runtimeRows, settingsGroups, systemNotices } from './model.ts';
import { SystemPage } from './SystemPage.tsx';
import { systemSearch, systemSection } from './search.ts';

const HEALTH = {
  status: 'ready',
  phase: 'ready',
  version: '0.1.0',
  uptime_ms: 1000,
  checks: { db: 'ok', browser: 'ok', listeners: 'ok' },
} as const;

const degradation = (resolved: boolean) => ({
  event_id: resolved ? 'd2' : 'd1',
  code: resolved ? 'OTEL_EXPORT_FAILED' : 'RETENTION_FAILED',
  severity: 'warn' as const,
  message: resolved ? 'otel export failed' : 'retention pass failed',
  details: null,
  first_seen_at: NOW - 1000,
  last_seen_at: NOW,
  count: 2,
  resolved_at: resolved ? NOW : null,
});

function mount(url = '/system', system: unknown = systemInfo(), health: unknown = HEALTH) {
  return renderPage({
    path: '/system',
    component: SystemPage,
    validateSearch: (s) => systemSearch.parse(s),
    routes: {
      'GET /system': system,
      'GET /system/config': systemConfig(),
      'GET /system/realtime': { connections: [] },
      'GET /system/mcp/connections': { connections: [], live: 0, now: NOW },
      'GET /auth/tokens': { data: [] },
      'GET /system/events': envelope([degradation(false), degradation(true)]),
      'GET /health': health,
    },
    url,
  });
}

describe('system section mapping', () => {
  it('maps the tab param and falls back to Status', () => {
    expect(systemSection('config')).toBe('config');
    expect(systemSection('nope')).toBe('status');
    expect(systemSearch.parse({ tab: 'bogus' }).tab).toBe('status');
  });

  it('groups static configuration and flags runtime problems with a fix', () => {
    const s = systemInfo({
      runtime: { ...systemInfo().runtime, chromium: null },
      capacity: { live: 0, max: 8, max_source: 'config' },
      allow_evaluate: true,
      vault: { enabled: true, backend: 'bitwarden' },
    });
    expect(settingsGroups(s).map((g) => g.id)).toEqual([
      'server',
      'sessions',
      'stealth',
      'integrations',
    ]);
    const evaluate = settingsGroups(s)[1]?.rows.find((r) => r.label === 'Evaluate tool');
    expect(evaluate?.tone).toBe('danger');
    const chromium = runtimeRows(s).find((r) => r.label === 'Chromium');
    expect(chromium).toMatchObject({ value: 'Not installed', tone: 'warn' });
    expect(chromium?.fix).toContain('browserhive init');
    // Static configuration: enum values in sans, mono only for addresses and paths.
    const rows = settingsGroups(s).flatMap((g) => g.rows);
    expect(rows.filter((r) => r.mono === true).map((r) => r.label)).toEqual([
      'Bind address',
      'Data directory',
    ]);
    expect(systemNotices(s, undefined).map((n) => n.id)).toEqual(['evaluate']);
  });

  it('does not call Chromium missing while a browser launches', () => {
    const noVersion = { ...systemInfo().runtime, chromium: null };
    const idle = systemInfo({
      runtime: noVersion,
      capacity: { live: 0, max: 8, max_source: 'config' },
    });
    const running = systemInfo({ runtime: noVersion });
    const row = (s: SystemInfo, health?: unknown) =>
      runtimeRows(s, readHealth(health, null)).find((r) => r.label === 'Chromium');
    expect(row(running)).toMatchObject({ value: 'Available, version not reported', muted: true });
    expect(row(running)?.tone).toBeUndefined();
    expect(row(idle, HEALTH)?.tone).toBeUndefined();
    expect(row(idle, { ...HEALTH, checks: { ...HEALTH.checks, browser: 'failed' } })).toMatchObject(
      {
        tone: 'warn',
      },
    );
    expect(row(systemInfo())?.value).toBe('141.0.7390.37');
  });

  it('reads the degraded health body a 503 carries', () => {
    const degraded = {
      ...HEALTH,
      status: 'degraded',
      checks: { ...HEALTH.checks, browser: 'failed' },
    };
    const error = new AppError({
      code: 'INTERNAL_ERROR',
      status: 503,
      title: 'x',
      retryable: 'backoff',
      details: { body: degraded },
    });
    expect(readHealth(undefined, error)?.status).toBe('degraded');
    expect(readHealth(HEALTH, null)?.status).toBe('ready');
    expect(systemNotices(systemInfo(), readHealth(undefined, error)).map((n) => n.id)).toEqual([
      'degraded',
    ]);
  });

  it('never shows a secret and filters by key, value or source', () => {
    expect(configDisplay('hunter2', true)).toBe('redacted');
    expect(configDisplay('[REDACTED]', false)).toBe('redacted');
    expect(configDisplay({ root: 'info' }, false)).toBe('{"root":"info"}');
    const keys = systemConfig().keys;
    expect(filterConfig(keys, 'cli', false).map((k) => k.key)).toEqual(['port', 'maxSessions']);
    expect(filterConfig(keys, '', true).map((k) => k.key)).toEqual([
      'port',
      'maxSessions',
      'authTokens',
      'otelEndpoint',
      'otelHeaders',
      'otelTraceUrlTemplate',
    ]);
    expect(filterConfig(keys, 'hunter', false)).toEqual([]);
  });

  it('filters by variable name, with or without $, and to values from references', () => {
    const keys = systemConfig().keys;
    const names = (rows: readonly { key: string }[]) => rows.map((k) => k.key);
    expect(names(filterConfig(keys, '', false, true))).toEqual([
      'maxSessions',
      'otelEndpoint',
      'otelHeaders',
    ]);
    expect(names(filterConfig(keys, '$otlp', false))).toEqual(['otelEndpoint', 'otelHeaders']);
    // A secret key is found by its variable's name, never by its value.
    expect(names(filterConfig(keys, 'OTLP_TOKEN', false))).toEqual(['otelHeaders']);
    expect(names(filterConfig(keys, 'max_sessions', false))).toEqual(['maxSessions']);
    expect(names(filterConfig(keys, 'collector', false, true))).toEqual(['otelEndpoint']);
  });
});

describe('SystemPage', () => {
  it('shows KPIs, health, runtime and degradations on Status', async () => {
    const view = mount();
    const kpis = await screen.findByRole('region', { name: 'System status' });
    expect(within(kpis).getByText('2 / 8')).toBeTruthy();
    expect(within(kpis).getByRole('link', { name: /Open attention/ })).toBeTruthy();
    expect(await screen.findByText('141.0.7390.37')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Degradations' });
    expect(within(list).getByText('RETENTION_FAILED')).toBeTruthy();
    expect(within(list).getByText('resolved')).toBeTruthy();
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Applied migrations' })).toBeTruthy();
    await expectNoA11yViolations(view.container);
  });

  it('keeps the degraded health section visible from the 503 body', async () => {
    mount('/system', systemInfo(), {
      status: 503,
      body: { ...HEALTH, status: 'degraded', checks: { ...HEALTH.checks, browser: 'failed' } },
    });
    expect(await screen.findByText('Degraded')).toBeTruthy();
    expect(screen.getByText('The daemon is degraded')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('renders provenance, shadowed values and redacted secrets on Configuration, tab in the URL', async () => {
    const view = mount();
    await screen.findByRole('region', { name: 'System status' });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    });
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ tab: 'config' }));
    const region = await screen.findByRole('region', { name: 'Effective configuration' });
    const port = within(region).getByRole('rowheader', { name: 'port' }).closest('tr');
    if (port === null) throw new Error('port row missing');
    expect(within(port).getByText('9876')).toBeTruthy();
    expect(within(port).getByText('cli')).toBeTruthy();
    expect(within(port).getByRole('list', { name: 'Values port overrides' }).textContent).toContain(
      '9000',
    );
    const secret = within(region).getByRole('rowheader', { name: 'authTokens' }).closest('tr');
    if (secret === null) throw new Error('secret row missing');
    expect(within(secret).getByText('redacted')).toBeTruthy();
    expect(region.textContent).not.toContain('[REDACTED]');
    expect(screen.getByText('Bind address')).toBeTruthy();
    await expectNoA11yViolations(view.container);
  });

  it('names the variable behind a reference; the popover shows the file text unless secret', async () => {
    const view = mount('/system?tab=config');
    const region = await screen.findByRole('region', { name: 'Effective configuration' });
    const row = (key: string) => {
      const tr = within(region).getByRole('rowheader', { name: key }).closest('tr');
      if (tr === null) throw new Error(`${key} row missing`);
      return tr;
    };
    const endpoint = row('otelEndpoint');
    expect(within(endpoint).getByText('http://collector.internal:4318')).toBeTruthy();
    const chip = within(endpoint).getByRole('button', {
      name: /^\$OTLP_HOST: environment variable, set/,
    });
    await act(async () => {
      fireEvent.click(chip);
    });
    const template = await screen.findByText('In browserhive.config.json');
    const popover = template.closest('[data-slot="popover-content"]');
    if (!(popover instanceof HTMLElement)) throw new Error('popover missing');
    expect(popover.textContent).toContain('http://{env:OTLP_HOST}:4318');
    const docs = within(popover).getByRole('link', { name: /How references work/ });
    expect(docs.getAttribute('href')).toBe(
      'https://browserhive.ai/docs/guide/configuration/#references',
    );
    await expectNoA11yViolations(view.container);

    const headers = row('otelHeaders');
    expect(within(headers).getByText('redacted')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(headers).getByRole('button', { name: /^\$OTLP_TOKEN/ }));
    });
    expect(
      await screen.findByText("The value is secret, so only the variable's name is shown."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('{env:OTLP_TOKEN}');

    const overrides = within(row('maxSessions')).getByRole('list', {
      name: 'Values maxSessions overrides',
    });
    expect(overrides.textContent).toContain('via $MAX_SESSIONS');
    expect(
      within(row('maxSessions')).queryByRole('list', {
        name: 'Environment variables maxSessions reads',
      }),
    ).toBeNull();
  });

  it('shows one page-level 403 instead of an error in every panel', async () => {
    mount('/system', problem(403, 'FORBIDDEN', 'Forbidden'));
    expect(await screen.findByText('System is for operators')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'Retry' })).toHaveLength(0);
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('browsers and sandbox', () => {
  const browser = (mode: 'auto' | 'on' | 'off', root = false) =>
    systemInfo({
      browser: {
        default_channel: 'chrome',
        sandbox_mode: mode,
        running_as_root: root,
        channels: [
          {
            channel: 'chromium',
            label: 'Chrome for Testing',
            source: 'bundled',
            installed: true,
            version: '153.0.8010.12',
            executable: '/cache/chromium-1243/chrome',
            sandbox: 'unavailable',
            sandbox_reason: 'No usable sandbox!',
          },
          {
            channel: 'chrome',
            label: 'Google Chrome',
            source: 'installed',
            installed: true,
            version: '154.0.8037.57',
            executable: '/opt/google/chrome/chrome',
            sandbox: 'sandboxed',
            sandbox_reason: null,
          },
          {
            channel: 'edge',
            label: 'Microsoft Edge',
            source: 'installed',
            installed: false,
            version: null,
            executable: null,
            sandbox: 'unknown',
            sandbox_reason: null,
          },
        ],
      },
    } as Partial<SystemInfo>);

  it('lists the default first with a verdict per installed browser', () => {
    const rows = browserRows(browser('auto')) ?? [];
    expect(rows.map((r) => [r.channel, r.isDefault, r.sandbox?.label ?? null])).toEqual([
      ['chrome', true, 'sandboxed'],
      ['chromium', false, 'falls back: no sandbox'],
      ['edge', false, null],
    ]);
    expect(rows[1]?.reason).toBe('No usable sandbox!');
    expect(browserRows(systemInfo())).toBeNull();
  });

  it('an unknown verdict reads as "sandbox off" under off and as root under root', () => {
    const unknown = (s: SystemInfo) => ({
      ...s,
      browser: s.browser && {
        ...s.browser,
        channels: s.browser.channels.map((c) => ({ ...c, sandbox: 'unknown' as const })),
      },
    });
    expect(browserRows(unknown(browser('off')))?.[0]?.sandbox?.label).toBe('sandbox off');
    expect(browserRows(unknown(browser('auto')))?.[0]?.sandbox?.label).toBe('not checked yet');
    expect(browserRows(unknown(browser('auto', true)))?.[0]?.sandbox?.label).toBe(
      'no sandbox as root',
    );
  });

  it('the Status tab shows the Browsers and sandbox panel', async () => {
    mount('/system', browser('auto'));
    const list = await screen.findByRole('list', { name: 'Browsers' });
    expect(within(list).getByText('Google Chrome')).toBeTruthy();
    expect(within(list).getByText('No usable sandbox!')).toBeTruthy();
    expect(screen.getByText(/sandbox auto: on wherever the browser can run with it/)).toBeTruthy();
  });
});
