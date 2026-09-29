/** @module features/notifications/reports/api — the reports history (cursor-paged, window resolved per request), one report, and the in-app report settings query + mutation (spec 03 §4.8, D-45) */
import type { ReportSettings } from '@browserhive/contracts/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { useWindowAnchor } from '@/features/overview/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';
import { rangeWindow } from '@/lib/search/time-range.ts';
import type { ReportsSearch } from './search.ts';

/** `GET /notifications/reports` query (without cursor) for the URL search. */
export function reportsQuery(search: ReportsSearch, anchor: number) {
  const window = rangeWindow(search.range, anchor);
  return {
    limit: search.ps,
    total: true,
    ...(search.kind !== undefined && { kind: search.kind }),
    ...(search.channel !== undefined && { channel: search.channel }),
    ...(window.since !== undefined && { since: window.since }),
  } as const;
}

/** The page of reports for the current search. */
export function useReportList(search: ReportsSearch) {
  const api = useApi();
  const anchor = useWindowAnchor();
  const pager = useCursorPager();
  const query = reportsQuery(search, anchor);
  const filterKey = JSON.stringify(stableParams(query));
  return useQuery({
    queryKey: keys.notifications.reports({ ...query, page: search.page }),
    queryFn: () =>
      pager.resolve(filterKey, search.page, (cursor) =>
        api.listReports({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** One report. */
export function useReport(notificationId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.notifications.report(notificationId),
    queryFn: () => api.getReport({ params: { notification_id: notificationId as never } }),
  });
}

/** `GET /notifications/report-settings`. */
export function useReportSettings() {
  const api = useApi();
  return useQuery({
    queryKey: keys.notifications.reportSettings(),
    queryFn: () => api.getReportSettings(),
  });
}

/** `PUT /notifications/report-settings`. */
export function useSaveReportSettings() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: ReportSettings) => api.putReportSettings({ body: { settings } }),
    onSuccess: (data) => {
      queryClient.setQueryData(keys.notifications.reportSettings(), data);
      toast.success({ title: 'Reports in BrowserHive saved' });
    },
    onError: (error) => {
      toast.fromError(toAppError(error), 'Reports settings not saved');
    },
  });
}
