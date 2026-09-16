/** @module features/sessions/activity/use-activity-feed — the first timeline page from the query cache (the WS bridge upserts into it) plus older pages appended on demand, reset when the filters change; rows folded by `buildEntries` */
import type { TimelineItem, TimelineKind } from '@browserhive/contracts/http';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { timelineQuery, useSessionTimelineQuery } from '../api.ts';
import { buildEntries, fetchKinds, itemId } from './activity-model.ts';

/** Page size of the activity stream. */
export const ACTIVITY_PAGE = 100;

/** Merge pages keeping the first occurrence of each id (newest first). */
export function mergeTimeline(
  first: readonly TimelineItem[],
  older: readonly TimelineItem[],
): readonly TimelineItem[] {
  const seen = new Set<string>();
  const out: TimelineItem[] = [];
  for (const item of [...first, ...older]) {
    const id = itemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Activity filters. */
export interface ActivityFilters {
  readonly kinds: readonly TimelineKind[] | undefined;
  readonly errorsOnly: boolean;
  readonly q: string | undefined;
}

/** Feed state for the Activity stream. */
export function useActivityFeed(sessionId: string, filters: ActivityFilters) {
  const api = useApi();
  const toast = useToast();
  const kinds = fetchKinds(filters.kinds);
  const params = { kinds, errorsOnly: filters.errorsOnly, q: filters.q, limit: ACTIVITY_PAGE };
  const query = useSessionTimelineQuery(sessionId, params);
  const signature = JSON.stringify([sessionId, kinds, filters.errorsOnly, filters.q]);
  const [older, setOlder] = useState<{
    readonly signature: string;
    readonly items: readonly TimelineItem[];
    readonly cursor: string | null | undefined;
  }>({ signature, items: [], cursor: undefined });
  const current =
    older.signature === signature ? older : { signature, items: [], cursor: undefined };
  const loading = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextCursor =
    current.cursor === undefined ? (query.data?.page.next_cursor ?? null) : current.cursor;

  // `params` is rebuilt every render from the values `signature` already covers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature covers params
  const loadMore = useCallback(async () => {
    if (loading.current || nextCursor === null) return;
    loading.current = true;
    setLoadingMore(true);
    try {
      const page = await api.getSessionTimeline({
        params: { session_id: sessionId },
        query: timelineQuery({ ...params, cursor: nextCursor }),
      });
      setOlder({
        signature,
        items: [...current.items, ...page.data],
        cursor: page.page.next_cursor,
      });
    } catch (error) {
      toast.fromError(toAppError(error), 'Could not load older activity');
    } finally {
      loading.current = false;
      setLoadingMore(false);
    }
  }, [api, sessionId, nextCursor, signature, current.items, toast]);

  // The placeholder of a previous filter must not be folded with this filter's kinds.
  const stale = query.isPlaceholderData;
  const items = useMemo(
    () => mergeTimeline(query.data?.data ?? [], current.items),
    [query.data, current.items],
  );
  const entries = useMemo(() => buildEntries(items, filters.kinds), [items, filters.kinds]);
  return {
    query,
    entries,
    stale,
    hasMore: nextCursor !== null,
    loadMore,
    loadingMore,
  };
}
