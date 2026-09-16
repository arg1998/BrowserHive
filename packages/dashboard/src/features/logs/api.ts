/** @module features/logs/api — the newest page of the ring (`GET /logs`, newest first), older pages and reconnect gap fills by cursor / `after_seq`, system config lookups (trace URL template, current log level) and the log-level mutation (spec 04 §12.9, spec 03 §4.7) */
import type { LogRecord, LogsPage, SystemConfigResponse } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import type { ApiClient } from '@/lib/api/client.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { logsFilters } from './log-filters.ts';
import type { LogsSearch } from './search.ts';

/** Records fetched per page. */
export const LOGS_PAGE_LIMIT = 200;
/** Page size of a reconnect gap fill, and the most pages it walks. */
const GAP_PAGE_LIMIT = 1000;
const GAP_MAX_PAGES = 5;

/**
 * Newest page for the filters. Never cached across filter sets (`gcTime: 0`) so returning to a filter
 * always starts from the live head; refetches after a reconnect merge into the buffer instead of
 * replacing it.
 */
export function useLogsHead(search: LogsSearch) {
  const api = useApi();
  const query = { ...logsFilters(search), limit: LOGS_PAGE_LIMIT, dir: 'desc' as const };
  return useQuery({
    queryKey: keys.logs.list(query),
    queryFn: () => api.listLogs({ query }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** One older page (cursor from the previous page). */
export function fetchOlderLogs(
  api: ApiClient,
  search: LogsSearch,
  cursor: string,
): Promise<LogsPage> {
  return api.listLogs({
    query: { ...logsFilters(search), limit: LOGS_PAGE_LIMIT, dir: 'desc', cursor },
  });
}

/**
 * Everything newer than `afterSeq` (a WS reconnect gap): newest first, following `next_cursor`.
 * `complete` is false when the page walk hit its bound or the ring evicted part of the gap.
 */
export async function fetchLogGap(
  api: ApiClient,
  search: LogsSearch,
  afterSeq: number,
): Promise<{ readonly records: readonly LogRecord[]; readonly complete: boolean }> {
  const records: LogRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < GAP_MAX_PAGES; page += 1) {
    const result = await api.listLogs({
      query: {
        ...logsFilters(search),
        limit: GAP_PAGE_LIMIT,
        dir: 'desc',
        after_seq: afterSeq,
        ...(cursor !== undefined && { cursor }),
      },
    });
    records.push(...result.data);
    cursor = result.page.next_cursor ?? undefined;
    if (cursor === undefined) return { records, complete: true };
  }
  return { records, complete: false };
}

/** `GET /system/config`. */
export function useSystemConfig() {
  const api = useApi();
  return useQuery({ queryKey: keys.system.config(), queryFn: () => api.getSystemConfig() });
}

/** Value of one config key, when present. */
export function configValue(config: SystemConfigResponse | undefined, key: string): unknown {
  return config?.keys.find((k) => k.key === key)?.value;
}

/** `PATCH /system/log-level`. */
export function useSetLogLevel() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: string) => api.setLogLevel({ body: { spec } }),
    onSuccess: (result) => {
      toast.success({
        title: 'Log level updated',
        description: `Now in force: ${result.effective}`,
      });
    },
    onError: (error) => {
      toast.fromError(toAppError(error), 'Log level not changed');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.system.config() }),
  });
}
