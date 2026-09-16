/** @module routes/index — `/` redirects to `/overview` */
import { createFileRoute, redirect } from '@tanstack/react-router';

/** Redirect. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/overview' });
  },
  staticData: { title: 'BrowserHive' },
});
