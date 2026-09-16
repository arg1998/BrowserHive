/** @module features/notifications/NotificationsPage — server-backed notifications: unread badge, Mark all read / Dismiss all (confirm), one filter bar (read state, type chips, range) in the URL, day-grouped panels of whole-row links with optimistic read/dismiss (provider), toast preferences (spec 04 §12.11) */
import { NotificationType } from '@browserhive/contracts/enums';
import type { Notification } from '@browserhive/contracts/http';
import { useMemo, useRef } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useNotifications } from '@/app/providers/NotificationsProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { LinkList } from '@/features/overview/components/LinkList.tsx';
import { ListSkeleton } from '@/features/overview/components/ListSkeleton.tsx';
import { NewRowsPill } from '@/features/overview/components/NewRowsPill.tsx';
import { useLiveHold } from '@/features/overview/live-hold.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { formatDayGroup } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useServerClock } from '@/lib/server-now.ts';
import { NOTIFICATION_TYPE } from '@/lib/status-registry.ts';
import { useNotificationList, usePreferences, useSavePreferences } from './api.ts';
import { NotificationRow } from './components/NotificationRow.tsx';
import { PreferencesForm } from './components/PreferencesForm.tsx';
import { NOTIFICATION_RANGES, type NotificationsSearch } from './search.ts';

/** Visible (not dismissed) notifications, latest activity first (a folded group moves up as it grows). */
export function visibleNotifications(rows: readonly Notification[]): readonly Notification[] {
  return rows
    .filter((n) => n.dismissed_at === null)
    .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at);
}

const notificationId = (n: Notification): string => n.notification_id;
const notificationVersion = (n: Notification): number => n.updated_at;

/** Group notifications by the day of their latest activity, in the given order. */
export function groupByDay(
  rows: readonly Notification[],
  now: number,
): readonly (readonly [string, readonly Notification[]])[] {
  const groups = new Map<string, Notification[]>();
  for (const n of rows) {
    if (n.dismissed_at !== null) continue;
    const label = formatDayGroup(n.updated_at, now);
    const list = groups.get(label) ?? [];
    list.push(n);
    groups.set(label, list);
  }
  return [...groups.entries()];
}

