/** @module features/sessions/SessionPage.test — the session workspace: header and tabs, one Activity stream (page visits folded into their calls, rows expand inline), the attention banner from the per-session query (not counts) with Take over, the Live toggle (`L`), Details counts linking into Activity, alias link redirects, 404 */

import { describe, expect, it } from 'bun:test';
import { createRoute } from '@tanstack/react-router';
import {
  attentionRequest,
  pageItem,
  sessionDetail,
  sid,
  timelinePage,
  toolCallDetail,
  toolItem,
} from '../../../test/fixtures/sessions.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { sessionLiveRedirectSearch, sessionPageSearch } from './detail-search.ts';
import { redirectLiveRoute, redirectSessionSearchAliases } from './route-redirects.ts';
import { SessionPage } from './SessionPage.tsx';

const ID = sid(1);
const ITEMS = [
  toolItem(1, { ok: false, error_code: 'TIMEOUT', error_message: 'took too long' }),
  toolItem(2),
  pageItem(2),
  toolItem(3, { tool: 'click' }),
];

function mount(url: string, options: { detail?: unknown; pending?: unknown[] } = {}) {
  return renderPage({
    path: '/sessions/$id',
    component: SessionPage,
    validateSearch: (s) => sessionPageSearch.parse(s),
    routes: {
      [`GET /sessions/${ID}`]: options.detail ?? sessionDetail(),
      [`GET /sessions/${ID}/timeline`]: timelinePage(ITEMS),
      [`GET /sessions/${ID}/attention`]: envelope(options.pending ?? []),
      [`GET /sessions/${ID}/tool-calls/${ITEMS[0]?.kind === 'tool' ? ITEMS[0].row.event_id : ''}`]:
        toolCallDetail(1, { ok: false, error_code: 'TIMEOUT', error_message: 'took too long' }),
      'GET /system': { vault: { enabled: false, backend: null } },
    },
    url,
  });
}

describe('SessionPage', () => {
  it('renders the header, the four tabs and one Activity stream with folded navigations; axe clean', async () => {
    const view = mount(`/sessions/${ID}`);
    await screen.findByRole('heading', { level: 1, name: 'shop' });
    const tabs = screen.getByRole('tablist', { name: 'Session sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Activity', 'Screenshots', 'Files & trace', 'Details']);
    const stream = await screen.findByRole('region', { name: 'Activity' });
    const rows = stream.querySelectorAll('[data-activity-row]');
    // Four items, but the page visit of call 2 is folded into it.
    expect(rows.length).toBe(3);
    expect(within(stream).getByText('Example page 2')).toBeDefined();
    expect(within(stream).getByText('TIMEOUT · took too long')).toBeDefined();
    // Destructive actions live in the overflow menu, not beside Live.
    expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull();
    expect(screen.getByRole('button', { name: /Live/ }).getAttribute('aria-pressed')).toBe('false');
    await expectNoA11yViolations(view.container, { disable: ['aria-hidden-focus'] });
  });

  it('expands a row on click into its detail and keeps it in the URL', async () => {
    const view = mount(`/sessions/${ID}`);
    const stream = await screen.findByRole('region', { name: 'Activity' });
    const first = stream.querySelector('[data-activity-row] > div');
    await act(async () => {
      if (first !== null) fireEvent.click(first);
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ open: [ITEMS[0]?.id] }),
    );
    expect(await screen.findByText('Parameters')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy as JSON' })).toBeDefined();
    expect(within(stream).getAllByRole('button', { expanded: true }).length).toBeGreaterThan(0);
  });

  it('sends kind chips, errors-only and search to the server timeline', async () => {
    const view = mount(`/sessions/${ID}`);
    await screen.findByRole('region', { name: 'Activity' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Tools/ }));
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ kinds: ['tool'] }),
    );
    expect(screen.getByRole('button', { name: /^Tools/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Errors/ }));
    });
    await waitFor(() => {
      const last = view.requests.filter((r) => r.path.endsWith('/timeline')).at(-1);
      expect(last?.query.get('kinds')).toBe('page,tool');
      expect(last?.query.get('errors_only')).toBe('true');
    });
  });

  it('shows the attention banner from pending requests even when counts say 0, and Take over opens the live pane armed', async () => {
    const view = mount(`/sessions/${ID}`, { pending: [attentionRequest()] });
    const banner = await screen.findByRole('region', { name: 'Attention request' });
    expect(within(banner).getByText('The agent is asking you to take over')).toBeDefined();
    expect(
      within(banner).getByText('A CAPTCHA blocks the login form. Please solve it.'),
    ).toBeDefined();
    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Take over' }));
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ live: 1, takeover: 1 }),
    );
    expect(await screen.findByRole('region', { name: 'Live view' })).toBeDefined();
  });

  it('offers no Take over for a notify request', async () => {
    mount(`/sessions/${ID}`, { pending: [attentionRequest({ mode: 'notify' })] });
    const banner = await screen.findByRole('region', { name: 'Attention request' });
    expect(within(banner).getByText('The agent is waiting for you')).toBeDefined();
    expect(within(banner).queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Resolve…' })).toBeDefined();
  });

  it('toggles the live pane with L and the Live button', async () => {
    const view = mount(`/sessions/${ID}`);
    await screen.findByRole('region', { name: 'Activity' });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'l' });
    });
    await waitFor(() => expect(view.router.state.location.search).toMatchObject({ live: 1 }));
    expect(await screen.findByRole('region', { name: 'Live view' })).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Live/ }));
    });
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('live'));
  });

  it('opens a closed session from a ?live=1 link with a one-line notice, not an empty pane', async () => {
    const view = mount(`/sessions/${ID}?live=1`, {
      detail: sessionDetail({
        live: false,
        state: 'closed',
        closed_at: 1,
        closed_reason: 'user',
      }),
    });
    expect(await screen.findByText(/No live view: this session has ended/)).toBeDefined();
    expect(screen.getByText(/Closed by the agent/)).toBeDefined();
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('live'));
    expect(screen.queryByRole('region', { name: 'Live view' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByText(/No live view/)).toBeNull();
  });

  it('moves between Activity rows with j/k and expands with Enter', async () => {
    const view = mount(`/sessions/${ID}`);
    const stream = await screen.findByRole('region', { name: 'Activity' });
    const toggles = () => [...stream.querySelectorAll<HTMLButtonElement>('[data-row-toggle]')];
    expect(toggles().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    await act(async () => {
      toggles()[0]?.focus();
      fireEvent.keyDown(toggles()[0] as HTMLElement, { key: 'j' });
    });
    await waitFor(() => expect(document.activeElement).toBe(toggles()[1] as HTMLElement));
    expect(toggles().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    await act(async () => {
      fireEvent.keyDown(toggles()[1] as HTMLElement, { key: 'k' });
    });
    await waitFor(() => expect(document.activeElement).toBe(toggles()[0] as HTMLElement));
    await act(async () => {
      fireEvent.click(toggles()[0] as HTMLElement);
    });
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ open: [ITEMS[0]?.id] }),
    );
  });

  it('links the Details counts into Activity with filters', async () => {
    mount(`/sessions/${ID}?tab=details`);
    const counts = await screen.findByRole('navigation', { name: 'Session counts' });
    const errors = within(counts).getByRole('link', { name: /Errors/ });
    expect(errors.getAttribute('href')).toContain('errors_only=1');
    const tools = within(counts)
      .getByRole('link', { name: /Tool calls/ })
      .getAttribute('href');
    expect(decodeURIComponent(tools ?? '')).toContain('kinds=["tool"]');
    expect(screen.getByText('Identity & coherence')).toBeDefined();
  });

  it('shows a page-level "Session not found" for 404', async () => {
    renderPage({
      path: '/sessions/$id',
      component: SessionPage,
      validateSearch: (s) => sessionPageSearch.parse(s),
      routes: { [`GET /sessions/${ID}`]: problem(404, 'SESSION_NOT_FOUND') },
      url: `/sessions/${ID}`,
    });
    expect(await screen.findByText('Session not found')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to sessions' })).toBeDefined();
  });
});

