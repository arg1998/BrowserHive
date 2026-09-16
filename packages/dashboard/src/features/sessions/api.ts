/** @module features/sessions/api — queries and mutations for the sessions pages over `useApi()` + `keys.sessions.*` (spec 04 §5, §12.2–12.3) */
import type {
  BulkSessionAction,
  SessionScreenshotsQuery,
  TimelineKind,
} from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';
import { type SessionsSearch, sessionsKeyParams, toSessionsQuery } from './search.ts';

/** Session list for a search + cursor. */
export function useSessionsListQuery(
  search: SessionsSearch,
  cursor: string | undefined,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.list(sessionsKeyParams(search, cursor)),
    queryFn: () => api.listSessions({ query: toSessionsQuery(search, cursor) }),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** Session detail (counts only; sub-collections are separate queries). */
export function useSessionDetailQuery(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.detail(id),
    queryFn: () => api.getSession({ params: { session_id: id } }),
    retry: (count, error) => toAppError(error).status !== 404 && count < 2,
  });
}

/** Timeline facet name for a `kinds` filter (`all` when unfiltered). */
export function timelineFacet(kinds: readonly TimelineKind[] | undefined): string {
  if (kinds === undefined || kinds.length === 0) return 'all';
  return [...kinds].sort().join(',');
}

/** Timeline filters. */
export interface TimelineParams {
  readonly kinds?: readonly TimelineKind[] | undefined;
  readonly errorsOnly?: boolean | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Wire query for a timeline page. */
export function timelineQuery(params: TimelineParams) {
  return {
    ...(params.kinds !== undefined && params.kinds.length > 0 && { kinds: [...params.kinds] }),
    ...(params.errorsOnly === true && { errors_only: true }),
    ...(params.q !== undefined && { q: params.q }),
    ...(params.cursor !== undefined && { cursor: params.cursor }),
    limit: params.limit ?? 100,
  };
}

/** One timeline page. The first (cursor-less) page is what the WS bridge prepends into. */
export function useSessionTimelineQuery(id: string, params: TimelineParams, enabled = true) {
  const api = useApi();
  const keyParams = {
    ...(params.errorsOnly === true && { errors_only: true }),
    ...(params.q !== undefined && { q: params.q }),
    ...(params.cursor !== undefined && { cursor: params.cursor }),
    ...(params.limit !== undefined && { limit: params.limit }),
  };
  return useQuery({
    queryKey: keys.sessions.timeline(id, timelineFacet(params.kinds), keyParams),
    queryFn: () =>
      api.getSessionTimeline({ params: { session_id: id }, query: timelineQuery(params) }),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** One tool call with `args_json` / `result_text` / screenshot. */
export function useToolCallDetailQuery(sessionId: string, eventId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.timeline(sessionId, 'tool-call', { event_id: eventId }),
    queryFn: () => api.getSessionToolCall({ params: { session_id: sessionId, event_id: eventId } }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Pending attention requests of one session (the banner and the takeover gate read this, never `counts`). */
export function useSessionAttentionQuery(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.attention(id),
    queryFn: () =>
      api.listSessionAttention({
        params: { session_id: id },
        query: { status: ['pending'], sort: 'created_at', dir: 'asc', limit: 20 },
      }),
    enabled,
  });
}

/** Screenshots grid page. */
export function useSessionScreenshotsQuery(
  id: string,
  query: z.input<typeof SessionScreenshotsQuery>,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.screenshots(id, stableParams(query)),
    queryFn: () => api.listSessionScreenshots({ params: { session_id: id }, query }),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** How many visits back the screenshot page context reads (the API maximum). */
const PAGE_CONTEXT_LIMIT = 500;

/**
 * Page visits up to the newest screenshot on screen (newest first), so each card can name the page
 * it captured. `until` is the newest capture, so the key is stable while the page of shots is.
 */
export function useScreenshotPageContext(id: string, until: number | undefined) {
  const api = useApi();
  const query = { session_id: id, until: (until ?? 0) + 1, limit: PAGE_CONTEXT_LIMIT } as const;
  return useQuery({
    queryKey: keys.sessions.pageContext(id, { until: query.until }),
    queryFn: () => api.listPages({ query: { ...query, sort: 'ts', dir: 'desc' } }),
    enabled: until !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    select: (page) => page.data,
  });
}

/** Trace descriptor (`command`, `viewer_url`, size). */
export function useSessionTraceQuery(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions.trace(id),
    queryFn: () => api.getSessionTrace({ params: { session_id: id } }),
    enabled,
  });
}

/** Single-session mutations; errors toast, success invalidates the detail and the lists. */
export function useSessionMutations(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const params = { session_id: id } as const;
  const settle = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.sessions.detail(id) }),
      qc.invalidateQueries({ queryKey: keys.sessions.lists() }),
    ]);
  };
  const onError = (error: unknown) => {
    toast.fromError(toAppError(error));
  };
  return {
    terminate: useMutation({
      mutationFn: () => api.terminateSession({ params }),
      onError,
      onSettled: settle,
    }),
    archive: useMutation({
      mutationFn: () => api.archiveSession({ params }),
      onError,
      onSettled: settle,
    }),
    unarchive: useMutation({
      mutationFn: () => api.unarchiveSession({ params }),
      onError,
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: () => api.deleteSession({ params }),
      onError,
      onSuccess: () => {
        qc.removeQueries({ queryKey: keys.sessions.detail(id) });
        qc.removeQueries({ queryKey: keys.sessions.timelines(id) });
        void qc.invalidateQueries({ queryKey: keys.sessions.lists() });
      },
    }),
    setViewport: useMutation({
      mutationFn: (body: { readonly width: number; readonly height: number }) =>
        api.setSessionViewport({ params, body }),
      onError,
    }),
    reveal: useMutation({
      mutationFn: () => api.revealSessionDataDir({ params }),
      onError,
    }),
  };
}

/** Bulk action over ≤ 100 sessions; every call carries a fresh `Idempotency-Key`. */
export function useBulkSessionsMutation() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { readonly action: BulkSessionAction; readonly ids: readonly string[] }) =>
      api.bulkSessions({
        body: { action: input.action, session_ids: [...input.ids] },
        idempotencyKey: crypto.randomUUID(),
      }),
    onError: (error) => {
      toast.fromError(toAppError(error));
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: keys.sessions.all });
    },
  });
}

/** Is the vault enabled on this daemon (`null` until `/system` answered)? Shares the shell's system query. */
export function useVaultEnabled(): boolean | null {
  const api = useApi();
  const system = useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
  return system.data === undefined ? null : system.data.vault.enabled;
}