/** Notifications. */
export function NotificationsPage() {
  const { search, set, clear } = useSearchState<NotificationsSearch>();
  const notifications = useNotifications();
  const confirm = useConfirm();
  const toast = useToast();
  const clock = useServerClock();
  const list = useNotificationList(search);
  const prefs = usePreferences();
  const savePrefs = useSavePreferences();
  useTopic('notifications');
  const run = (action: () => Promise<void>, title: string) =>
    action().catch((error: unknown) => toast.fromError(toAppError(error), title));
  const CheckAll = ICONS.checkAll;
  const unread = notifications.unreadCount;
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleNotifications(list.data?.data ?? []), [list.data]);
  const hold = useLiveHold(rows, listRef, {
    getId: notificationId,
    getVersion: notificationVersion,
    listKey: JSON.stringify([search.read, search.type, search.range, search.page, search.ps]),
    enabled: search.page === 1,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        badge={
          unread > 0 ? (
            <TonePill entry={{ label: `${formatNumber(unread)} unread`, tone: 'accent' }} />
          ) : undefined
        }
        description="Attention requests, tool errors, vault and lifecycle events for your account."
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Dismiss all notifications?',
                  description: 'They are removed from this list and the bell.',
                  confirmLabel: 'Dismiss all',
                  danger: true,
                });
                if (ok) await run(notifications.dismissAll, 'Could not dismiss all');
              }}
            >
              Dismiss all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={unread === 0}
              onClick={() => void run(notifications.markAllRead, 'Could not mark all as read')}
            >
              <CheckAll aria-hidden="true" />
              Mark all read
            </Button>
          </>
        }
      />
      <FilterBar
        range={
          <>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                Show
              </span>
              <ToggleGroup
                aria-label="Show"
                size="sm"
                spacing={0}
                value={[search.read]}
                onValueChange={(next: readonly unknown[]) => {
                  const value = next[0];
                  if (value === 'all' || value === 'unread' || value === 'read') {
                    set({ read: value });
                  }
                }}
              >
                <ToggleGroupItem value="all">All</ToggleGroupItem>
                <ToggleGroupItem value="unread">Unread</ToggleGroupItem>
                <ToggleGroupItem value="read">Read</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                Period
              </span>
              <TimeRangeControl
                value={search.range}
                options={NOTIFICATION_RANGES}
                custom={false}
                onChange={(patch) => set({ range: patch.range })}
              />
            </div>
          </>
        }
        chips={[
          {
            param: 'type',
            label: 'Type',
            options: NotificationType.options.map((value) => ({ value, count: 0 })),
            selected: search.type ?? [],
            counts: false,
            format: (value) => {
              const label = NOTIFICATION_TYPE[value as NotificationType]?.label ?? value;
              return label.charAt(0).toUpperCase() + label.slice(1);
            },
          },
        ]}
        {...(list.data?.page.total !== undefined && { matching: list.data.page.total })}
        onChange={(param, value) => set({ [param]: value })}
        onClear={() => clear(['range'])}
      />
      {/* The skeleton holds the list's place from the first paint so the preferences panel below never jumps. */}
      {list.isPending && list.failureCount === 0 ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-12" />
          <Panel padding="none">
            <ListSkeleton rows={8} twoLine />
          </Panel>
        </div>
      ) : (
        <DataPanel
          query={list}
          skeleton={
            <Panel padding="none">
              <ListSkeleton rows={6} twoLine />
            </Panel>
          }
          isEmpty={(page) => page.data.every((n) => n.dismissed_at !== null)}
          empty={
            <EmptyState
              kind={
                search.read !== 'all' || search.type !== undefined ? 'zero-results' : 'zero-data'
              }
              variant="panel"
              icon="notifications"
              title="Nothing here"
              description="No notifications match these filters. New events appear here as they happen."
              onClear={() => clear(['range'])}
            />
          }
        >
          {(page) => (
            <div ref={listRef}>
              <NewRowsPill
                count={hold.pending}
                added={hold.added}
                noun="notification"
                onShow={hold.release}
              />
              <div className="flex flex-col gap-6">
                {groupByDay(hold.shown, clock.now()).map(([day, dayRows]) => (
                  <section key={day} aria-label={day} className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium text-muted-foreground">{day}</h2>
                    <Panel padding="none" bodyClassName="overflow-hidden rounded-xl">
                      <LinkList label={`Notifications ${day}`}>
                        {dayRows.map((n) => (
                          <NotificationRow
                            key={n.notification_id}
                            notification={n}
                            target={notifications.targetOf(n)}
                            onRead={notifications.markRead}
                            onDismiss={notifications.dismiss}
                          />
                        ))}
                      </LinkList>
                    </Panel>
                  </section>
                ))}
                <Pagination
                  page={search.page}
                  pageSize={search.ps}
                  {...(page.page.total !== undefined && { total: page.page.total })}
                  hasNext={page.page.next_cursor !== null}
                  onPage={(p) => set({ page: p })}
                  onPageSize={(ps) => set({ ps })}
                />
              </div>
            </div>
          )}
        </DataPanel>
      )}
      {/* Below the list: mounted once the list has its height, so it appears in place instead of being pushed down. */}
      {list.isPending ? null : (
        <Panel
          title="Toast preferences"
          description="Saved to your account and applied on every device."
        >
          <DataPanel query={prefs} skeleton={<SkeletonCard />} isEmpty={() => false} empty={null}>
            {(data) => (
              <PreferencesForm
                preferences={data.preferences}
                saving={savePrefs.isPending}
                onSave={(next) => savePrefs.mutate(next)}
              />
            )}
          </DataPanel>
        </Panel>
      )}
    </div>
  );
}
