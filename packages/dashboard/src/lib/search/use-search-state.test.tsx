/** @module lib/search/use-search-state.test — the hook returns validated search with defaults, not the raw URL */
import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  stripSearchParams,
} from '@tanstack/react-router';
import { z } from 'zod';
import { render, screen } from '../../../test/helpers/render.tsx';
import { pageParam, TABLE_SEARCH_DEFAULTS } from './table.ts';
import { useSearchState } from './use-search-state.ts';

const schema = z.object({ page: pageParam });

function Probe() {
  const { search } = useSearchState<{ page: number }>();
  return <output aria-label="page">{String(search.page)}</output>;
}

describe('useSearchState', () => {
  it('fills defaults that stripSearchParams removed from the URL (regression: sessions list stuck loading)', async () => {
    const root = createRootRoute({
      component: Probe,
      staticData: { title: 'Test' },
      validateSearch: schema,
      search: { middlewares: [stripSearchParams(TABLE_SEARCH_DEFAULTS)] },
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    expect((await screen.findByLabelText('page')).textContent).toBe('1');
  });

  it('reads an explicit page from the URL', async () => {
    const root = createRootRoute({
      component: Probe,
      staticData: { title: 'Test' },
      validateSearch: schema,
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/?page=3'] }),
    });
    render(<RouterProvider router={router} />);
    expect((await screen.findByLabelText('page')).textContent).toBe('3');
  });
});
