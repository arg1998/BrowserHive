/** @module infra/persistence/analytics-timeline — the merged per-session timeline of `GET /sessions/{id}/timeline` (spec 03 §4.2, spec 13 §11.1): tool calls, pages, attention requests and security intercepts, vault fills, blocked requests and guard hits, each source fetched `limit + 1` with its filters in SQL, merged by `(ts, id)` and paged on that key. */

import type {
  TimelineItem,
  TimelineKind,
  TimelineQuery,
} from '../../ports/persistence/analytics.ts';
import type { Page } from '../../ports/persistence/queries.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import { asNumber, clampLimit, decodeCursor, encodeCursor } from './repositories/common.ts';

const TIMELINE = 'timeline';
const ALL_KINDS: readonly TimelineKind[] = [
  'tool',
  'page',
  'attention',
  'vault',
  'blocked',
  'guard',
];

/** Unique row identity of a timeline item: `<kind>:<event_id | request_id>`. */
export function timelineId(kind: TimelineKind, rowId: string): string {
  return `${kind}:${rowId}`;
}

/** The merged timeline of one session (the caller drained the write queue). */
export async function sessionTimeline(
  repos: Repositories,
  sessionId: string,
  query: TimelineQuery,
): Promise<Page<TimelineItem>> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(TIMELINE, query.cursor);
  const kinds = new Set(
    query.kinds !== undefined && query.kinds.length > 0 ? query.kinds : ALL_KINDS,
  );
  const errorsOnly = query.errorsOnly === true;
  const cursorTs = cursor === null ? undefined : asNumber(cursor.key);
  const until =
    cursorTs === undefined
      ? query.until
      : Math.min(query.until ?? Number.MAX_SAFE_INTEGER, cursorTs);
  const sub = {
    limit: limit + 1,
    sessionId,
    dir: 'desc' as const,
    ...(query.since !== undefined && { since: query.since }),
    ...(until !== undefined && { until }),
    ...(query.q !== undefined && query.q !== '' && { q: query.q }),
  };
  const items: TimelineItem[] = [];
  if (kinds.has('tool')) {
    const page = await repos.toolCalls.listBySession(sessionId, {
      ...sub,
      ...(errorsOnly && { hasError: true }),
    });
    for (const item of page.items)
      items.push({ kind: 'tool', ts: item.ts, id: timelineId('tool', item.eventId), item });
  }
  if (kinds.has('page') && !errorsOnly) {
    const page = await repos.pages.list(sub);
    for (const item of page.items)
      items.push({ kind: 'page', ts: item.ts, id: timelineId('page', item.eventId), item });
  }
  if (kinds.has('attention')) {
    // Security intercepts (site checks, write approvals) are listed beside attention requests.
    const page = await repos.operatorRequests.listHistory({
      ...sub,
      kinds: ['attention', 'security_intercept'],
      ...(errorsOnly && { statuses: ['rejected', 'timeout', 'cancelled'] as const }),
    });
    for (const item of page.items)
      items.push({
        kind: 'attention',
        ts: item.createdAt,
        id: timelineId('attention', item.requestId),
        item,
      });
  }
  if (kinds.has('vault')) {
    const page = await repos.vaultAudit.list({
      ...sub,
      ...(errorsOnly && {
        results: ['origin_mismatch', 'auth_failed', 'blocked', 'denied'] as const,
      }),
    });
    for (const item of page.items)
      items.push({ kind: 'vault', ts: item.ts, id: timelineId('vault', item.eventId), item });
  }
  if (kinds.has('blocked')) {
    const page = await repos.blocklistAudit.list(sub);
    for (const item of page.items)
      items.push({ kind: 'blocked', ts: item.ts, id: timelineId('blocked', item.eventId), item });
  }
  if (kinds.has('guard')) {
    // Filters run in SQL before the `limit + 1` cut, and `until` is inclusive like the other
    // sources, so paging never drops a row (review PR #83 M7).
    const page = await repos.siteGuardHits.list({
      limit: limit + 1,
      sessionId,
      ...(errorsOnly && {
        actions: ['block', 'confirm', 'held'] as const,
        excludeApproved: true,
      }),
      ...(query.q !== undefined && query.q !== '' && { q: query.q }),
      ...((query.since !== undefined || until !== undefined) && {
        window: {
          ...(query.since !== undefined && { since: query.since }),
          ...(until !== undefined && { until }),
        },
      }),
    });
    for (const item of page.items) {
      items.push({ kind: 'guard', ts: item.ts, id: timelineId('guard', item.eventId), item });
    }
  }
  // Ties on `ts` break on the kind-qualified id, so a navigate call and the page row it produced
  // (same event id) stay distinct and keep a stable order across pages.
  items.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const after =
    cursor === null || cursorTs === undefined
      ? items
      : items.filter((i) => i.ts < cursorTs || (i.ts === cursorTs && i.id < cursor.id));
  const slice = after.slice(0, limit);
  const last = after.length > limit ? slice[slice.length - 1] : undefined;
  return {
    items: slice,
    nextCursor: last === undefined ? null : encodeCursor(TIMELINE, { key: last.ts, id: last.id }),
  };
}
