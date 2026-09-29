/** @module features/notifications/reports/ReportsPage — `/notifications/reports`: "Reports in BrowserHive" (the in-app digest schedule and anomaly switch, D-45) above the full history of digests and anomaly alerts, one copy per period whatever the inbox did with it; filters by kind, where it went (a channel, or BrowserHive only) and period in the URL; each row opens its report page (spec 04 §12.11.2) */
import type { ReportItem } from '@browserhive/contracts/http';
import type {
  NotificationChannelRules,
  ReportSettings,
} from '@browserhive/contracts/notifications';
import { useState } from 'react';
import { useHasScope } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { LinkList, LinkRow } from '@/features/overview/components/LinkList.tsx';
import { ListSkeleton } from '@/features/overview/components/ListSkeleton.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { notificationEntry } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { useChannels } from '../channels/api.ts';
import { PlatformMark, platformOf } from '../channels/platforms.tsx';
import { ReportsSection } from '../channels/wizard/ReportsSection.tsx';
import { NotificationsNav } from '../NotificationsNav.tsx';
import { useReportList, useReportSettings, useSaveReportSettings } from './api.ts';
import {
  anomalyOutcome,
  deliveryFailed,
  deliveryWords,
  REPORT_KINDS,
  reportKindLabel,
  reportWindowText,
} from './model.ts';
import { REPORT_RANGES, type ReportsSearch } from './search.ts';

/** The report-rule keys of a rules object (what the in-app settings keep). */
export function settingsOf(rules: NotificationChannelRules): ReportSettings {
  return {
    ...(rules.digest !== undefined && { digest: rules.digest }),
    ...(rules.anomaly !== undefined && { anomaly: rules.anomaly }),
    ...(rules.time_zone !== undefined && { time_zone: rules.time_zone }),
  };
}

/** "Reports in BrowserHive": the in-app schedule, saved server-wide (`channels:write`). */
export function ReportSettingsPanel() {
  const settings = useReportSettings();
  const save = useSaveReportSettings();
  const canWrite = useHasScope('channels:write');
  const [draft, setDraft] = useState<ReportSettings | null>(null);
  const stored = settings.data?.settings;
  const current = draft ?? stored ?? {};
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored ?? {});
  return (
    <DataPanel query={settings} skeleton={<SkeletonCard />} isEmpty={() => false} empty={null}>
      {(data) => (
        <form
          aria-label="Reports in BrowserHive"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft !== null) save.mutate(draft, { onSuccess: () => setDraft(null) });
          }}
        >
          <ReportsSection
            variant="in-app"
            rules={current}
            onRules={(rules) => setDraft(settingsOf(rules))}
            hostZone={data.host_time_zone}
            readOnly={!canWrite}
            errors={{}}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={!canWrite || !dirty || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              Save
            </Button>
            {!canWrite ? (
              <span className="text-sm text-muted-foreground">
                Needs the channels:write permission.
              </span>
            ) : dirty ? (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  Discard
                </Button>
                <span className="text-sm text-muted-foreground">Unsaved changes</span>
              </>
            ) : null}
          </div>
        </form>
      )}
    </DataPanel>
  );
}

