/** @module features/notifications/api — notification list (cursor-paged, window resolved per request), preferences query + mutation (spec 04 §12.11, spec 03 §4.8) */
import type { Preferences } from '@browserhive/contracts/http';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { useWindowAnchor } from '@/features/overview/api.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';
import { rangeWindow } from '@/lib/search/time-range.ts';
import type { NotificationsSearch } from './search.ts';

/** `GET /notifications` query (without cursor) for the URL search, windowed back from the page's fixed anchor. */
export function notificationsQuery(search: NotificationsSearch, anchor: number) {
  const window = rangeWindow(search.range, anchor);
  return {
    limit: search.ps,
    total: true,
    read: search.read,
    ...(search.type !== undefined && { type: search.type }),
    ...(window.since !== undefined && { since: window.since }),
  } as const;
}

/** The page of notifications for the current search. */
export function useNotificationList(search: NotificationsSearch) {
  const api = useApi();
  const anchor = useWindowAnchor();
  const pager = useCursorPager();
  const query = notificationsQuery(search, anchor);
  const filterKey = JSON.stringify(stableParams(query));
  return useQuery({
    queryKey: keys.notifications.list({ ...query, page: search.page }),
    queryFn: () =>
      pager.resolve(filterKey, search.page, (cursor) =>
        api.listNotifications({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** `GET /me/preferences`. */
export function usePreferences() {
  const api = useApi();
  return useQuery({ queryKey: keys.preferences(), queryFn: () => api.getPreferences() });
}

/** `PUT /me/preferences` (whole document). */
export function useSavePreferences() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (preferences: Preferences) => api.putPreferences({ body: { preferences } }),
    onSuccess: () => toast.success({ title: 'Preferences saved' }),
    onError: (error) => {
      toast.fromError(toAppError(error), 'Preferences not saved');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.preferences() }),
  });
}
