/** @module features/websites/api — navigation history (`GET /pages`, cursor-paged) and top domains queries; windows hang off the page's fixed anchor so keys never roll over with the clock (spec 04 §12.5, spec 03 §4.3) */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import {
  type ResolvedWindow,
  useResolvedWindow,
  useTopDomains,
  windowParams,
} from '@/features/overview/api.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';
import { WEBSITES_SORT, type WebsitesSearch } from './search.ts';

/** Build the `GET /pages` query (without cursor) from the URL search. */
export function pagesQuery(search: WebsitesSearch, window: ResolvedWindow) {
  return {
    limit: search.ps,
    total: true,
    dir: search.dir ?? 'desc',
    sort: search.sort === undefined ? ('ts' as const) : WEBSITES_SORT[search.sort],
    ...(search.category !== undefined && { category: search.category }),
    ...(search.session_id !== undefined && { session_id: search.session_id }),
    ...(search.domain !== undefined && { domain: search.domain }),
    ...(search.q !== undefined && { q: search.q }),
    ...windowParams(window),
  } as const;
}

/** Navigation history for the current search (page resolved through the cursor chain). */
export function useWebsitesHistory(search: WebsitesSearch) {
  const api = useApi();
  const window = useResolvedWindow(search.range, search.since, search.until);
  const pager = useCursorPager();
  const query = pagesQuery(search, window);
  const filterKey = JSON.stringify(stableParams(query));
  const history = useQuery({
    queryKey: keys.websites.history({ ...query, page: search.page }),
    queryFn: () =>
      pager.resolve(filterKey, search.page, (cursor) =>
        api.listPages({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: keepPreviousData,
  });
  const domains = useTopDomains(window, search.top);
  return { history, domains, window };
}
