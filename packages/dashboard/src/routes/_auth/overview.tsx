/** @module routes/_auth/overview — `/overview` (spec 04 §12.1) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { OverviewPage } from '@/features/overview/OverviewPage.tsx';
import { OVERVIEW_DEFAULTS, overviewSearch } from '@/features/overview/search.ts';

/** Overview. */
export const Route = createFileRoute('/_auth/overview')({
  component: OverviewPage,
  validateSearch: overviewSearch,
  search: { middlewares: [stripSearchParams(OVERVIEW_DEFAULTS)] },
  staticData: {
    title: 'Overview',
    nav: { label: 'Overview', icon: 'overview', group: 'primary', order: 10, key: 'o' },
    palette: { keywords: ['dashboard', 'home', 'fleet'] },
  },
});
