/** @module routes/_auth/sessions — `/sessions` fleet list (spec 04 §12.2) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { SessionsPage } from '@/features/sessions/SessionsPage.tsx';
import { SESSIONS_DEFAULTS, sessionsSearch } from '@/features/sessions/search.ts';

/** Sessions list. */
export const Route = createFileRoute('/_auth/sessions')({
  component: SessionsPage,
  validateSearch: sessionsSearch,
  search: { middlewares: [stripSearchParams(SESSIONS_DEFAULTS)] },
  staticData: {
    title: 'Sessions',
    nav: { label: 'Sessions', icon: 'sessions', group: 'primary', order: 20, key: 's' },
    palette: { keywords: ['browsers', 'fleet', 'leases', 'archive'] },
  },
});
