/** @module features/sessions/route-redirects — `beforeLoad` guards of the session routes: alias search params (`?tab=tools&ok=0`) and the `/sessions/$id/live` alias route redirect to the canonical form, so shared links keep working; they land on the session workspace with the matching tab, filters or live pane */
import { redirect } from '@tanstack/react-router';
import type { z } from 'zod';
import { normalizeSessionSearchAliases, type sessionPageSearch } from './detail-search.ts';

/** `/sessions/$id`: redirect when the raw URL search uses an alias tab or key. */
export function redirectSessionSearchAliases({
  location,
  params,
}: {
  readonly location: { readonly search: unknown };
  readonly params: { readonly id: string };
}): void {
  // `location.search` is the raw URL search (before validation).
  const canonical = normalizeSessionSearchAliases(location.search as Record<string, unknown>);
  if (canonical === null) return;
  throw redirect({
    to: '/sessions/$id',
    params: { id: params.id },
    search: canonical as z.input<typeof sessionPageSearch>,
    replace: true,
  });
}

/** `/sessions/$id/live`: the live view is a pane of the session page (`?live=1`, keeping `takeover`). */
export function redirectLiveRoute({
  params,
  search,
}: {
  readonly params: { readonly id: string };
  readonly search: { readonly takeover?: 1 | undefined };
}): never {
  throw redirect({
    to: '/sessions/$id',
    params: { id: params.id },
    search: { live: 1, ...(search.takeover !== undefined && { takeover: search.takeover }) },
    replace: true,
  });
}
