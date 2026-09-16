/** @module features/logs/LogsPage — live log console (spec 04 §12.9): a fixed-height workspace whose log pane is the only scroller; header with runtime log level and export; filters (search, level chips, module menu, correlation tokens) with a Live/Pause toggle; newest first with a live tail at the top */
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { usePageActions } from '@/app/shell/page-actions.tsx';
import { useWorkspaceLayout } from '@/app/shell/shell-layout.tsx';
import { PanelBoundary, panelPhase } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar, type FilterToken } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { configValue, useSystemConfig } from './api.ts';
import { LogConsole } from './components/LogConsole.tsx';
import {
  DashboardTrafficSwitch,
  FiltersMenu,
  LiveToggle,
  ModuleMenu,
  moduleOptions,
} from './components/LogFilters.tsx';
import { LogLevelControl } from './components/LogLevelControl.tsx';
import { isDashboardTraffic } from './log-fields.ts';
import {
  hasLogsFilters,
  LOG_LEVELS,
  logsFilters,
  moduleRoot,
  readLogLevel,
} from './log-filters.ts';
import type { LogsSearch } from './search.ts';
import { useLogStream } from './use-log-stream.ts';
import { PHONE_QUERY, useMediaQuery } from './use-media-query.ts';

/** With dashboard traffic hidden, fewer visible records than this walk older pages on their own… */
const AUTO_OLDER_MIN = 40;
/** …but at most this many pages per buffer (1,000 records of a 5,000 ring). */
const AUTO_OLDER_PAGES = 4;

/**
 * Whether dashboard traffic is hidden. A request or trace filter targets specific records, so everything
 * belonging to it shows regardless of the switch.
 */
export function hidesDashboardTraffic(search: LogsSearch): boolean {
  return (
    search.dashboard !== 'show' && search.request_id === undefined && search.trace_id === undefined
  );
}

