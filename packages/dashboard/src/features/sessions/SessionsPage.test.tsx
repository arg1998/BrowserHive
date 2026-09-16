/** @module features/sessions/SessionsPage.test — rows + facets, filters written to the URL (page reset) and the REST query, empty states, bulk bar flow with confirm and per-item results, WS patch, card band classes at 390 px, axe */

import { describe, expect, it } from 'bun:test';
import { sessionSummary, sessionsPage, setViewport, T0 } from '../../../test/fixtures/sessions.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { countText, SessionsPage } from './SessionsPage.tsx';
import { sessionsSearch } from './search.ts';

const ROWS = [
  sessionSummary(1),
  sessionSummary(2, {
    slug: 'docs',
    live: false,
    state: 'closed',
    closed_reason: 'crash',
    closed_at: T0 - 5000,
  }),
];

function mount(url: string, rows = ROWS) {
  return renderPage({
    path: '/sessions',
    component: SessionsPage,
    validateSearch: (s) => sessionsSearch.parse(s),
    routes: {
      'GET /sessions': (req: { query: URLSearchParams }) =>
        req.query.get('q') === 'zzz' ? sessionsPage([]) : sessionsPage(rows),
      'POST /sessions/bulk': (req: { body: { session_ids: string[] } }) => ({
        results: req.body.session_ids.map((id, i) =>
          i === 0
            ? { session_id: id, ok: true }
            : {
                session_id: id,
                ok: false,
                error: { code: 'SESSION_LIVE', title: 'Session is live' },
              },
        ),
        ok_count: 1,
        error_count: Math.max(0, req.body.session_ids.length - 1),
      }),
    },
    url,
  });
}

const lastList = (requests: readonly { method: string; path: string; query: URLSearchParams }[]) =>
  requests.filter((r) => r.method === 'GET' && r.path === '/api/v1/sessions').at(-1);

describe('SessionsPage', () => {
  it('renders rows, header count and facet chips; axe clean', async () => {
    const view = mount('/sessions');
    const table = await screen.findByRole('region', { name: 'Sessions' });
    expect(within(table).getAllByRole('link', { name: 'shop' }).length).toBeGreaterThan(0);
    expect(within(table).getAllByText('crashed').length).toBeGreaterThan(0);
    expect(screen.getByText('2 sessions · 1 live')).toBeDefined();
    // Unfiltered: the header carries the count, the filter row does not repeat it.
    expect(screen.queryByText('2 matching')).toBeNull();
    expect(screen.getByRole('button', { name: /chromium/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(lastList(view.requests)?.query.get('total')).toBe('true');
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('writes filters to the URL, resets page and forwards them to the API', async () => {
    const view = mount('/sessions?page=3');
    await screen.findByRole('region', { name: 'Sessions' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /chromium/ }));
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ channel: ['chromium'] }),
    );
    expect(view.router.state.location.search).toMatchObject({ page: 1 });
    await waitFor(() => expect(lastList(view.requests)?.query.get('channel')).toBe('chromium'));
    // Filtered: the filter row says how many match and the header drops its fleet count.
    expect(await screen.findByText('2 matching')).toBeDefined();
    expect(screen.queryByText('2 sessions · 1 live')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archived sessions' }));
    });
    await waitFor(() => expect(lastList(view.requests)?.query.get('view')).toBe('archived'));
  });

  it('shows the zero-results state with Clear filters', async () => {
    const view = mount('/sessions?q=zzz');
    await screen.findByText('No sessions match these filters');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    });
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('q'));
  });

  it('runs a bulk archive with confirm and shows per-item results', async () => {
    const view = mount('/sessions');
    const table = await screen.findByRole('region', { name: 'Sessions' });
    await act(async () => {
      fireEvent.click(
        within(table).getByRole('checkbox', { name: 'Select all rows on this page' }),
      );
    });
    await screen.findByText('2 selected');
    // Selection is local state, never written to the URL.
    expect(view.router.state.location.search).not.toHaveProperty('sel');
    expect(screen.getByRole('button', { name: 'Terminate 1 live' })).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    });
    const confirm = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    });
    const result = await screen.findByRole('dialog', { name: 'Archived sessions' });
    expect(within(result).getByText('1 ok · 1 failed')).toBeDefined();
    expect(within(result).getByText('SESSION_LIVE')).toBeDefined();
    const bulk = view.requests.find((r) => r.path === '/api/v1/sessions/bulk');
    expect(bulk?.body).toEqual({ action: 'archive', session_ids: ROWS.map((r) => r.session_id) });
    await screen.findByText('1 selected');
  });

  it('never offers Terminate when only closed sessions are selected', async () => {
    mount('/sessions');
    const table = await screen.findByRole('region', { name: 'Sessions' });
    await act(async () => {
      fireEvent.click(within(table).getByRole('checkbox', { name: 'Select row docs' }));
    });
    await screen.findByText('1 selected');
    expect(screen.queryByRole('button', { name: /Terminate/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete…' })).toBeDefined();
  });

  it('links whole rows to the session and shows calls, errors only when non-zero', async () => {
    mount('/sessions');
    const table = await screen.findByRole('region', { name: 'Sessions' });
    const link = within(table).getAllByRole('link', { name: 'shop' })[0];
    expect(link?.getAttribute('href')).toBe(`/sessions/${ROWS[0]?.session_id}`);
    expect(within(table).getAllByText('12 calls')).toHaveLength(2);
    expect(within(table).getAllByText('1 error')).toHaveLength(2);
    expect(within(table).queryByText('chromium')).toBeNull();
    expect(within(table).queryByText('headless')).toBeNull();
  });

  it('patches rows from session.updated events', async () => {
    const view = mount('/sessions');
    await screen.findByRole('region', { name: 'Sessions' });
    view.connect();
    await act(async () => {
      view.emit('sessions', {
        type: 'session.updated',
        session: sessionSummary(1, { slug: 'renamed' }),
      });
    });
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'renamed' }).length).toBeGreaterThan(0),
    );
  });

  it('collapses to cards below md and keeps the table for wider bands (390 px)', async () => {
    setViewport(390, 844);
    const view = mount('/sessions');
    const cards = await screen.findByRole('list', { name: 'Sessions' });
    expect(cards.className).toContain('md:hidden');
    expect(within(cards).getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Sessions' }).className).toContain('hidden md:block');
    expect(view.container.querySelector('[data-band="card"]')).not.toBeNull();
    setViewport(1280, 800);
  });

  it('formats the header count', () => {
    expect(countText(undefined, 0, false)).toBeUndefined();
    expect(countText(1200, 3, false)).toBe('1,200 sessions · 3 live');
    expect(countText(1, 1, false)).toBe('1 session · 1 live');
    expect(countText(4, 0, true)).toBe('4 archived');
  });
});
