/** @module features/blocklist/api — blocklist overview (`GET /blocklist`), attempts (cursor-paged) and the reload mutation with its result toast (spec 04 §12.6, spec 03 §4.6) */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { type ResolvedWindow, useResolvedWindow, windowParams } from '@/features/overview/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { BLOCKLIST_SORT, type BlocklistSearch } from './search.ts';

/** Build the `GET /blocklist/attempts` query (without cursor) from the URL search. */
export function attemptsQuery(search: BlocklistSearch, window: ResolvedWindow) {
  return {
    limit: search.ps,
    total: true,
    dir: search.dir ?? 'desc',
    sort: search.sort === undefined ? ('ts' as const) : BLOCKLIST_SORT[search.sort],
    ...(search.source !== undefined && { source: search.source }),
    ...(search.pattern !== undefined && { pattern: search.pattern }),
    ...(search.domain !== undefined && { domain: search.domain }),
    ...(search.session_id !== undefined && { session_id: search.session_id }),
    ...(search.q !== undefined && { q: search.q }),
    ...windowParams(window),
  } as const;
}

/** Overview + attempts for the current search. */
export function useBlocklist(search: BlocklistSearch) {
  const api = useApi();
  const window = useResolvedWindow(search.range, search.since, search.until);
  const pager = useCursorPager();
  const stateQuery = windowParams(window);
  const state = useQuery({
    queryKey: keys.blocklist.state(stateQuery),
    queryFn: () => api.getBlocklist({ query: stateQuery }),
    placeholderData: keepPreviousData,
  });
  const query = attemptsQuery(search, window);
  const filterKey = JSON.stringify(stableParams(query));
  const attempts = useQuery({
    queryKey: keys.blocklist.attempts({ ...query, page: search.page }),
    queryFn: () =>
      pager.resolve(filterKey, search.page, (cursor) =>
        api.listBlockedAttempts({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: keepPreviousData,
  });
  return { state, attempts, window };
}

/** `POST /blocklist/reload` with the result toast (spec 04 §12.6). */
export function useReloadBlocklist() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.reloadBlocklist(),
    onSuccess: (result) => {
      toast.success({
        title: 'Blocklist reloaded',
        description: `${formatNumber(result.patterns)} pattern${result.patterns === 1 ? '' : 's'} loaded${
          result.skipped > 0
            ? `, ${formatNumber(result.skipped)} line${result.skipped === 1 ? '' : 's'} skipped`
            : ''
        }.`,
      });
    },
    onError: (error) => {
      toast.fromError(toAppError(error), 'Blocklist not reloaded');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.blocklist.all }),
  });
}