/** One report of the history. */
export function ReportRow({ item }: { readonly item: ReportItem }) {
  const n = item.notification;
  const entry = notificationEntry(n);
  const Icon = ICONS[entry.icon ?? 'reports'];
  const window = reportWindowText(item.report);
  const outcome = anomalyOutcome(n);
  const late = item.report?.late === true;
  const manual = item.report?.manual === true;
  const skipped = item.report?.skipped ?? 0;
  return (
    <LinkRow href={`/notifications/reports/${n.notification_id}`} label={`Open report: ${n.title}`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-1 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5">
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-8 items-center justify-center rounded-full',
            TONE_CLASSES[entry.tone].soft,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 truncate font-medium decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
            <span className="sr-only">{reportKindLabel(n.kind)}: </span>
            {n.title}
          </span>
          {n.body !== null ? (
            <p className="line-clamp-2 text-sm break-words text-muted-foreground">{n.body}</p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {outcome !== null ? <TonePill entry={outcome} iconless /> : null}
            {late ? (
              <Hint
                label={
                  skipped > 0
                    ? `BrowserHive was off at its time; ${skipped} earlier ${skipped === 1 ? 'one was' : 'ones were'} skipped.`
                    : 'BrowserHive was off at its time.'
                }
              >
                <span className="relative z-10">
                  <TonePill entry={{ label: 'late', tone: 'warn' }} iconless />
                </span>
              </Hint>
            ) : null}
            {manual ? <TonePill entry={{ label: 'on demand', tone: 'accent' }} iconless /> : null}
            {window !== null ? <span className="min-w-0 break-words">{window}</span> : null}
          </div>
          <ChannelMarks item={item} />
        </div>
        <div className="col-start-2 flex min-h-8 items-center sm:col-start-3 sm:row-start-1 sm:justify-end">
          <RelativeTime
            at={n.created_at}
            className="text-sm whitespace-nowrap text-muted-foreground"
          />
        </div>
      </div>
    </LinkRow>
  );
}

/** Where a report went: the platform marks of its channels, or "Only in BrowserHive". */
function ChannelMarks({ item }: { readonly item: ReportItem }) {
  if (item.channels.length === 0) {
    return <p className="text-sm text-muted-foreground">Only in BrowserHive</p>;
  }
  return (
    <ul aria-label="Sent to" className="flex flex-wrap items-center gap-1.5">
      {item.channels.map((c) => (
        <li key={c.channel_id}>
          <Hint
            label={`${c.name} (${platformOf(c.kind).label}): ${deliveryWords(c.status, c.reason)}`}
          >
            <span
              className={cn(
                'relative z-10 inline-flex h-6 items-center gap-1.5 rounded-full border bg-card px-2 text-xs',
                deliveryFailed(c.status) && 'border-danger-border text-danger-text',
              )}
            >
              <PlatformMark kind={c.kind} size="sm" />
              {c.name}
              <span className="sr-only">: {deliveryWords(c.status, c.reason)}</span>
            </span>
          </Hint>
        </li>
      ))}
    </ul>
  );
}

/** Reports. */
export function ReportsPage() {
  const { search, set, clear } = useSearchState<ReportsSearch>();
  const list = useReportList(search);
  const channels = useChannels();
  useTopic('notifications');
  const filtered = search.kind !== undefined || search.channel !== undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="Every digest and anomaly alert, once per period, whichever channels it reached."
        learnMore="A report reaches every channel that schedules it, at each one's content level, and lands here once, in full. Dismissing it from the inbox keeps it here; reports are kept for 90 days."
        learnMoreDocs="notificationReports"
        tabs={<NotificationsNav />}
      />
      <ReportSettingsPanel />
      <section aria-labelledby="reports-history" className="flex flex-col gap-3">
        <h2 id="reports-history" className="text-base font-semibold">
          History
        </h2>
        <FilterBar
          range={
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-sm text-muted-foreground">
                Period
              </span>
              <TimeRangeControl
                value={search.range}
                options={REPORT_RANGES}
                custom={false}
                onChange={(patch) => set({ range: patch.range })}
              />
            </div>
          }
          selects={[
            {
              param: 'channel',
              label: 'Sent to',
              value: search.channel,
              allLabel: 'Anywhere',
              options: [
                { value: 'in-app', label: 'BrowserHive only' },
                ...(channels.data?.data ?? []).map((c) => ({ value: c.channel_id, label: c.name })),
              ],
            },
          ]}
          chips={[
            {
              param: 'kind',
              label: 'Kind',
              options: REPORT_KINDS.map((k) => ({ value: k.value, count: 0 })),
              selected: search.kind ?? [],
              counts: false,
              format: reportKindLabel,
            },
          ]}
          {...(list.data?.page.total !== undefined && { matching: list.data.page.total })}
          onChange={(param, value) => set({ [param]: value })}
          onClear={() => clear(['range'])}
        />
        <DataPanel
          query={list}
          skeleton={
            <Panel padding="none">
              <ListSkeleton rows={6} twoLine />
            </Panel>
          }
          isEmpty={(page) => page.data.length === 0}
          empty={
            filtered ? (
              <EmptyState
                kind="zero-results"
                variant="panel"
                icon="reports"
                title="No reports match"
                description="Try another kind, channel or period."
                onClear={() => clear(['range'])}
              />
            ) : (
              <EmptyState
                kind="zero-data"
                variant="panel"
                icon="reports"
                title="No reports yet"
                description="Switch on a digest or anomaly alerts above, or on a channel. Reports appear here once, whichever channels they reach, and stay after you dismiss them from the inbox."
              />
            )
          }
        >
          {(page) => (
            <div className="flex flex-col gap-4">
              <Panel padding="none" bodyClassName="overflow-hidden rounded-xl">
                <LinkList label="Reports">
                  {page.data.map((item) => (
                    <ReportRow key={item.notification.notification_id} item={item} />
                  ))}
                </LinkList>
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
      </section>
    </div>
  );
}
