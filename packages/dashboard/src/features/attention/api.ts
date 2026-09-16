/** @module features/attention/api — attention queries (pending board, settled history) and the optimistic resolve/reject + bulk mutations (spec 04 §12.4, §11) */
import type {
  AttentionDecision,
  AttentionQuery,
  OperatorRequestRow,
} from '@browserhive/contracts/http';
import {
  keepPreviousData,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import type { CursorPager } from '@/components/shared/use-cursor-pages.ts';
import { useWindowAnchor } from '@/features/overview/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { rangeWindow } from '@/lib/search/time-range.ts';
import { patchRow, removeRow } from '@/lib/ws/bridge.ts';
import { type AttentionSearch, SETTLED_STATUSES, WIRE_SORT } from './search.ts';

/** Most open requests the board renders (the queue is bounded server-side). */
export const BOARD_LIMIT = 100;

/** Open attention requests (oldest first). The bridge upserts/removes rows from `attention.*` events. */
export function useAttentionPending() {
  const api = useApi();
  return useQuery({
    queryKey: keys.attention.pending(),
    queryFn: () =>
      api.listAttention({
        query: { status: ['pending'], sort: 'created_at', dir: 'asc', limit: BOARD_LIMIT },
      }),
  });
}

/** Wire query as sent (contracts `z.input`, so branded ids accept plain strings). */
export type HistoryQuery = z.input<typeof AttentionQuery>;

/**
 * Wire query for the history table. Trailing windows are measured back from the page's fixed
 * anchor and send no `until`, so the key never rolls over and newly settled requests stay inside.
 */
export function historyQuery(search: AttentionSearch, anchor: number): HistoryQuery {
  const custom = search.since !== undefined || search.until !== undefined;
  const window: { readonly since?: number } = custom ? {} : rangeWindow(search.range, anchor);
  return {
    status: search.status ?? [...SETTLED_STATUSES],
    sort: WIRE_SORT[search.sort ?? 'created'],
    dir: search.dir ?? 'desc',
    limit: search.ps,
    total: true,
    ...(search.mode !== undefined && { mode: search.mode }),
    ...(search.session !== undefined && { session_id: search.session }),
    ...(search.q !== undefined && { q: search.q }),
    ...(custom
      ? {
          ...(search.since !== undefined && { since: search.since }),
          ...(search.until !== undefined && { until: search.until }),
        }
      : { ...(window.since !== undefined && { since: window.since }) }),
  };
}

/** Settled requests page for the current search (URL `page` walked onto keyset cursors). */
export function useAttentionHistory(search: AttentionSearch, pager: CursorPager) {
  const api = useApi();
  const anchor = useWindowAnchor();
  const query = historyQuery(search, anchor);
  const params = { ...query, page: search.page };
  return useQuery({
    queryKey: keys.attention.list(params),
    queryFn: () =>
      pager.resolve(JSON.stringify(query), search.page, (cursor) =>
        api.listAttention({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** Resolve/reject input. */
export interface ResolveInput {
  readonly requestId: OperatorRequestRow['request_id'];
  readonly decision: AttentionDecision;
  readonly message?: string;
  /** The request's session, so its banner and counts refresh too (session page). */
  readonly sessionId?: string;
}

type Snapshot = readonly (readonly [QueryKey, unknown])[];

function restore(qc: ReturnType<typeof useQueryClient>, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}

function bumpCount(qc: ReturnType<typeof useQueryClient>, key: QueryKey, delta: number): void {
  const current = qc.getQueryData(key);
  if (typeof current === 'number') qc.setQueryData(key, Math.max(0, current + delta));
}

/** Toast description echoing the message that went back to the agent. */
export function sentMessageDescription(message: string | undefined): string | undefined {
  const trimmed = message?.trim() ?? '';
  if (trimmed === '') return undefined;
  return `Message sent: “${trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed}”`;
}

/** `false` only when the operator turned toasts off in `/me/preferences`. */
export function useToastsAllowed(): boolean {
  const api = useApi();
  const query = useQuery({ queryKey: keys.preferences(), queryFn: () => api.getPreferences() });
  return query.data?.preferences.notifications?.toasts !== false;
}

/**
 * Optimistic resolve/reject, shared by the Attention board and the session banner: the request
 * leaves the board (and the session's banner) and the open count drops immediately; success toasts
 * the decision plus the message the agent received (unless toasts are off); a failure restores the
 * snapshot and raises an error toast with the code (spec 04 §11).
 */
export function useResolveAttention() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const toastsAllowed = useToastsAllowed();
  return useMutation({
    mutationFn: ({ requestId, decision, message }: ResolveInput) =>
      api.resolveAttention({
        params: { request_id: requestId },
        body: { decision, ...(message !== undefined && message.trim() !== '' && { message }) },
      }),
    onMutate: async ({ requestId, decision, message, sessionId }) => {
      await qc.cancelQueries({ queryKey: keys.attention.all });
      const snapshot: Snapshot = [
        ...qc.getQueriesData({ queryKey: keys.attention.all }),
        ...(sessionId !== undefined
          ? qc.getQueriesData({ queryKey: keys.sessions.attention(sessionId) })
          : []),
      ];
      removeRow(qc, keys.attention.pending(), 'request_id', requestId);
      if (sessionId !== undefined) {
        removeRow(qc, keys.sessions.attention(sessionId), 'request_id', requestId);
      }
      patchRow(qc, keys.attention.lists(), 'request_id', requestId, {
        status: decision === 'resolve' ? 'resolved' : 'rejected',
        message: message ?? null,
      });
      bumpCount(qc, keys.attention.openCount(), -1);
      return { snapshot };
    },
    onSuccess: (_result, { decision, message }) => {
      if (!toastsAllowed) return;
      const description = sentMessageDescription(message);
      toast.success({
        title: decision === 'resolve' ? 'Request resolved' : 'Request rejected',
        ...(description !== undefined && { description }),
      });
    },
    onError: (error, _input, context) => {
      if (context !== undefined) restore(qc, context.snapshot);
      toast.fromError(toAppError(error), 'Could not settle the request');
    },
    onSettled: async (_result, _error, { sessionId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.attention.all }),
        ...(sessionId !== undefined
          ? [
              qc.invalidateQueries({ queryKey: keys.sessions.attention(sessionId) }),
              qc.invalidateQueries({ queryKey: keys.sessions.detail(sessionId) }),
            ]
          : []),
      ]);
    },
  });
}

/** Bulk resolve/reject; the result toast names ok/failed counts (never a single "done"). */
export function useBulkAttention() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: {
      readonly action: AttentionDecision;
      readonly requestIds: readonly OperatorRequestRow['request_id'][];
      readonly message?: string;
    }) =>
      api.bulkAttention({
        body: {
          action: input.action,
          request_ids: [...input.requestIds],
          ...(input.message !== undefined && input.message !== '' && { message: input.message }),
        },
        idempotencyKey: globalThis.crypto.randomUUID(),
      }),
    onSuccess: (result, input) => {
      const verb = input.action === 'resolve' ? 'resolved' : 'rejected';
      const title = `${result.ok_count} ${verb}${result.error_count > 0 ? `, ${result.error_count} failed` : ''}`;
      if (result.error_count > 0) {
        const first = result.results.find((r) => !r.ok);
        toast.warning({
          title,
          ...(first?.error !== undefined && {
            description: `${first.request_id}: ${first.error.title}`,
          }),
        });
      } else {
        toast.success({ title });
      }
    },
    onError: (error) => toast.fromError(toAppError(error), 'Bulk action failed'),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.attention.all }),
  });
}
