/** @module features/notifications/channels/log/DeliveryDetailSheet — one delivery in a side sheet: its status and reason in words, attempts, latency, last error, the platform message ref, the notification's timeline on every channel ("why wasn't this sent?") and the redacted message as this channel was shown it (`GET /channels/deliveries/{seq}`) */
import type { DeliveryRow } from '@browserhive/contracts/http';
import { deliveryReasonText } from '@browserhive/contracts/notifications';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { KeyValue } from '@/components/shared/KeyValue.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatAbsolute, formatMs } from '@/lib/format/time.ts';
import { DELIVERY_STATUS } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { useDelivery, useNotificationDeliveries } from '../api.ts';
import { formatInZone, zoneLabel } from '../model.ts';
import { PlatformMark } from '../platforms.tsx';

/** "sent", "not sent: quiet hours", … as one sentence for the timeline. */
export function deliverySentence(row: DeliveryRow): string {
  const op = row.op === 'send' ? 'Send' : row.op === 'edit' ? 'Update' : 'Delete';
  const status = DELIVERY_STATUS[row.status].label;
  return `${op} of revision ${row.revision}: ${status}`;
}

function Timeline({
  notificationId,
  current,
}: {
  readonly notificationId: string;
  readonly current: number;
}) {
  const rows = useNotificationDeliveries(notificationId);
  if (rows.data === undefined) return <Skeleton className="h-24 w-full" />;
  const list = [...rows.data.data].sort((a, b) => a.seq - b.seq);
  return (
    <ol className="flex flex-col">
      {list.map((row) => {
        const reason = deliveryReasonText(row.reason);
        const entry = DELIVERY_STATUS[row.status];
        return (
          <li
            key={row.seq}
            className={cn(
              'relative flex gap-3 border-l py-2 pl-4',
              row.seq === current &&
                'before:absolute before:top-3 before:-left-[5px] before:size-2.5 before:rounded-full before:bg-primary',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                {row.channel_kind !== null ? (
                  <PlatformMark kind={row.channel_kind} size="sm" />
                ) : null}
                <span className="text-sm font-medium">{row.channel_name ?? row.channel_id}</span>
                <TonePill entry={entry} />
                <span className="text-xs text-muted-foreground">
                  <RelativeTime at={row.updated_at} />
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {deliverySentence(row)}
                {reason !== null ? (
                  <span className="block text-foreground/85">{reason}</span>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Props. */
export interface DeliveryDetailSheetProps {
  readonly seq: number | null;
  readonly onClose: () => void;
}

/** The detail sheet. */
export function DeliveryDetailSheet({ seq, onClose }: DeliveryDetailSheetProps) {
  const detail = useDelivery(seq);
  const row = detail.data?.delivery;
  const message = detail.data?.message ?? null;
  return (
    <Sheet open={seq !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8">{row?.notification_title ?? 'Delivery'}</SheetTitle>
          <SheetDescription>
            {row !== undefined
              ? `${row.channel_name ?? row.channel_id} · ${deliverySentence(row)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>
        {row === undefined ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-6 p-4">
            {deliveryReasonText(row.reason) !== null ? (
              <p
                className={cn(
                  'rounded-lg px-3 py-2.5 text-sm',
                  row.status === 'dead'
                    ? 'bg-danger-bg text-danger-text'
                    : 'bg-muted dark:bg-white/[0.05]',
                )}
              >
                <span className="font-medium">Why: </span>
                {deliveryReasonText(row.reason)}
              </p>
            ) : null}
            <KeyValue
              items={[
                { key: 'Status', value: <TonePill entry={DELIVERY_STATUS[row.status]} /> },
                { key: 'Operation', value: `${row.op} · revision ${row.revision}` },
                { key: 'Attempts', value: String(row.attempts) },
                {
                  key: 'Latency',
                  value: row.duration_ms === null ? '—' : formatMs(row.duration_ms),
                },
                ...(row.report !== null
                  ? [
                      {
                        key: 'Covers',
                        value: (
                          <span className="flex flex-col gap-1">
                            <span>
                              {formatInZone(row.report.window.since, row.report.time_zone)} →{' '}
                              {formatInZone(row.report.window.until, row.report.time_zone)}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {zoneLabel(row.report.time_zone)}
                              {row.report.late
                                ? ` · sent late${row.report.skipped > 0 ? `, ${row.report.skipped} earlier skipped` : ''}`
                                : ''}
                              {row.report.manual ? ' · sent on demand' : ''}
                            </span>
                          </span>
                        ),
                      },
                    ]
                  : []),
                { key: 'Queued', value: formatAbsolute(row.created_at) },
                { key: 'Updated', value: formatAbsolute(row.updated_at) },
                ...(row.next_attempt_at !== null &&
                (row.status === 'retrying' || row.status === 'pending')
                  ? [{ key: 'Next attempt', value: formatAbsolute(row.next_attempt_at) }]
                  : []),
                ...(row.reason !== null
                  ? [{ key: 'Reason code', value: <code className="font-mono">{row.reason}</code> }]
                  : []),
              ]}
            />
            {row.last_error !== null ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">Last error</h3>
                <pre className="rounded-lg border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] dark:bg-black/20">
                  {row.last_error}
                </pre>
              </section>
            ) : null}
            {row.message_ref !== null ? (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">Platform message</h3>
                <JsonView value={row.message_ref} collapseAt={2} />
              </section>
            ) : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">This notification on every channel</h3>
              <Timeline notificationId={row.notification_id} current={row.seq} />
            </section>
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">The message as this channel was shown it</h3>
              <p className="text-xs text-muted-foreground">
                Redacted, at the channel's content level. Secrets never appear here.
              </p>
              {message !== null ? (
                <JsonView value={message} collapseAt={2} />
              ) : (
                <p className="text-sm text-muted-foreground">Not available.</p>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
