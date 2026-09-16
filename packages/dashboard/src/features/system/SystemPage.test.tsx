/** @module features/system/SystemPage.test — section mapping (tab param, settings groups, runtime problems, degraded 503 health body, notices shown once), Status KPIs and health, Configuration provenance with shadowed values and redacted secrets, tab state in the URL, one page-level 403, axe clean */

import { describe, expect, it } from 'bun:test';
import type { SystemInfo } from '@browserhive/contracts/http';
import { AppError } from '@/lib/api/errors.ts';
import { NOW, systemConfig, systemInfo } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { configDisplay, filterConfig } from './config/ConfigTable.tsx';
import { readHealth, runtimeRows, settingsGroups, systemNotices } from './model.ts';
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
    expect(filterConfig(keys, 'cli', false).map((k) => k.key)).toEqual(['port']);
    expect(filterConfig(keys, '', true).map((k) => k.key)).toEqual([
      'port',
      'authTokens',
      'otelTraceUrlTemplate',
    ]);
    expect(filterConfig(keys, 'hunter', false)).toEqual([]);
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

  it('shows one page-level 403 instead of an error in every panel', async () => {
    mount('/system', problem(403, 'FORBIDDEN', 'Forbidden'));
    expect(await screen.findByText('System is for operators')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'Retry' })).toHaveLength(0);
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
