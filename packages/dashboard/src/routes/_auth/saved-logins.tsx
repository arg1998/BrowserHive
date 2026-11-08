/** @module routes/_auth/saved-logins — `/saved-logins` (spec 04 §12.7.1) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { SavedLoginsPage } from '@/features/saved-logins/SavedLoginsPage.tsx';
import { SAVED_LOGINS_DEFAULTS, savedLoginsSearch } from '@/features/saved-logins/search.ts';

/** Saved logins. */
export const Route = createFileRoute('/_auth/saved-logins')({
  component: SavedLoginsPage,
  validateSearch: savedLoginsSearch,
  search: { middlewares: [stripSearchParams(SAVED_LOGINS_DEFAULTS)] },
  staticData: {
    title: 'Saved logins',
    nav: { label: 'Saved logins', icon: 'savedLogins', group: 'primary', order: 58 },
    palette: {
      keywords: ['auth states', 'storage state', 'profile', 'cookies', 'sessions', 'delete'],
    },
  },
});
