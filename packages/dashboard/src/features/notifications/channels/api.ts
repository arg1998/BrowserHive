/** @module features/notifications/channels/api — notification channel queries and mutations over `/channels` (list, detail, create/update/delete, pause/resume, test, preview, env check, Telegram connect, delivery log) and `GET /system/public-url`; the `channels` WS topic patches the caches through the bridge (spec 03 §4.8.1, spec 04 §12.11.1) */
import type {
  ChannelInput,
  ChannelPatch,
  ChannelPreviewRequest,
  ChannelView,
} from '@browserhive/contracts/http';
import type { PreviewSample } from '@browserhive/contracts/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { keys, stableParams } from '@/lib/api/keys.ts';

/** `GET /channels`. */
export function useChannels() {
  const api = useApi();
  return useQuery({ queryKey: keys.channels.list(), queryFn: () => api.listChannels() });
}

/** `GET /channels/{id}` (disabled without an id). */
export function useChannel(channelId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channels.detail(channelId ?? ''),
    queryFn: () => api.getChannel({ params: { channel_id: channelId ?? '' } }),
    enabled: channelId !== null,
  });
}

/** Replace one channel in the list and detail caches (mutation results, WS events). */
export function patchChannelCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  channel: ChannelView,
): void {
  queryClient.setQueryData(keys.channels.detail(channel.channel_id), { channel });
  queryClient.setQueryData<{ data: ChannelView[]; now: number } | undefined>(
    keys.channels.list(),
    (current) => {
      if (current === undefined) return current;
      const index = current.data.findIndex((c) => c.channel_id === channel.channel_id);
      const data =
        index < 0
          ? [...current.data, channel].sort((a, b) => a.name.localeCompare(b.name))
          : current.data.map((c) => (c.channel_id === channel.channel_id ? channel : c));
      return { ...current, data };
    },
  );
}

/** `POST /channels`. */
export function useCreateChannel() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChannelInput) => api.createChannel({ body }),
    onSuccess: (result) => patchChannelCaches(queryClient, result.channel),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.channels.list() }),
  });
}

/** `PATCH /channels/{id}`. */
export function useUpdateChannel(channelId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChannelPatch) =>
      api.updateChannel({ params: { channel_id: channelId }, body }),
    onSuccess: (result) => patchChannelCaches(queryClient, result.channel),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.channels.list() }),
  });
}

/** Channel actions of a card: pause, resume, delete (toasts on failure). */
export function useChannelActions() {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const pause = useMutation({
    mutationFn: (id: string) => api.pauseChannel({ params: { channel_id: id } }),
    onSuccess: (result) => patchChannelCaches(queryClient, result.channel),
    onError: (error) => toast.fromError(toAppError(error), 'Could not pause the channel'),
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.resumeChannel({ params: { channel_id: id } }),
    onSuccess: (result) => patchChannelCaches(queryClient, result.channel),
    onError: (error) => toast.fromError(toAppError(error), 'Could not resume the channel'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChannel({ params: { channel_id: id } }),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<{ data: ChannelView[]; now: number } | undefined>(
        keys.channels.list(),
        (current) =>
          current === undefined
            ? current
            : { ...current, data: current.data.filter((c) => c.channel_id !== id) },
      );
      queryClient.removeQueries({ queryKey: keys.channels.detail(id) });
      void queryClient.invalidateQueries({ queryKey: keys.channels.deliveryLists() });
    },
    onError: (error) => toast.fromError(toAppError(error), 'Could not delete the channel'),
  });
  return { pause, resume, remove };
}

/** `POST /channels/{id}/test`: sends a real message now and returns the delivery row. */
export function useTestChannel() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testChannel({ params: { channel_id: id } }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.channels.list() });
      void queryClient.invalidateQueries({ queryKey: keys.channels.deliveryLists() });
    },
  });
}

/** The preview body for a draft or a saved channel. */
export type PreviewInput = Omit<ChannelPreviewRequest, 'sample'> & {
  readonly sample: PreviewSample;
};

/** `POST /channels/preview` as a query (pure on the server, so it caches by its input). */
export function useChannelPreview(input: PreviewInput | null) {
  const api = useApi();
  const params = input === null ? {} : stableParams(input);
  return useQuery({
    queryKey: keys.channels.preview(params),
    queryFn: () => api.previewChannel({ body: input ?? { kind: 'webhook', sample: 'attention' } }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** `GET /channels/env`: whether each variable is set on the server (polled while `poll`). */
export function useChannelEnv(names: readonly string[], poll: boolean) {
  const api = useApi();
  const valid = names.filter(
    (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !n.startsWith('BROWSERHIVE_'),
  );
  return useQuery({
    queryKey: keys.channels.env(valid),
    queryFn: () => api.checkChannelEnv({ query: { names: valid } }),
    enabled: valid.length > 0,
    refetchInterval: poll ? 3_000 : false,
    placeholderData: keepPreviousData,
  });
}

/** `POST /channels/telegram/connect`. */
export function useStartTelegramConnect() {
  const api = useApi();
  return useMutation({
    mutationFn: (tokenEnv: string) => api.startTelegramConnect({ body: { token_env: tokenEnv } }),
  });
}

/** `GET /channels/telegram/connect/{id}`, polled every 2 s while waiting. */
export function useTelegramConnect(connectId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channels.connect(connectId ?? ''),
    queryFn: () => api.getTelegramConnect({ params: { connect_id: connectId ?? '' } }),
    enabled: connectId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'waiting' ? 2_000 : false),
  });
}

/** Delivery log filters (URL search, spec 04 §12.11.1). */
export interface DeliveryFilters {
  readonly channel?: string | undefined;
  readonly status?: readonly string[] | undefined;
  readonly op?: readonly string[] | undefined;
  readonly kind?: readonly string[] | undefined;
  readonly notification?: string | undefined;
}

/** `GET /channels/deliveries` query for the filters (without cursor). */
export function deliveriesQuery(filters: DeliveryFilters, limit: number) {
  return {
    limit,
    ...(filters.channel !== undefined && { channel_id: filters.channel }),
    ...(filters.notification !== undefined && { notification_id: filters.notification }),
    ...(filters.status !== undefined &&
      filters.status.length > 0 && { status: [...filters.status] }),
    ...(filters.op !== undefined && filters.op.length > 0 && { op: [...filters.op] }),
    ...(filters.kind !== undefined && filters.kind.length > 0 && { kind: [...filters.kind] }),
  };
}

/** One page of the delivery log (newest first, keyset cursor). */
export function useDeliveries(filters: DeliveryFilters, page: number, limit: number) {
  const api = useApi();
  const pager = useCursorPager();
  const query = deliveriesQuery(filters, limit);
  const filterKey = JSON.stringify(stableParams(query));
  return useQuery({
    queryKey: keys.channels.deliveries({ ...query, page }),
    queryFn: () =>
      pager.resolve(filterKey, page, (cursor) =>
        api.listDeliveries({
          query: { ...query, ...(cursor !== undefined && { cursor }) },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** Every delivery of one notification (the "why wasn't this sent?" timeline). */
export function useNotificationDeliveries(notificationId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channels.deliveries({ notification_id: notificationId, limit: 200 }),
    queryFn: () =>
      api.listDeliveries({ query: { notification_id: notificationId ?? '', limit: 200 } }),
    enabled: notificationId !== null,
  });
}

/** `GET /channels/deliveries/{seq}`. */
export function useDelivery(seq: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channels.delivery(seq ?? 0),
    queryFn: () => api.getDelivery({ params: { seq: seq ?? 0 } }),
    enabled: seq !== null,
  });
}