describe('session link aliases', () => {
  function mountRedirects(url: string) {
    return renderPage({
      path: '/sessions/$id',
      component: SessionPage,
      validateSearch: (s) => sessionPageSearch.parse(s),
      routes: {
        [`GET /sessions/${ID}`]: sessionDetail(),
        [`GET /sessions/${ID}/timeline`]: timelinePage(ITEMS),
        [`GET /sessions/${ID}/attention`]: envelope([]),
      },
      url,
      extra: (root) => [
        createRoute({
          getParentRoute: () => root,
          path: '/sessions/$id/live',
          validateSearch: (s: Record<string, unknown>) => sessionLiveRedirectSearch.parse(s),
          beforeLoad: ({
            params,
            search,
          }: {
            readonly params: { readonly id: string };
            readonly search: { readonly takeover?: 1 | undefined };
          }) => redirectLiveRoute({ params, search }),
          staticData: { title: 'Live view' },
        }),
      ],
    });
  }

  it('redirects /sessions/$id/live to the live pane, keeping takeover', async () => {
    let target: unknown = null;
    try {
      redirectLiveRoute({ params: { id: ID }, search: { takeover: 1 } });
    } catch (redirect) {
      target = redirect;
    }
    expect(JSON.stringify(target)).toContain('"takeover":1');
    const view = mountRedirects(`/sessions/${ID}/live?takeover=1`);
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/sessions/${ID}`));
    // The page consumes `takeover` once it knows no takeover request is open; `live` stays.
    expect(view.router.state.location.search).toMatchObject({ live: 1 });
  });

  it('rewrites an alias tab link into its tab and filters', () => {
    let target: unknown = null;
    try {
      redirectSessionSearchAliases({
        location: { search: { tab: 'tools', ok: '0' } },
        params: { id: ID },
      });
    } catch (redirect) {
      target = redirect;
    }
    expect(JSON.stringify(target)).toContain('"kinds":["tool"]');
    expect(JSON.stringify(target)).toContain('"errors_only":1');
    expect(() =>
      redirectSessionSearchAliases({
        location: { search: { tab: 'details' } },
        params: { id: ID },
      }),
    ).not.toThrow();
  });
});
