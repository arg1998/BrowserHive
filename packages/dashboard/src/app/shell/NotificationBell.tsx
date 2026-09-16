/** @module app/shell/NotificationBell — unread badge + popover of recent notifications as real row buttons, per-row mark read / dismiss on hover, Mark all read, Dismiss all (confirm), View all */
import type { Notification } from '@browserhive/contracts/http';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useNotifications } from '@/app/providers/NotificationsProvider.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { notificationMeta } from '@/features/notifications/notification-meta.ts';
import { keys } from '@/lib/api/keys.ts';
import { ICONS } from '@/lib/icons.ts';
import { NOTIFICATION_TYPE } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';

/** How many recent notifications the popover fetches (dismissed ones are filtered out). */
const BELL_FETCH = 12;
/** How many it shows: enough to be useful, few enough to never need an inner scroller. */
const BELL_SHOW = 6;

/** Visible bell rows: not dismissed, newest first, capped (pure; exported for tests). */
export function bellRows(rows: readonly Notification[]): readonly Notification[] {
  return rows.filter((n) => n.dismissed_at === null).slice(0, BELL_SHOW);
}

/**
 * Badge text: exact up to 9, then "9+". The badge anchors to the button's top-right corner and grows
 * leftwards over the bell, so it never spills onto the neighbouring control.
 */
export function bellBadge(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** Bell. */
export function NotificationBell() {
  const api = useApi();
  const notifications = useNotifications();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const recent = useQuery({
    queryKey: keys.notifications.list({ limit: BELL_FETCH, read: 'all' }),
    queryFn: () => api.listNotifications({ query: { limit: BELL_FETCH, read: 'all' } }),
    enabled: open,
  });
  const Bell = ICONS.notifications;
  const CheckAll = ICONS.checkAll;
  const count = notifications.unreadCount;
  const badge = bellBadge(count);
  const rows = bellRows(recent.data?.data ?? []);
  const openItem = (n: Notification) => {
    if (n.read_at === null) notifications.markRead(n.notification_id);
    const target = notifications.targetOf(n);
    setOpen(false);
    if (target !== null) void navigate({ to: target });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="Notifications">
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
              className="relative"
            />
          }
        >
          <Bell aria-hidden="true" />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-xs leading-none font-semibold text-danger-on-solid tabular-nums ring-2 ring-background"
            >
              {badge}
            </span>
          ) : null}
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)] gap-0 overflow-y-auto p-0"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b pr-2 pl-4">
          <p className="text-base font-semibold">
            Notifications
            {count > 0 ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">{count} unread</span>
            ) : null}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void notifications.markAllRead()}
            disabled={count === 0}
          >
            <CheckAll aria-hidden="true" /> Mark all read
          </Button>
        </div>
        {recent.isPending ? (
          <div className="flex flex-col gap-4 p-4" role="status" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            kind="zero-data"
            icon="notificationsOff"
            size="sm"
            title="You're all caught up"
            description="Attention requests, tool errors and vault events show up here."
          />
        ) : (
          <ul aria-label="Recent notifications" className="flex flex-col py-1">
            {rows.map((n) => (
              <BellRow
                key={n.notification_id}
                notification={n}
                onOpen={() => openItem(n)}
                onMarkRead={() => notifications.markRead(n.notification_id)}
                onDismiss={() => notifications.dismiss(n.notification_id)}
              />
            ))}
          </ul>
        )}
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t px-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={rows.length === 0}
            onClick={async () => {
              setOpen(false);
              if (
                await confirm({
                  title: 'Dismiss all notifications?',
                  description: 'They are removed from the list for everyone on this daemon.',
                  confirmLabel: 'Dismiss all',
                  danger: true,
                })
              ) {
                await notifications.dismissAll();
              }
            }}
          >
            Dismiss all
          </Button>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className={buttonVariants({ variant: 'outline', size: 'xs' })}
          >
            View all
            <ICONS.arrowRight aria-hidden="true" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BellRow({
  notification: n,
  onOpen,
  onMarkRead,
  onDismiss,
}: {
  readonly notification: Notification;
  readonly onOpen: () => void;
  readonly onMarkRead: () => void;
  readonly onDismiss: () => void;
}) {
  const entry = NOTIFICATION_TYPE[n.type];
  const Icon = ICONS[entry.icon ?? 'notifications'];
  const unread = n.read_at === null;
  const meta = notificationMeta(n);
  return (
    <li data-reveal-scope="" className="group/bell relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-start gap-3 py-2.5 pr-10 pl-4 text-left transition-colors hover:bg-accent focus-ring-inset focus-visible:bg-accent"
      >
        <span
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
            TONE_CLASSES[entry.tone].soft,
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'line-clamp-2 text-base leading-5',
              unread ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {n.title}
          </span>
          {n.body !== null ? (
            <span className="line-clamp-2 text-sm text-muted-foreground">{n.body}</span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {meta.length > 0 ? (
              <>
                <span className="min-w-0 truncate">{meta.join(' · ')}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <RelativeTime at={n.updated_at} className="shrink-0" />
          </span>
        </span>
        {unread ? (
          <span className="absolute top-4.5 right-4 size-2 rounded-full bg-primary transition-opacity group-hover/bell:opacity-0 group-focus-within/bell:opacity-0">
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </button>
      <span className="reveal absolute top-2 right-2 flex flex-col items-center gap-0.5">
        {unread ? (
          <Hint label="Mark as read">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Mark as read"
              onClick={onMarkRead}
            >
              <ICONS.check aria-hidden="true" />
            </Button>
          </Hint>
        ) : null}
        <Hint label="Dismiss">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <ICONS.close aria-hidden="true" />
          </Button>
        </Hint>
      </span>
    </li>
  );
}
