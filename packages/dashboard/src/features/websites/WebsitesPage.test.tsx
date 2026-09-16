/** @module features/websites/WebsitesPage.test — filters in the URL (category chips, domain bar → token, per-row domain filter button, search), whole-row session links, no Public chips, request query mapping, empty-state copy, `/navigation` redirect, axe clean */

import { describe, expect, it } from 'bun:test';
import { createRoute, isRedirect } from '@tanstack/react-router';
import { Route as NavigationRoute } from '@/routes/_auth/navigation.tsx';
import { NOW, pageRow } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { envelope, renderPage } from '../../../test/helpers/page-harness.tsx';
import { fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { websitesSearch } from './search.ts';
import { categoryFacets, WebsitesPage } from './WebsitesPage.tsx';

function mount(url: string, rows = [pageRow(1), pageRow(2, { category: 'ip' })]) {
  return renderPage({
    path: '/websites',
    component: WebsitesPage,
    validateSearch: (s) => websitesSearch.parse(s),
    routes: {
      'GET /pages': (req: { query: URLSearchParams }) =>
        req.query.get('domain') === 'none.test' ? envelope([]) : envelope(rows),
      'GET /pages/domains': {
        data: [
          { domain: 'example1.com', count: 5 },
          { domain: 'example2.com', count: 2 },
        ],
        window: { since: null, until: null },
        now: NOW,
      },
    },
    url,
  });
}

const lastPagesCall = (requests: readonly { path: string; query: URLSearchParams }[]) =>
  requests.filter((r) => r.path === '/api/v1/pages').at(-1);

describe('websites search', () => {
  it('maps defaults, csv categories and top-N', () => {
    expect(websitesSearch.parse({})).toMatchObject({ page: 1, ps: 25, range: '7d', top: 10 });
    expect(websitesSearch.parse({ category: 'ip,bogus,local', top: 7 })).toMatchObject({
      category: ['ip', 'local'],
      top: 10,
    });
  });

  it('never counts the loaded page: no counts without server facets, zero options hidden with them', () => {
    // A response without facets: every category, no numbers (a page of 25 is not the total).
    const noFacets = categoryFacets(envelope([pageRow(1), pageRow(2)]) as never);
    expect(noFacets.counts).toBe(false);
    expect(noFacets.options).toHaveLength(5);
    const server = categoryFacets({ facets: { category: [{ value: 'public', count: 106 }] } }, [
      'local',
    ]);
    expect(server.counts).toBe(true);
    // Zero-count categories are hidden unless selected.
    expect(server.options).toEqual([
      { value: 'public', count: 106 },
      { value: 'local', count: 0 },
    ]);
  });
});

describe('WebsitesPage', () => {
  it('renders history and writes filters to the URL and the request', async () => {
    const view = mount('/websites');
    const table = await screen.findByRole('region', { name: 'Navigation history' });
    expect(within(table).getAllByText('shop').length).toBeGreaterThan(0);
    expect(lastPagesCall(view.requests)?.query.get('sort')).toBe('ts');

    fireEvent.click(screen.getByRole('button', { name: /^IP address/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ category: ['ip'] }),
    );
    await waitFor(() => expect(lastPagesCall(view.requests)?.query.get('category')).toBe('ip'));

    const bars = screen.getByRole('list', { name: 'Domains by visits' });
    fireEvent.click(within(bars).getByRole('button', { name: /example2\.com/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ domain: 'example2.com' }),
    );
    const tokens = screen.getByRole('list', { name: 'Active filters' });
    expect(within(tokens).getByText('example2.com')).toBeTruthy();
    fireEvent.click(
      within(tokens).getByRole('button', { name: 'Remove filter domain example2.com' }),
    );
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('domain'));

    // An explicit per-row domain filter; no "Public" chips.
    fireEvent.click(
      within(table).getAllByRole('button', { name: 'Filter to example1.com' })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ domain: 'example1.com' }),
    );
    expect(within(table).queryByText('Public')).toBeNull();
    expect(
      within(table)
        .getAllByRole('link')
        .some((a) => a.getAttribute('href') === '/sessions/shop-a1b2c3d4'),
    ).toBe(true);
    await expectNoA11yViolations(view.container);
  });

  it('shows the filtered empty state with Clear filters', async () => {
    const view = mount('/websites?domain=none.test');
    await screen.findByText('No navigations match');
    expect(screen.getByText('Try widening the filters or the time range.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(view.router.state.location.search).not.toHaveProperty('domain'));
  });

  it('redirects /navigation to /websites keeping the search', async () => {
    const beforeLoad = NavigationRoute.options.beforeLoad;
    expect(beforeLoad).toBeDefined();
    let thrown: unknown;
    try {
      // @ts-expect-error — only `search` is read by the redirect
      beforeLoad?.({ search: { domain: 'a.com' } });
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);

    const view = renderPage({
      path: '/websites',
      component: WebsitesPage,
      validateSearch: (s) => websitesSearch.parse(s),
      routes: {
        'GET /pages': envelope([pageRow(1)]),
        'GET /pages/domains': { data: [], window: { since: null, until: null }, now: NOW },
      },
      url: '/navigation?domain=example1.com',
      extra: (root) => [
        createRoute({
          getParentRoute: () => root,
          path: '/navigation',
          validateSearch: (s: Record<string, unknown>) => s,
          ...(beforeLoad !== undefined && { beforeLoad }),
          staticData: { title: 'Websites' },
        }),
      ],
    });
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/websites'));
    expect(view.router.state.location.search).toMatchObject({ domain: 'example1.com' });
  });
});
