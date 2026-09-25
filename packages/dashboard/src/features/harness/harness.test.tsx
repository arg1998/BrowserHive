/** @module features/harness/harness.test — the harness surfaces (D-30): the Overview "Harnesses" card (Unknown always listed, whole-row links to the filtered sessions list), the session "Client" panel ("not reported" model, source phrase, meta, no client), the System "MCP connections" panel (live first, conflicts, detail popover), the sessions Harness facet chips; axe clean */

import { describe, expect, it } from 'bun:test';
import type { HarnessMetricsResponse, McpConnectionRow } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { harnessSourcePhrase, SELF_REPORTED_NOTE } from '@/lib/harness.ts';
import { NOW, systemConfig, systemInfo } from '../../../test/fixtures/ops.ts';
import { sessionSummary, sessionsPage } from '../../../test/fixtures/sessions.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { SessionsPage } from '../sessions/SessionsPage.tsx';
import { sessionsSearch } from '../sessions/search.ts';
import { SystemPage } from '../system/SystemPage.tsx';
import { systemSearch } from '../system/search.ts';
import { ClientPanel } from './ClientPanel.tsx';
import { HarnessesCard, harnessSessionsHref } from './HarnessesCard.tsx';
import { conflictText } from './McpConnectionsPanel.tsx';

const connection = (patch: Partial<McpConnectionRow> = {}): McpConnectionRow => ({
  connection_id: 'c-aaaaaaaaaa',
  transport: 'http',
  principal: 'local',
  live: true,
  harness: 'claude-code',
  harness_label: 'Claude Code',
  harness_source: 'client_info',
  model: null,
  model_source: null,
  workspace: 'checkout',
  client_name: 'claude-code',
  client_version: '2.1.281',
  client_title: null,
  protocol_version: '2025-06-18',
  user_agent: 'claude-code/2.1.281 (cli)',
  ip: '127.0.0.1',
  connected_at: NOW - 60_000,
  last_seen_at: NOW - 1_000,
  closed_at: null,
  sessions: 2,
  conflicts: [],
  meta: {},
  ...patch,
});

describe('harness copy', () => {
  it('phrases every source and keeps unknown ones as given', () => {
    expect(harnessSourcePhrase('client_info')).toBe('from clientInfo');
    expect(harnessSourcePhrase('injected_env')).toBe('set by the harness');
    expect(harnessSourcePhrase(null)).toBe('not identified');
    expect(harnessSourcePhrase('token')).toBe('token');
    expect(conflictText({ source: 'user_agent', value: 'Cursor/1.0', harness: 'cursor' })).toBe(
      'User-Agent said Cursor/1.0',
    );
  });

  it('links a harness row to the filtered sessions list, keeping the window', () => {
    expect(harnessSessionsHref('claude-code', { since: 5 })).toBe(
      '/sessions?harness=claude-code&since=5',
    );
    expect(harnessSessionsHref('unknown', {})).toBe('/sessions?harness=unknown');
  });
});

describe('HarnessesCard', () => {
  it('lists harnesses with sessions and calls, Unknown last; axe clean', async () => {
    const view = renderPage({
      path: '/x',
      component: function Card() {
        return (
          <HarnessesCard
            query={
              {
                data: {
                  data: [
                    {
                      harness: 'claude-code',
                      label: 'Claude Code',
                      sessions: 3,
                      sessions_live: 1,
                      tool_calls: 42,
                      errors: 2,
                    },
                    {
                      harness: 'codex',
                      label: 'Codex',
                      sessions: 0,
                      sessions_live: 0,
                      tool_calls: 0,
                      errors: 0,
                    },
                    {
                      harness: 'unknown',
                      label: 'Unknown',
                      sessions: 1,
                      sessions_live: 0,
                      tool_calls: 0,
                      errors: 0,
                    },
                  ],
                  window: { since: 0, until: NOW },
                  now: NOW,
                },
                isPending: false,
                isSuccess: true,
                isError: false,
                status: 'success',
                failureCount: 0,
                fetchStatus: 'idle',
              } as unknown as UseQueryResult<HarnessMetricsResponse, unknown>
            }
            rangeLabel="7d"
            window={{ since: 5 }}
          />
        );
      },
      routes: {},
      url: '/x',
    });
    const list = await screen.findByRole('list', { name: 'Harnesses' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/sessions?harness=claude-code&since=5',
      '/sessions?harness=unknown&since=5',
    ]);
    expect(within(list).getByText('Claude Code')).toBeDefined();
    expect(within(list).getByText('Unknown')).toBeDefined();
    expect(within(list).getByText(/42 calls/)).toBeDefined();
    expect(within(list).getByText(/2 errors/)).toBeDefined();
    await expectNoA11yViolations(view.container);
  });
});

describe('ClientPanel', () => {
  it('shows the harness, its source, "not reported" and the meta table', async () => {
    const view = renderPage({
      path: '/x',
      component: () => (
        <ClientPanel
          session={sessionSummary(1, {
            harness: 'claude-code',
            client: {
              name: 'claude-code',
              version: '2.1.281',
              harness: 'claude-code',
              harness_label: 'Claude Code',
              harness_source: 'injected_env',
              workspace: 'checkout',
              protocol_version: '2025-06-18',
              meta: { team: 'growth' },
            },
          })}
        />
      ),
      routes: {},
      url: '/x',
    });
    const panel = await screen.findByRole('region', { name: /Client/ });
    expect(within(panel).getByText('Claude Code')).toBeDefined();
    expect(within(panel).getByText('claude-code', { selector: '.font-mono' })).toBeDefined();
    expect(within(panel).getByText('set by the harness')).toBeDefined();
    expect(within(panel).getByText('not reported')).toBeDefined();
    expect(within(panel).getByText('checkout')).toBeDefined();
    expect(within(panel).getByText('growth')).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: /About/ }));
    expect(await screen.findByText(SELF_REPORTED_NOTE)).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('shows Unknown and says no client was recorded', async () => {
    renderPage({
      path: '/x',
      component: () => (
        <ClientPanel session={sessionSummary(1, { harness: 'unknown', client: null })} />
      ),
      routes: {},
      url: '/x',
    });
    const panel = await screen.findByRole('region', { name: /Client/ });
    expect(within(panel).getByText('Unknown')).toBeDefined();
    expect(within(panel).getByText('not identified')).toBeDefined();
    expect(within(panel).getByText(/No client details/)).toBeDefined();
  });
});

