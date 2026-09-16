/** @module features/attention/session-link — href + in-app navigation for session deep links (`/sessions/:id`, `/sessions/:id/live`) without a typed `Link`, so the board compiles before the sessions routes land */
import { useRouter } from '@tanstack/react-router';
import type { MouseEvent } from 'react';

/** Session page view. */
export type SessionView = 'detail' | 'live';

/** Path of a session page or its live view. */
export function sessionHref(id: string, view: SessionView = 'detail'): string {
  const base = `/sessions/${encodeURIComponent(id)}`;
  return view === 'live' ? `${base}/live` : base;
}

/** Click handler that navigates in-app (modifier clicks keep the browser default). */
export function useSessionNavigate(): (
  id: string,
  view?: SessionView,
) => (event: MouseEvent<HTMLAnchorElement>) => void {
  const router = useRouter();
  return (id, view = 'detail') =>
    (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
      event.preventDefault();
      void router.navigate({ href: sessionHref(id, view) });
    };
}
