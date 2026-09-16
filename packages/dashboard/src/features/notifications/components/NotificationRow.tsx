/** @module features/notifications/components/NotificationRow — one notification as a whole-row link to its target (opening marks it read): type icon, title (semibold + accent dot while unread), body, a meta line naming the session (and when a folded group started), and the time at the right edge with Mark read / Dismiss revealed over it on hover or focus */
import type { Notification } from '@browserhive/contracts/http';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { LinkRow } from '@/features/overview/components/LinkList.tsx';
import { ICONS } from '@/lib/icons.ts';
import { NOTIFICATION_TYPE } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { notificationMeta, notificationSession } from '../notification-meta.ts';

/** Props. */
export interface NotificationRowProps {
  readonly notification: Notification;
  readonly target: string | null;
  readonly onRead: (id: Notification['notification_id']) => void;
  readonly onDismiss: (id: Notification['notification_id']) => void;
}

/** Notification row. */
export function NotificationRow({
  notification: n,
  target,
  onRead,
  onDismiss,
}: NotificationRowProps) {
  const unread = n.read_at === null;
  const entry = NOTIFICATION_TYPE[n.type];
  const TypeIcon = ICONS[entry.icon ?? 'notifications'];
  const Session = ICONS.sessions;
  const Close = ICONS.close;
  const Check = ICONS.check;
  const verb = n.type === 'vault' ? 'Review' : 'Open';
  const meta = notificationMeta(n);
  const slug = notificationSession(n);
  const leadsWithSlug = slug !== null && n.title.startsWith(`${slug} ·`);
  return (
    <LinkRow
      href={target ?? undefined}
      label={`${verb}: ${n.title}${slug !== null && !leadsWithSlug ? ` (${slug})` : ''}`}
      {...(unread && { onOpen: () => onRead(n.notification_id) })}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-1 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5">
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-8 items-center justify-center rounded-full',
            TONE_CLASSES[entry.tone].soft,
          )}
        >
          <TypeIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="sr-only">{entry.label}:</span>
            <span
              className={cn(
                'min-w-0 truncate',
                unread ? 'font-semibold text-foreground' : 'text-foreground/90',
                target !== null &&
                  'decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline',
              )}
            >
              {n.title}
            </span>
            {unread ? (
              <span className="size-2 shrink-0 rounded-full bg-primary">
                <span className="sr-only">Unread</span>
              </span>
            ) : null}
          </div>
          {n.body !== null ? (
            <p className="line-clamp-2 text-sm break-words text-muted-foreground">{n.body}</p>
          ) : null}
          {meta.length > 0 ? (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              {slug !== null && !leadsWithSlug ? (
                <Session aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 truncate">{meta.join(' · ')}</span>
            </p>
          ) : null}
        </div>
        <div className="relative col-start-2 flex min-h-8 items-center justify-between gap-2 sm:col-start-3 sm:row-start-1 sm:min-w-18 sm:justify-end">
          <RelativeTime
            at={n.updated_at}
            className="text-sm whitespace-nowrap text-muted-foreground transition-opacity duration-(--duration-fast) [@media(hover:hover)]:sm:group-focus-within/row:opacity-0 [@media(hover:hover)]:sm:group-hover/row:opacity-0"
          />
          <div className="reveal flex items-center gap-0.5 [@media(hover:hover)]:sm:absolute [@media(hover:hover)]:sm:inset-y-0 [@media(hover:hover)]:sm:right-0">
            {unread ? (
              <Hint label="Mark read">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Mark read: ${n.title}`}
                  onClick={() => onRead(n.notification_id)}
                >
                  <Check aria-hidden="true" />
                </Button>
              </Hint>
            ) : null}
            <Hint label="Dismiss">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Dismiss ${n.title}`}
                onClick={() => onDismiss(n.notification_id)}
              >
                <Close aria-hidden="true" />
              </Button>
            </Hint>
          </div>
        </div>
      </div>
    </LinkRow>
  );
}
