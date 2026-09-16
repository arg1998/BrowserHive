/** @module routes/_auth/sessions_.$id — `/sessions/$id` session workspace (tabs in `?tab=`, live pane in `?live=1`); alias tabs and search keys redirect to the canonical form */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { SESSION_PAGE_DEFAULTS, sessionPageSearch } from '@/features/sessions/detail-search.ts';
import { redirectSessionSearchAliases } from '@/features/sessions/route-redirects.ts';
import { SessionPage } from '@/features/sessions/SessionPage.tsx';
import { sessionSlug } from '@/lib/format/ids.ts';

/** Session workspace. */
export const Route = createFileRoute('/_auth/sessions_/$id')({
  component: SessionPage,
  validateSearch: sessionPageSearch,
  search: { middlewares: [stripSearchParams(SESSION_PAGE_DEFAULTS)] },
  beforeLoad: redirectSessionSearchAliases,
  staticData: {
    title: 'Session',
    crumb: (params) => sessionSlug(params['id'] ?? ''),
  },
});
