/** @module contracts/http/timeline — merged per-session timeline (spec 03 §4.2) */
import { z } from 'zod';
import { OperatorRequestRow } from './attention.ts';
import { BlockedRequestRow } from './blocklist.ts';
import { Cursor, csv, EpochMs, limitQuery, page, QueryBool, QueryText } from './common.ts';
import { PageRow } from './pages.ts';
import { TimelineKind } from './session-actions.ts';
import { ToolCallRow } from './tool-calls.ts';
import { VaultAccessRow } from './vault-bindings.ts';

const base = {
  /**
   * Unique, stable row identity: `<kind>:<row id>` where the row id is `row.event_id` (tool, page,
   * vault, blocked) or `row.request_id` (attention). A navigate call and the page row it produced
   * share an `event_id` but never an `id`. Live feed events map to the same value.
   */
  id: z.string(),
  ts: EpochMs,
  seq: z.number().int().nonnegative(),
} as const;

/** One merged timeline item, discriminated on `kind`; ordered by `(ts, id)` desc. */
export const TimelineItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), ...base, row: ToolCallRow }),
  z.object({ kind: z.literal('page'), ...base, row: PageRow }),
  z.object({ kind: z.literal('attention'), ...base, row: OperatorRequestRow }),
  z.object({ kind: z.literal('vault'), ...base, row: VaultAccessRow }),
  z.object({ kind: z.literal('blocked'), ...base, row: BlockedRequestRow }),
]);
/** One merged timeline item. */
export type TimelineItem = z.infer<typeof TimelineItem>;

/**
 * `GET /sessions/{session_id}/timeline` query.
 *
 * - `kinds`: subset of `tool|page|attention|vault|blocked` (default all).
 * - `errors_only`: tool calls with an `error_code`, attention ended `rejected|timeout|cancelled`,
 *   vault fills other than `success`, every blocked request; no pages.
 * - `q`: free text per kind — tool (tool, error_code, error_message, tab_id), page (url, title),
 *   attention (reason, session_id), vault (entry_name, page_url, session_id), blocked (url, pattern).
 */
export const TimelineQuery = z.strictObject({
  kinds: csv(TimelineKind),
  errors_only: QueryBool.default(false),
  q: QueryText.optional(),
  cursor: Cursor.optional(),
  limit: limitQuery(),
});
/** `GET /sessions/{session_id}/timeline` query. */
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/** `GET /sessions/{session_id}/timeline` body. */
export const TimelinePage = page(TimelineItem);
/** `GET /sessions/{session_id}/timeline` body. */
export type TimelinePage = z.infer<typeof TimelinePage>;
