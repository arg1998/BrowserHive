/** @module features/notifications/channels/log/DeliveryLogPage — `/notifications/log`: every delivery job newest first (time, channel, notification, revision and op, status with the reason in words, attempts, latency), filters in the URL, live through the `channels` topic, and a detail sheet (`?seq=`) with the "why wasn't this sent?" timeline (spec 04 §12.11.1) */
import type { NotificationKind } from '@browserhive/contracts/enums';
import type { DeliveryRow } from '@browserhive/contracts/http';
import { deliveryReasonText } from '@browserhive/contracts/notifications';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { ListSkeleton } from '@/features/overview/components/ListSkeleton.tsx';
import { formatMs } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { DELIVERY_STATUS } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { NotificationsNav } from '../../NotificationsNav.tsx';
import { useChannels, useDeliveries } from '../api.ts';
import { PlatformMark } from '../platforms.tsx';
import type { DeliveryLogSearch } from '../search.ts';
import { DeliveryDetailSheet } from './DeliveryDetailSheet.tsx';

const STATUS_OPTIONS = ['sent', 'pending', 'retrying', 'dead', 'suppressed', 'superseded'] as const;
const OP_LABEL: Readonly<Record<string, string>> = {
  send: 'Send',
  edit: 'Update',
  delete: 'Delete',
};
const KIND_OPTIONS: readonly NotificationKind[] = [
  'attention.requested',
  'vault.confirm',
  'tool.errors',
  'session.crashed',
  'session.reaped',
  'system.degraded',
  'test',
];
const KIND_LABEL: Readonly<Record<string, string>> = {
  'attention.requested': 'Attention',
  'vault.confirm': 'Vault confirm',
  'tool.errors': 'Tool errors',
  'session.crashed': 'Crash',
  'session.reaped': 'Reaped',
  'system.degraded': 'System',
  test: 'Test',
};

function Row({ row, onOpen }: { readonly row: DeliveryRow; readonly onOpen: () => void }) {
  const entry = DELIVERY_STATUS[row.status];
  const reason = row.status === 'sent' ? null : deliveryReasonText(row.reason);
  const Chevron = ICONS.chevronRight;
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full cursor-pointer grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors focus-ring-inset hover:bg-accent/70 lg:grid-cols-[7rem_minmax(8rem,12rem)_minmax(0,1fr)_minmax(8rem,14rem)_5rem_1rem] lg:items-center dark:hover:bg-white/[0.035]"
      >
        <span className="order-4 col-span-2 text-xs text-muted-foreground lg:order-none lg:col-span-1 lg:text-sm">
          <RelativeTime at={row.updated_at} />
        </span>
        <span className="order-1 flex min-w-0 items-center gap-2 lg:order-none">
          {row.channel_kind !== null ? <PlatformMark kind={row.channel_kind} size="sm" /> : null}
          <span className="truncate text-sm font-medium">{row.channel_name ?? row.channel_id}</span>
        </span>
        <span className="order-3 col-span-2 flex min-w-0 flex-col lg:order-none lg:col-span-1">
          <span className="truncate text-sm group-hover/row:underline">
            {row.notification_title ?? row.notification_id}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {OP_LABEL[row.op] ?? row.op} · revision {row.revision}
            {row.notification_kind !== null
              ? ` · ${KIND_LABEL[row.notification_kind] ?? row.notification_kind}`
              : ''}
          </span>
        </span>
        <span className="order-2 flex min-w-0 flex-col items-end gap-0.5 lg:order-none lg:items-start">
          <TonePill entry={entry} />
          {reason !== null ? (
            <span className="line-clamp-1 hidden text-xs text-muted-foreground lg:block">
              {reason}
            </span>
          ) : null}
        </span>
        <span className="order-5 hidden text-right text-sm text-muted-foreground tabular-nums lg:order-none lg:block">
          {row.duration_ms === null ? '—' : formatMs(row.duration_ms)}
          {row.attempts > 1 ? <span className="block text-xs">{row.attempts} tries</span> : null}
        </span>
        <Chevron
          aria-hidden="true"
          className="order-6 hidden size-4 text-subtle-foreground lg:block"
        />
      </button>
    </li>
  );
}

