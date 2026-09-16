/** @module routes/_auth/sessions_.$id_.live — `/sessions/$id/live` alias route: redirects to the session workspace with the live pane open (`?live=1`, keeping `takeover`) so shared links keep working */
import { createFileRoute } from '@tanstack/react-router';
import { sessionLiveRedirectSearch } from '@/features/sessions/detail-search.ts';
import { redirectLiveRoute } from '@/features/sessions/route-redirects.ts';

/** Live view (redirect). */
export const Route = createFileRoute('/_auth/sessions_/$id_/live')({
  validateSearch: sessionLiveRedirectSearch,
  beforeLoad: redirectLiveRoute,
  staticData: { title: 'Live view' },
});