describe('System MCP connections', () => {
  const HEALTH = {
    status: 'ready',
    phase: 'ready',
    version: '0.1.0',
    uptime_ms: 1000,
    checks: { db: 'ok', browser: 'ok', listeners: 'ok' },
  } as const;

  it('lists connections live first with a conflicts chip and a detail popover; axe clean', async () => {
    const view = renderPage({
      path: '/system',
      component: SystemPage,
      validateSearch: (s) => systemSearch.parse(s),
      routes: {
        'GET /system': systemInfo(),
        'GET /system/config': systemConfig(),
        'GET /system/realtime': { connections: [] },
        'GET /system/events': envelope([]),
        'GET /health': HEALTH,
        'GET /system/mcp/connections': {
          connections: [
            connection({
              conflicts: [{ source: 'user_agent', value: 'Cursor/1.7.3', harness: 'cursor' }],
              model: 'claude-opus-5',
              model_source: 'header',
              meta: { team: 'growth' },
            }),
            connection({
              connection_id: 'c-bbbbbbbbbb',
              transport: 'stdio',
              live: false,
              harness: 'unknown',
              harness_label: 'Unknown',
              harness_source: 'none',
              client_name: 'mcp',
              workspace: null,
              user_agent: null,
              ip: null,
              closed_at: NOW - 30_000,
              sessions: 0,
            }),
          ],
          live: 1,
          total: 2,
          now: NOW,
        },
      },
      url: '/system',
    });
    const list = await screen.findByRole('list', { name: 'MCP connections' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    // Everything fits on one page: no pager.
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    expect(rows[0]?.getAttribute('aria-label')).toBe('Connection details: Claude Code, live');
    expect(within(list).getByText('conflicting signals')).toBeDefined();
    expect(within(list).getByText('Unknown')).toBeDefined();
    expect(screen.getByText('1 live · most recent first')).toBeDefined();
    await act(async () => {
      fireEvent.click(rows[0] as HTMLElement);
    });
    await waitFor(() => expect(screen.getByText('User-Agent said Cursor/1.7.3')).toBeDefined());
    expect(screen.getByText('claude-opus-5')).toBeDefined();
    expect(screen.getByText('by header')).toBeDefined();
    expect(screen.getByText('growth')).toBeDefined();
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('pages the list 10 at a time and fetches each page from the server', async () => {
    const pageRows = Array.from({ length: 10 }, (_, i) =>
      connection({ connection_id: `c-${String(i).padStart(10, '0')}` }),
    );
    const view = renderPage({
      path: '/system',
      component: SystemPage,
      validateSearch: (s) => systemSearch.parse(s),
      routes: {
        'GET /system': systemInfo(),
        'GET /system/config': systemConfig(),
        'GET /system/realtime': { connections: [] },
        'GET /system/events': envelope([]),
        'GET /health': HEALTH,
        'GET /system/mcp/connections': { connections: pageRows, live: 10, total: 23, now: NOW },
      },
      url: '/system',
    });
    const list = await screen.findByRole('list', { name: 'MCP connections' });
    expect(within(list).getAllByRole('button')).toHaveLength(10);
    const lastQuery = () =>
      view.requests.filter((r) => r.path === '/api/v1/system/mcp/connections').at(-1)?.query;
    expect(lastQuery()?.get('limit')).toBe('10');
    expect(lastQuery()?.get('offset')).toBe('0');
    const pager = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(pager).getByText('1–10 of 23')).toBeDefined();
    expect(within(pager).getByText('1 / 3')).toBeDefined();
    await act(async () => {
      fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    });
    await waitFor(() => expect(lastQuery()?.get('offset')).toBe('10'));
    expect(lastQuery()?.get('limit')).toBe('10');
    await waitFor(() => expect(within(pager).getByText('11–20 of 23')).toBeDefined());
  });
});

describe('sessions Harness facet', () => {
  it('shows labelled harness chips and forwards the filter to the API', async () => {
    const rows = [sessionSummary(1), sessionSummary(2, { harness: 'unknown', client: null })];
    const page = sessionsPage(rows);
    const view = renderPage({
      path: '/sessions',
      component: SessionsPage,
      validateSearch: (s) => sessionsSearch.parse(s),
      routes: {
        'GET /sessions': {
          ...page,
          facets: {
            ...page.facets,
            harnesses: [
              { value: 'claude-code', count: 1 },
              { value: 'unknown', count: 1 },
            ],
          },
        },
      },
      url: '/sessions',
    });
    await screen.findByRole('region', { name: 'Sessions' });
    const chip = screen.getByRole('button', { name: /Claude Code/ });
    expect(screen.getByRole('button', { name: /^Unknown/ })).toBeDefined();
    await act(async () => {
      fireEvent.click(chip);
    });
    await waitFor(() => {
      const last = view.requests.filter((r) => r.path === '/api/v1/sessions').at(-1);
      expect(last?.query.get('harness')).toBe('claude-code');
    });
    expect(sessionsSearch.parse({ harness: 'claude-code,unknown' }).harness).toEqual([
      'claude-code',
      'unknown',
    ]);
  });
});