/** Notifications › Delivery log. */
export function DeliveryLogPage() {
  const { search, set, clear } = useSearchState<DeliveryLogSearch>();
  const channels = useChannels();
  const list = useDeliveries(
    {
      channel: search.channel,
      status: search.status,
      op: search.op,
      kind: search.kind,
      notification: search.notification,
    },
    search.page,
    search.ps,
  );
  useTopic('channels');
  const filtered =
    search.channel !== undefined ||
    search.status !== undefined ||
    search.op !== undefined ||
    search.kind !== undefined ||
    search.notification !== undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Every message BrowserHive sent, updated or deleted on your channels, and why anything was held back."
        learnMore="A notification becomes one delivery per channel and change: a send, silent updates as it changes, and a delete when it self-destructs. Suppressed rows explain why something was not sent (the channel's rules, quiet hours, a paused channel). Rows are kept for 30 days."
        learnMoreDocs="deliveryLog"
        tabs={<NotificationsNav />}
      />
      <FilterBar
        selects={[
          {
            param: 'channel',
            label: 'Channel',
            value: search.channel,
            allLabel: 'All channels',
            options: (channels.data?.data ?? []).map((c) => ({
              value: c.channel_id,
              label: c.name,
            })),
          },
        ]}
        chips={[
          {
            param: 'status',
            label: 'Status',
            options: STATUS_OPTIONS.map((value) => ({ value, count: 0 })),
            selected: search.status ?? [],
            counts: false,
            format: (v) => DELIVERY_STATUS[v as keyof typeof DELIVERY_STATUS]?.label ?? v,
          },
          {
            param: 'op',
            label: 'Operation',
            options: ['send', 'edit', 'delete'].map((value) => ({ value, count: 0 })),
            selected: search.op ?? [],
            counts: false,
            format: (v) => OP_LABEL[v] ?? v,
          },
          {
            param: 'kind',
            label: 'Kind',
            options: KIND_OPTIONS.map((value) => ({ value, count: 0 })),
            selected: search.kind ?? [],
            counts: false,
            format: (v) => KIND_LABEL[v] ?? v,
          },
        ]}
        tokens={
          search.notification !== undefined
            ? [
                {
                  key: 'notification',
                  value: search.notification,
                  onRemove: () => set({ notification: undefined }),
                },
              ]
            : []
        }
        {...(list.data?.page.total !== undefined && { matching: list.data.page.total })}
        onChange={(param, value) => set({ [param]: value })}
        onClear={() => clear()}
      />
      <DataPanel
        query={list}
        skeleton={
          <Panel padding="none">
            <ListSkeleton rows={8} twoLine />
          </Panel>
        }
        isEmpty={(page) => page.data.length === 0}
        empty={
          <EmptyState
            kind={filtered ? 'zero-results' : 'zero-data'}
            variant="panel"
            icon="deliveryLog"
            title={filtered ? 'No deliveries match' : 'Nothing delivered yet'}
            description={
              filtered
                ? 'Try other filters.'
                : 'Once a channel exists, every send, update and delete appears here, with the reason when something was not sent.'
            }
            onClear={() => clear()}
          />
        }
      >
        {(page) => (
          <div className="flex flex-col gap-4">
            <Panel padding="none" bodyClassName="overflow-hidden rounded-xl">
              <div
                aria-hidden="true"
                className="hidden grid-cols-[7rem_minmax(8rem,12rem)_minmax(0,1fr)_minmax(8rem,14rem)_5rem_1rem] gap-x-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid dark:bg-white/[0.02]"
              >
                <span>When</span>
                <span>Channel</span>
                <span>Notification</span>
                <span>Status</span>
                <span className="text-right">Latency</span>
                <span />
              </div>
              <ul aria-label="Deliveries" className={cn('flex flex-col divide-y divide-border')}>
                {page.data.map((row) => (
                  <Row
                    key={row.seq}
                    row={row}
                    onOpen={() => set({ seq: row.seq, page: search.page })}
                  />
                ))}
              </ul>
            </Panel>
            <Pagination
              page={search.page}
              pageSize={search.ps}
              {...(page.page.total !== undefined && { total: page.page.total })}
              hasNext={page.page.next_cursor !== null}
              onPage={(p) => set({ page: p })}
              onPageSize={(ps) => set({ ps })}
            />
          </div>
        )}
      </DataPanel>
      <DeliveryDetailSheet
        seq={search.seq ?? null}
        onClose={() => set({ seq: undefined, page: search.page })}
      />
    </div>
  );
}
