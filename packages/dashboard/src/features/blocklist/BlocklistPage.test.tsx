/** @module features/blocklist/BlocklistPage.test — reload flow (success toast, failure toast with code), compact not-configured state, pattern ranking/cap, pattern bar filter, live `blocklist.hit` prepend, axe clean */

import { describe, expect, it } from 'bun:test';
import { blockedRow, blocklistOverview, NOW } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, problem, renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { BlocklistPage } from './BlocklistPage.tsx';
import { PATTERNS_CAP, patternTitle, rankPatterns } from './components/PatternsCard.tsx';
import { blocklistSearch } from './search.ts';

function mount(options: { reloadFails?: boolean; configured?: boolean } = {}) {
  let reloads = 0;
  const server = { rows: options.configured === false ? [] : [blockedRow(1)] };
  const view = renderPage({
    path: '/blocklist',
    component: BlocklistPage,
    validateSearch: (s) => blocklistSearch.parse(s),
    routes: {
      'GET /blocklist': blocklistOverview(
        options.configured === false
          ? {
              configured: false,
              path: null,
              patterns: [],
              stats: {
                attempts: 0,
                sessions: 0,
                domains: 0,
                total_all_time: 0,
                top_patterns: [],
                top_domains: [],
              },
            }
          : {},
      ),
      'GET /blocklist/attempts': () => envelope(server.rows),
      'POST /blocklist/reload': () => {
        reloads += 1;
        return options.reloadFails === true
          ? problem(400, 'BLOCKLIST_LOAD_FAILED', 'Blocklist could not be loaded')
          : { ok: true, patterns: 3, skipped: 1, loaded_at: NOW };
      },
    },
    url: '/blocklist',
  });
  return { ...view, server, reloads: () => reloads };
}

describe('blocklist helpers', () => {
  it('ranks patterns by hits then file order, capped at ten on screen', () => {
    const ranked = rankPatterns([
      { pattern: 'a', hits: 0, line: 1 },
      { pattern: 'b', hits: 5, line: 2 },
      { pattern: 'c', hits: 5, line: 3 },
      { pattern: 'd', hits: 9, line: 4 },
    ]);
    expect(ranked.map((p) => p.pattern)).toEqual(['d', 'b', 'c', 'a']);
    expect(PATTERNS_CAP).toBe(10);
  });

  it('explains never-fired patterns in the row tooltip', () => {
    expect(patternTitle(0, 7, null, NOW)).toBe(
      'Line 7 — never matched in this window. If you expected it to, check the pattern shape.',
    );
    expect(patternTitle(4, 1, NOW - 120_000, NOW)).toBe(
      '4 refused · last 2m ago — click to filter',
    );
  });
});

describe('BlocklistPage', () => {
  it('reloads the blocklist and toasts the result', async () => {
    const view = mount();
    await screen.findByText('Patterns loaded');
    const reload = screen.getByRole('button', { name: 'Reload blocklist' });
    await waitFor(() => expect((reload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reload);
    expect((await screen.findAllByText('Blocklist reloaded')).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText('3 patterns loaded, 1 line skipped.')).length,
    ).toBeGreaterThan(0);
    expect(view.reloads()).toBe(1);
    await expectNoA11yViolations(view.container);
  });

  it('shows an error toast with the code when the reload fails', async () => {
    const view = mount({ reloadFails: true });
    const reload = await screen.findByRole('button', { name: 'Reload blocklist' });
    await waitFor(() => expect((reload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reload);
    expect((await screen.findAllByText('Blocklist not reloaded')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('BLOCKLIST_LOAD_FAILED')).length).toBeGreaterThan(0);
    expect(view.reloads()).toBe(1);
  });

  it('shows one compact not-configured state with a website docs link, and a disabled reload', async () => {
    const view = mount({ configured: false });
    await screen.findByText('No blocklist is configured');
    expect(screen.getByRole('link', { name: 'Read the docs' }).getAttribute('href')).toBe(
      'https://browserhive.ai/docs/guide/quick-start/#blocklist-file-format',
    );
    expect(screen.queryByText('Patterns loaded')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Blocked attempts' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Time range' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Reload blocklist' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await expectNoA11yViolations(view.container);
  });

  it('toggles the pattern filter from the patterns card and prepends live hits', async () => {
    const view = mount();
    const patterns = await screen.findByRole('list', { name: 'Patterns by hits' });
    fireEvent.click(within(patterns).getByRole('button', { name: /ads\.example\.com/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ pattern: 'ads.example.com' }),
    );
    await waitFor(() =>
      expect(
        view.requests.some(
          (r) =>
            r.path === '/api/v1/blocklist/attempts' && r.query.get('pattern') === 'ads.example.com',
        ),
      ).toBe(true),
    );
    fireEvent.click(within(patterns).getByRole('button', { name: /ads\.example\.com/ }));
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('pattern'));

    await waitFor(() => expect(view.sockets.length).toBe(1));
    const region = await screen.findByRole('region', { name: 'Blocked attempts' });
    const before = within(region).getAllByRole('row').length;
    // Trailing windows are open-ended, so the hit lands inside the window and is prepended in place.
    const hit = { ...blockedRow(9), ts: NOW + 10 };
    const fetchesBefore = view.requests.length;
    act(() => {
      view.connect();
      view.emit('blocklist', { type: 'blocklist.hit', row: hit });
    });
    await waitFor(() => expect(within(region).getAllByRole('row').length).toBe(before + 1));
    expect(
      view.requests.slice(fetchesBefore).some((r) => r.path === '/api/v1/blocklist/attempts'),
    ).toBe(false);
  });
});