function SkeletonRows() {
  return (
    <div role="status" aria-label="Loading log records" className="flex flex-col">
      {Array.from({ length: 14 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex h-8 items-center gap-3 border-b border-border/70 px-4">
          <Skeleton className="h-3 w-4" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="hidden h-3 w-28 sm:block" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Logs. */
export function LogsPage() {
  const api = useApi();
  const { search, set, clear } = useSearchState<LogsSearch>();
  useWorkspaceLayout();
  const phone = useMediaQuery(PHONE_QUERY);
  const stream = useLogStream(search);
  const config = useSystemConfig();
  const { buffer } = stream;
  const template = configValue(config.data, 'otelTraceUrlTemplate');
  const traceTemplate = typeof template === 'string' && template !== '' ? template : undefined;
  const level = readLogLevel(configValue(config.data, 'logLevel'));

  // Module roots seen during this visit (records come and go; the menu should not).
  const seenModules = useRef(new Set<string>());
  for (const r of buffer.records) seenModules.current.add(moduleRoot(r.module));
  const modules = moduleOptions(seenModules.current, search.module ?? []);

  // Dashboard traffic is a view filter over the buffer: toggling never refetches.
  const hideReads = hidesDashboardTraffic(search);
  const readsLocked = search.request_id !== undefined || search.trace_id !== undefined;
  const visible = useMemo(
    () => (hideReads ? buffer.records.filter((r) => !isDashboardTraffic(r)) : buffer.records),
    [buffer.records, hideReads],
  );
  const heldVisible = useMemo(
    () =>
      hideReads ? buffer.held.filter((r) => !isDashboardTraffic(r)).length : buffer.held.length,
    [buffer.held, hideReads],
  );
  const hiddenReads = buffer.records.length - visible.length;
  const setShowReads = useCallback(
    (show: boolean) => set({ dashboard: show ? 'show' : undefined }),
    [set],
  );

  // A tail of nothing but dashboard traffic would look empty: walk a few older pages to find real records.
  const { loadOlder, olderPending } = stream;
  const autoPages = useRef({ key: '', pages: 0 });
  if (autoPages.current.key !== buffer.key) autoPages.current = { key: buffer.key, pages: 0 };
  const autoLoading =
    hideReads &&
    buffer.seeded &&
    hiddenReads > 0 &&
    visible.length < AUTO_OLDER_MIN &&
    buffer.olderCursor !== null &&
    autoPages.current.pages < AUTO_OLDER_PAGES;
  useEffect(() => {
    if (!autoLoading || olderPending) return;
    autoPages.current.pages += 1;
    loadOlder();
  }, [autoLoading, olderPending, loadOlder]);

  const paused = buffer.paused;
  const live = stream.tailing && paused === null;
  const { pause, resume, tailing } = stream;
  const toggleLive = useCallback(
    () => (paused === null ? pause('manual') : resume()),
    [paused, pause, resume],
  );
  usePageActions(
    useMemo(
      () => [
        ...(tailing
          ? [
              {
                id: 'logs.live',
                label: paused === null ? 'Pause the log tail' : 'Resume the log tail',
                icon: paused === null ? ('pause' as const) : ('play' as const),
                run: toggleLive,
              },
            ]
          : []),
        ...(readsLocked
          ? []
          : [
              {
                id: 'logs.dashboard',
                label: hideReads
                  ? 'Show dashboard traffic in the log'
                  : 'Hide dashboard traffic in the log',
                icon: hideReads ? ('show' as const) : ('hide' as const),
                keywords: ['http', 'reads', 'requests', 'access', 'noise'],
                run: () => setShowReads(hideReads),
              },
            ]),
      ],
      [paused, tailing, toggleLive, readsLocked, hideReads, setShowReads],
    ),
  );

  const tokens: FilterToken[] = [
    ...(search.module ?? []).map((m) => ({
      key: 'module',
      value: m,
      onRemove: () => {
        const next = (search.module ?? []).filter((x) => x !== m);
        set({ module: next.length === 0 ? undefined : next });
      },
    })),
    ...(search.session_id !== undefined
      ? [
          {
            key: 'session',
            value: search.session_id,
            onRemove: () => set({ session_id: undefined }),
          },
        ]
      : []),
    ...(search.trace_id !== undefined
      ? [{ key: 'trace', value: search.trace_id, onRemove: () => set({ trace_id: undefined }) }]
      : []),
    ...(search.request_id !== undefined
      ? [
          {
            key: 'request',
            value: search.request_id,
            onRemove: () => set({ request_id: undefined }),
          },
        ]
      : []),
  ];

  const exportHref = api.url('exportLogs', undefined, logsFilters(search));
  const phase = panelPhase(stream.head);
  const filtered = hasLogsFilters(search);
  const Download = ICONS.download;

  let body: ReactNode | undefined;
  if (visible.length === 0) {
    if (phase === 'error' && buffer.records.length === 0) {
      body = (
        <ErrorState
          tier="region"
          error={toAppError(stream.head.error)}
          onRetry={() => void stream.head.refetch()}
          className="flex-1"
        />
      );
    } else if (
      phase === 'loading' ||
      phase === 'retrying' ||
      !buffer.seeded ||
      autoLoading ||
      (hiddenReads > 0 && olderPending)
    ) {
      body = (
        <div className="relative">
          <SkeletonRows />
          {phase === 'retrying' ? (
            <div
              role="status"
              className="absolute inset-x-0 top-10 mx-auto flex w-fit items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-popover"
            >
              <Spinner className="size-3.5" />
              {toAppError(stream.head.failureReason).title}: retrying…
            </div>
          ) : null}
        </div>
      );
    } else if (hiddenReads > 0) {
      body = (
        <EmptyState
          kind="zero-data"
          icon="logs"
          title="Only dashboard traffic so far"
          description={`The ${formatNumber(hiddenReads)} newest ${hiddenReads === 1 ? 'record comes' : 'records come'} from open dashboards reading the API. Other records appear here as the daemon writes them.`}
          action={
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowReads(true)}>
                Show dashboard traffic
              </Button>
              {buffer.olderCursor !== null ? (
                <Button type="button" variant="ghost" size="sm" onClick={loadOlder}>
                  Look further back
                </Button>
              ) : null}
            </>
          }
          className="flex-1"
        />
      );
    } else {
      body = (
        <EmptyState
          kind={filtered ? 'zero-results' : 'zero-data'}
          icon="logs"
          title={filtered ? 'No records match these filters' : 'No log records yet'}
          description={
            stream.tailing
              ? 'Matching records appear here as the daemon writes them.'
              : 'Nothing was logged in this time window.'
          }
          onClear={() => clear()}
          className="flex-1"
        />
      );
    }
  }

  const exportLink = (
    <Hint label="Download the matching records as NDJSON">
      <a
        href={exportHref}
        download="logs.ndjson"
        aria-label={phone ? 'Export matching records' : undefined}
        className={buttonVariants({ variant: 'outline', size: phone ? 'icon' : 'sm' })}
      >
        <Download aria-hidden="true" />
        {phone ? null : 'Export'}
      </a>
    </Hint>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="Logs"
        description="The daemon's log ring, newest first, tailed live."
        learnMore={
          <>
            The ring holds the most recent 5,000 records. New records stream in at the top while
            Live is on; scroll down to read and the tail pauses, holding new records until you
            return. Dashboard traffic (API reads and socket connects from open dashboards) is hidden
            unless you turn it on. Export downloads every matching record as NDJSON, dashboard
            traffic included.
          </>
        }
        // On phones the header actions join the toolbar row instead of taking a row of their own.
        {...(!phone && {
          actions: (
            <>
              <LogLevelControl current={level} />
              {exportLink}
            </>
          ),
        })}
      />
      <FilterBar
        search={{ param: 'q', placeholder: 'Search messages and fields…', value: search.q }}
        chips={
          phone
            ? []
            : [
                {
                  param: 'level',
                  label: 'Level',
                  counts: false,
                  options: LOG_LEVELS.map((value) => ({ value, count: 0 })),
                  selected: search.level ?? [],
                },
              ]
        }
        range={
          phone ? (
            <FiltersMenu
              levels={search.level ?? []}
              onLevelsChange={(next) => set({ level: next })}
              modules={search.module ?? []}
              moduleChoices={modules}
              onModulesChange={(next) => set({ module: next })}
              showReads={!hideReads}
              onShowReadsChange={setShowReads}
              readsLocked={readsLocked}
            />
          ) : (
            <>
              <ModuleMenu
                options={modules}
                selected={search.module ?? []}
                onChange={(next) => set({ module: next })}
              />
              {readsLocked ? null : (
                <DashboardTrafficSwitch show={!hideReads} onChange={setShowReads} />
              )}
            </>
          )
        }
        end={
          <>
            {phone ? (
              <>
                <LogLevelControl current={level} compact />
                {exportLink}
              </>
            ) : null}
            {tailing ? <LiveToggle live={live} onToggle={toggleLive} /> : null}
          </>
        }
        tokens={tokens}
        onChange={(param, value) => set({ [param]: value })}
        onClear={() => clear()}
      />
      <PanelBoundary resetKey={buffer.key}>
        <LogConsole
          records={visible}
          held={heldVisible}
          hidden={hiddenReads}
          onShowHidden={() => setShowReads(true)}
          paused={paused}
          tailing={stream.tailing}
          connection={stream.connection}
          received={buffer.received}
          olderCursor={buffer.olderCursor}
          olderPending={stream.olderPending}
          truncated={buffer.truncated}
          gap={stream.gap}
          traceTemplate={traceTemplate}
          onPause={stream.pause}
          onResume={stream.resume}
          onLoadOlder={stream.loadOlder}
          {...(body !== undefined && { body })}
        />
      </PanelBoundary>
    </div>
  );
}
