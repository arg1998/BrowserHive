/** @module features/notifications/reports/ReportPage — `/notifications/reports/$notificationId`: one report (D-45, spec 04 §12.11.2): its title and kind, when it was made, the window in its zone with the late and on-demand markers, the anomaly alert's outcome, "Open Overview for this period", the channels it reached and how each delivery went, then the message drawn natively; opening it marks the in-app copy read */
import type { ReportItem } from '@browserhive/contracts/http';
import type { NotificationMessage } from '@browserhive/contracts/notifications';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useNotifications } from '@/app/providers/NotificationsProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { notificationEntry } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { PlatformMark, platformOf } from '../channels/platforms.tsx';
import { NotificationsNav } from '../NotificationsNav.tsx';
import { useReport } from './api.ts';
import {
  anomalyOutcome,
  deliveryFailed,
  deliveryWords,
  overviewPeriod,
  reportKindLabel,
  reportWindowText,
} from './model.ts';
import { ReportMessage } from './ReportMessage.tsx';

/** The report's header facts: kind, made, window, markers and outcome. */
function ReportMeta({
  item,
  message,
}: {
  readonly item: ReportItem;
  readonly message: NotificationMessage;
}) {
  const n = item.notification;
  const window = reportWindowText(item.report);
  const outcome = anomalyOutcome(n);
  const skipped = item.report?.skipped ?? 0;
  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">Made</dt>
        <dd>
          <RelativeTime at={n.created_at} mode="absolute" />
        </dd>
      </div>
      {window !== null ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="text-muted-foreground">
            {n.kind === 'report.anomaly' ? 'Checked' : 'Covers'}
          </dt>
          <dd className="min-w-0 break-words">{window}</dd>
        </div>
      ) : null}
      {outcome !== null || item.report?.late === true || item.report?.manual === true ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <dt className="sr-only">Markers</dt>
          {outcome !== null ? (
            <dd>
              <TonePill entry={outcome} iconless />
            </dd>
          ) : null}
          {item.report?.late === true ? (
            <dd>
              <TonePill
                entry={{
                  label: skipped > 0 ? `late · ${skipped} skipped` : 'late',
                  tone: 'warn',
                }}
                iconless
              />
            </dd>
          ) : null}
          {item.report?.manual === true ? (
            <dd>
              <TonePill entry={{ label: 'on demand', tone: 'accent' }} iconless />
            </dd>
          ) : null}
        </div>
      ) : null}
      {message.privacy.level !== 'full' ? (
        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Content</dt>
          <dd>{message.privacy.level}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** The channels a report reached, each with how its delivery went. */
function SentTo({ item }: { readonly item: ReportItem }) {
  const n = item.notification;
  if (item.channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Only in BrowserHive: no channel received this report.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y">
      {item.channels.map((c) => (
        <li key={c.channel_id} className="flex items-center justify-between gap-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2.5">
            <PlatformMark kind={c.kind} size="sm" />
            <span className="min-w-0 truncate font-medium">{c.name}</span>
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {platformOf(c.kind).label}
            </span>
          </span>
          <Link
            to="/notifications/log"
            search={{ channel: c.channel_id, notification: undefined }}
            className={cn(
              'shrink-0 text-sm underline-offset-4 hover:underline focus-ring rounded-xs',
              deliveryFailed(c.status) ? 'text-danger-text' : 'text-muted-foreground',
            )}
            aria-label={`${c.name}: ${deliveryWords(c.status, c.reason)}, open the delivery log`}
          >
            {deliveryWords(c.status, c.reason)}
          </Link>
        </li>
      ))}
      <li className="sr-only">{n.title}</li>
    </ul>
  );
}

/** One report. */
export function ReportPage() {
  const { notificationId } = useParams({ strict: false }) as { notificationId: string };
  const report = useReport(notificationId);
  const notifications = useNotifications();
  const unread = report.data?.report.notification.read_at === null;
  const { markRead } = notifications;
  const marked = useRef<string | null>(null);
  // Opening a report reads it once (an anomaly alert leaves the badge).
  useEffect(() => {
    if (!unread || marked.current === notificationId) return;
    marked.current = notificationId;
    markRead(notificationId as never);
  }, [unread, notificationId, markRead]);
  const Back = ICONS.arrowLeft;
  const Overview = ICONS.overview;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Notifications" tabs={<NotificationsNav />} />
      <DataPanel query={report} skeleton={<SkeletonCard />} isEmpty={() => false} empty={null}>
        {({ report: item, message }) => {
          const n = item.notification;
          const entry = notificationEntry(n);
          const Icon = ICONS[entry.icon ?? 'reports'];
          const period = overviewPeriod(n, message);
          return (
            <article aria-labelledby="report-title" className="flex flex-col gap-6">
              <div className="flex flex-col gap-4">
                <Link
                  to="/notifications/reports"
                  className="inline-flex w-fit items-center gap-1.5 rounded-xs text-sm text-muted-foreground hover:text-foreground focus-ring"
                >
                  <Back aria-hidden="true" className="size-4" />
                  All reports
                </Link>
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-full',
                        TONE_CLASSES[entry.tone].soft,
                      )}
                    >
                      <Icon className="size-5" />
                    </span>
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-sm text-muted-foreground">{reportKindLabel(n.kind)}</p>
                      <h2 id="report-title" className="text-xl font-semibold break-words">
                        {message.title}
                      </h2>
                      {message.summary !== '' ? (
                        <p className="text-base text-muted-foreground">{message.summary}</p>
                      ) : null}
                    </div>
                  </div>
                  {period !== null ? (
                    <Link
                      to="/overview"
                      search={{ since: period.since, until: period.until }}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
                    >
                      <Overview aria-hidden="true" />
                      Open Overview for this period
                    </Link>
                  ) : null}
                </div>
                <ReportMeta item={item} message={message} />
              </div>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <section aria-label="Report" className="min-w-0">
                  <ReportMessage message={message} zone={item.report?.time_zone ?? 'UTC'} />
                </section>
                <Panel title="Sent to" className="self-start">
                  <SentTo item={item} />
                </Panel>
              </div>
            </article>
          );
        }}
      </DataPanel>
    </div>
  );
}
