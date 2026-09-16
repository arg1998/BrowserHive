/** @module features/attention/search — `/attention` search params: history filters (mode, status, session, window), sort `created|resolved|waited`, cursor paging (spec 04 §12.4) */
import { AttentionMode, OperatorRequestStatus } from '@browserhive/contracts/enums';
import { SESSION_ID_RE } from '@browserhive/contracts/ids';
import { z } from 'zod';
import { csvParam, tableSearchSchema } from '@/lib/search/table.ts';
import { rangeParam } from '@/lib/search/time-range.ts';

/** Sort keys shown in the history table (mapped to the wire keys in `api.ts`). */
export const ATTENTION_SORT_KEYS = ['created', 'resolved', 'waited'] as const;
/** History sort key. */
export type AttentionSortKey = (typeof ATTENTION_SORT_KEYS)[number];

/** Terminal statuses the history table can filter on. */
export const SETTLED_STATUSES = ['resolved', 'rejected', 'timeout', 'cancelled'] as const;

const epochParam = z.coerce.number().int().nonnegative().optional().catch(undefined);
const sessionParam = z.string().regex(SESSION_ID_RE).optional().catch(undefined);

/** Search schema (`page` is walked onto keyset cursors by `useCursorPager`). */
export const attentionSearch = tableSearchSchema(ATTENTION_SORT_KEYS).extend({
  mode: csvParam(AttentionMode),
  status: csvParam(OperatorRequestStatus),
  session: sessionParam,
  range: rangeParam,
  since: epochParam,
  until: epochParam,
});
/** Parsed search. */
export type AttentionSearch = z.infer<typeof attentionSearch>;
/** Defaults omitted from the URL. */
export const ATTENTION_DEFAULTS = { page: 1, ps: 25, range: '7d' } as const;

/** Wire sort key for a table sort key. */
export const WIRE_SORT: {
  readonly [K in AttentionSortKey]: 'created_at' | 'resolved_at' | 'waited_ms';
} = {
  created: 'created_at',
  resolved: 'resolved_at',
  waited: 'waited_ms',
};

/** `true` when any history filter (not paging/sort) is active. */
export function hasHistoryFilters(search: AttentionSearch): boolean {
  return (
    search.q !== undefined ||
    search.mode !== undefined ||
    search.status !== undefined ||
    search.session !== undefined ||
    search.since !== undefined ||
    search.until !== undefined ||
    search.range !== ATTENTION_DEFAULTS.range
  );
}
