/** @module features/overview/api — overview queries: activity window, system status, recent pages/sessions, recent failed tool calls, vault fills, top domains (spec 04 §12.1). Windows hang off one per-page anchor, so query keys never roll over with the clock. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { keys } from '@/lib/api/keys.ts';
import { rangeWindow, type TimeRangeValue } from '@/lib/search/time-range.ts';
import { useServerClock } from '@/lib/server-now.ts';

/** A resolved window (`all` → unbounded). */
export interface ResolvedWindow {
  /** The trailing range, or `custom` when the URL carries `since`/`until`. */
  readonly range: TimeRangeValue | 'custom';
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  readonly bucketMs: number;
  readonly label: string;
}

/** How long a page may reuse the shared window anchor on mount before taking a fresh one. */
export const WINDOW_ANCHOR_TTL_MS = 5 * 60_000;

let sharedAnchor: number | null = null;

/** Take (or reuse) the shared anchor at `now`: fresh when absent or older than the TTL. Exported for tests. */
export function takeWindowAnchor(now: number, reset = false): number {
  // An anchor ahead of `now` is stale too: the server clock was corrected backwards (or, in tests,
  // another clock ran later), and a future anchor would push `since` past rows that are in range.
  if (
    reset ||
    sharedAnchor === null ||
    now - sharedAnchor > WINDOW_ANCHOR_TTL_MS ||
    sharedAnchor > now
  ) {
    sharedAnchor = Math.floor(now / 60_000) * 60_000;
  }
  return sharedAnchor;
}

/**
 * The instant trailing windows are measured back from, fixed for the lifetime of the page.
 * Anchoring on the ticking clock re-keyed every windowed query once a minute, which dropped the
 * cached data and flashed skeletons; with a fixed anchor the keys (and `since`) stay put while live
 * rows keep arriving through the bridge (trailing windows send no `until`). Pages mounted within
 * `WINDOW_ANCHOR_TTL_MS` share the anchor, so moving between them hits the cache.
 */
export function useWindowAnchor(): number {
  const clock = useServerClock();
  const [anchor] = useState(() => takeWindowAnchor(clock.now()));
  return anchor;
}

/** Resolve a range/custom bounds against an anchor (trailing ranges send only `since`). */
export function resolveWindow(
  range: TimeRangeValue,
  since: number | undefined,
  until: number | undefined,
  anchor: number,
): ResolvedWindow {
  if (since !== undefined || until !== undefined) {
    return {
      range: 'custom',
      ...(since !== undefined && { since }),
      ...(until !== undefined && { until }),
      bucketMs: bucketFor((until ?? anchor) - (since ?? 0)),
      label: 'custom',
    };
  }
  const trailing = rangeWindow(range, anchor);
  return {
    range,
    ...(trailing.since !== undefined && { since: trailing.since }),
    bucketMs: trailing.bucketMs,
    label: range === 'all' ? 'all time' : range,
  };
}

/** Resolve the URL's range/custom bounds on the page's window anchor. */
export function useResolvedWindow(
  range: TimeRangeValue,
  since: number | undefined,
  until: number | undefined,
): ResolvedWindow {
  const anchor = useWindowAnchor();
  return resolveWindow(range, since, until, anchor);
}

/** Query params of a window. */
export function windowParams(window: ResolvedWindow): {
  readonly since?: number;
  readonly until?: number;
} {
  return {
    ...(window.since !== undefined && { since: window.since }),
    ...(window.until !== undefined && { until: window.until }),
  };
}

/** Pick a bucket so a custom window never exceeds ~168 bars. */
export function bucketFor(spanMs: number): number {
  const target = Math.max(60_000, Math.ceil(spanMs / 168));
  const steps = [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 86_400_000];
  return steps.find((s) => s >= target) ?? 86_400_000;
}

/** Refresh cadence of the activity window when no event invalidates it (bucket edges move). */
export const ACTIVITY_REFRESH_MS = 60_000;

/** Activity buckets + summary for a window. */
export function useActivity(window: ResolvedWindow) {
  const api = useApi();
  const query = { ...windowParams(window), bucket_ms: window.bucketMs };
  return useQuery({
    queryKey: keys.overview.activity(query),
    queryFn: () => api.getActivity({ query }),
    placeholderData: keepPreviousData,
    refetchInterval: ACTIVITY_REFRESH_MS,
  });
}

/** `GET /system` (patched live by the `system` topic through the bridge). */
export function useSystemStatus() {
  const api = useApi();
  return useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
}

/** The 15 most recent navigations (prepended live from `page.visited`). */
export function useRecentPages() {
  const api = useApi();
  return useQuery({
    queryKey: keys.websites.recent(),
    queryFn: () => api.listRecentPages({ query: { limit: 15 } }),
  });
}

/** Five most recently created sessions. */
export function useRecentSessions() {
  const api = useApi();
  const query = { limit: 5, sort: 'created_at', dir: 'desc' } as const;
  return useQuery({
    queryKey: keys.sessions.list(query),
    queryFn: () => api.listSessions({ query }),
  });
}

/** Most recent failed tool calls in the window (Recent failures panel; refetched on `tool.called`). */
export function useRecentFailures(window: ResolvedWindow, limit = 6) {
  const api = useApi();
  // Only calls that ran in a session: every row has somewhere to go.
  const query = {
    ...windowParams(window),
    ok: false,
    has_session: true,
    sort: 'ts',
    dir: 'desc',
    limit,
  } as const;
  return useQuery({
    queryKey: keys.overview.failures(query),
    queryFn: () => api.listToolCalls({ query }),
    placeholderData: keepPreviousData,
  });
}

/** Vault fills in the window (count only; enabled only when the vault is on). */
export function useVaultFills(window: ResolvedWindow, enabled: boolean) {
  const api = useApi();
  const query = { limit: 1, total: true, ...windowParams(window) } as const;
  return useQuery({
    queryKey: keys.vault.log(query),
    queryFn: () => api.listVaultLog({ query }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Top visited domains in the window. */
export function useTopDomains(window: ResolvedWindow, limit: number) {
  const api = useApi();
  const query = { ...windowParams(window), limit };
  return useQuery({
    queryKey: keys.websites.domains(query),
    queryFn: () => api.listPageDomains({ query }),
    placeholderData: keepPreviousData,
  });
}
