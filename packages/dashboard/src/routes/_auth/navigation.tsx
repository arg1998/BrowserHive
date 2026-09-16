/** @module routes/_auth/navigation — `/navigation` alias route: redirects to `/websites` with its search, so shared links keep working (spec 04 §12.5) */
import { createFileRoute, redirect } from '@tanstack/react-router';

/** Redirect. */
export const Route = createFileRoute('/_auth/navigation')({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/websites', search, replace: true });
  },
  component: () => null,
  staticData: { title: 'Websites' },
});
