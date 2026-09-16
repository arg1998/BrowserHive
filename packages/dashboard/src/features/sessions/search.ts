/** @module features/sessions/search — `/sessions` search params (table schema + view/owner/channel/persistence/since/until/archived; selection is local, never in the URL) and the mapping onto the REST query (spec 04 §12.2) */
import { Channel, PersistenceMode } from '@browserhive/contracts/enums';
import type { SessionsQuery } from '@browserhive/contracts/http';
import { z } from 'zod';
import {
  csvParam,
  TABLE_SEARCH_DEFAULTS,
  type TableSearch,
  tableSearchSchema,
} from '@/lib/search/table.ts';

/** Sort keys shown in the table (every displayed column). */
export const SESSION_SORT_KEYS = [
  'created',
  'slug',
  'channel',
  'activity',
  'errors',
  'lease',
  'owner',
  'persistence',
  'closed',
  'blocked',
] as const;
/** Sort key. */
export type SessionSortKey = (typeof SESSION_SORT_KEYS)[number];

/** URL sort key → server sort key (spec 03 §4.2). */
export const SORT_KEY_TO_API: { readonly [K in SessionSortKey]: SessionsQuery['sort'] } = {
  created: 'created_at',
  slug: 'slug',
  channel: 'channel',
  activity: 'last_activity_at',
  errors: 'errors',
  lease: 'lease_expires_at',
  owner: 'owner',
  persistence: 'persistence_mode',
  closed: 'closed_at',
  blocked: 'blocked',
};

/** View presets; absent = all (non-archived). */
export const SessionViewParam = z.enum(['live', 'closed', 'archived']);

const epochParam = z.coerce.number().int().nonnegative().optional().catch(undefined);

/** Search schema. */
export const sessionsSearch = tableSearchSchema(SESSION_SORT_KEYS).extend({
  view: SessionViewParam.optional().catch(undefined),
  owner: z.string().trim().min(1).max(128).optional().catch(undefined),
  channel: csvParam(Channel),
  persistence: csvParam(PersistenceMode),
  since: epochParam,
  until: epochParam,
  archived: z.enum(['include']).optional().catch(undefined),
});
/** Parsed search. */
export type SessionsSearch = z.infer<typeof sessionsSearch>;
/** Defaults omitted from the URL. */
export const SESSIONS_DEFAULTS = TABLE_SEARCH_DEFAULTS;

/** Keys that count as active filters (drive "Clear all" and the zero-results state). */
export const SESSION_FILTER_KEYS = [
  'q',
  'view',
  'owner',
  'channel',
  'persistence',
  'since',
  'until',
  'archived',
] as const;

/** `true` when any filter is active. */
export function hasSessionFilters(search: SessionsSearch): boolean {
  return SESSION_FILTER_KEYS.some((key) => search[key] !== undefined);
}

/** The REST query for a search (`cursor` comes from the page chain, `total` is always requested). */
export function toSessionsQuery(
  search: SessionsSearch & TableSearch,
  cursor: string | undefined,
): z.input<typeof SessionsQuery> {
  const sort =
    search.sort !== undefined ? SORT_KEY_TO_API[search.sort as SessionSortKey] : undefined;
  return {
    limit: search.ps,
    total: true,
    ...(cursor !== undefined && { cursor }),
    ...(sort !== undefined && { sort }),
    ...(search.dir !== undefined && { dir: search.dir }),
    ...(search.q !== undefined && { q: search.q }),
    ...(search.view !== undefined && { view: search.view }),
    ...(search.archived !== undefined && { archived: 'include' as const }),
    ...(search.owner !== undefined && { owner: search.owner }),
    ...(search.channel !== undefined && { channel: search.channel }),
    ...(search.persistence !== undefined && { persistence_mode: search.persistence }),
    ...(search.since !== undefined && { since: search.since }),
    ...(search.until !== undefined && { until: search.until }),
  };
}

/** Cache-key params: the URL search with defaults dropped, so the WS bridge can recognise the clean first page. */
export function sessionsKeyParams(
  search: SessionsSearch,
  cursor: string | undefined,
): Record<string, unknown> {
  const rest = search;
  return {
    ...rest,
    ...(cursor !== undefined && { cursor }),
    ...(rest.page === 1 && { page: undefined }),
    ...(rest.ps === SESSIONS_DEFAULTS.ps && { ps: undefined }),
  };
}
