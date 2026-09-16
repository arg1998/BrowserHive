/** @module features/sessions/SessionPage — `/sessions/$id`, one workspace: header, attention banner, tabs (Activity · Screenshots · Files & trace · Details) and the Live pane toggled with `L` / `?live=1` — a resizable split beside Activity from 1280px (Live gets 60% by default, and "focus live" collapses Activity to a rail; fixed-height workspace, panes scroll themselves), stacked above it below; a closed session never opens an empty live pane */
import type { SessionDetail } from '@browserhive/contracts/http';
import { useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { useShortcut } from '@/app/providers/KeyboardProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { usePageActions } from '@/app/shell/page-actions.tsx';
import { useWorkspaceLayout } from '@/app/shell/shell-layout.tsx';
import { useShellBand } from '@/app/shell/sidebar-state.ts';
import { Callout } from '@/components/shared/Callout.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { readStorage, writeStorage } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { ActivityPanel } from './activity/ActivityPanel.tsx';
import { useSessionAttentionQuery, useSessionDetailQuery, useVaultEnabled } from './api.ts';
import { AttentionBanner } from './detail/AttentionBanner.tsx';
import { DetailsPanel } from './detail/DetailsPanel.tsx';
import { FilesPanel } from './detail/FilesPanel.tsx';
import { ScreenshotsPanel } from './detail/ScreenshotsPanel.tsx';
import { SessionHeader } from './detail/SessionHeader.tsx';
import { useSessionWarnings } from './detail/use-session-warnings.ts';
import { traceViewerHint, useTraceViewer } from './detail/use-trace-viewer.ts';
import {
  SESSION_TABS,
  type SessionPageSearch,
  type SessionTab,
  tabPatch,
} from './detail-search.ts';
import { LivePane } from './live/LivePane.tsx';
import { takeoverRequest } from './live/live-status.ts';
import { closedReasonText, sessionEnded } from './session-format.ts';

/** Tabs in display order. */
const TAB_LABEL: { readonly [K in SessionTab]: string } = {
  activity: 'Activity',
  screenshots: 'Screenshots',
  files: 'Files & trace',
  details: 'Details',
};

/**
 * localStorage key of the Activity/Live split (percent of the Activity pane). The default is 40%
 * Activity so the frame reads as the subject, not a thumbnail. The `v2` suffix versions the stored
 * value: a ratio stored under another version is ignored.
 */
export const SPLIT_KEY = 'bh.session.split.v2';
/** localStorage key of "focus live" (Activity collapsed to a rail beside the live view). */
export const FOCUS_KEY = 'bh.session.focusLive';
const DEFAULT_SPLIT = 40;
const ACTIVITY_PANEL = 'session-activity';
const LIVE_PANEL = 'session-live';

function readSplit(): number {
  const raw = Number(readStorage(SPLIT_KEY));
  return Number.isFinite(raw) && raw >= 20 && raw <= 70 ? raw : DEFAULT_SPLIT;
}

function isTab(value: unknown): value is SessionTab {
  return typeof value === 'string' && (SESSION_TABS as readonly string[]).includes(value);
}

/** Loading skeleton shaped like header + tabs + rows. */
function SessionSkeleton() {
  return (
    <div
      className="flex flex-col gap-5"
      role="status"
      aria-busy="true"
      aria-label="Loading session"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-96 max-w-[70vw]" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="flex flex-col overflow-hidden rounded-xl border">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={`s${String(i)}`}
            className="flex h-13 items-center gap-3 border-b px-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-16" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="h-4 w-64 max-w-[40vw]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TabBody({
  tab,
  detail,
  pane,
}: {
  readonly tab: SessionTab;
  readonly detail: SessionDetail;
  readonly pane: boolean;
}) {
  switch (tab) {
    case 'activity':
      return <ActivityPanel detail={detail} layout={pane ? 'pane' : 'page'} />;
    case 'screenshots':
      return <ScreenshotsPanel sessionId={detail.session.session_id} />;
    case 'files':
      return <FilesPanel detail={detail} />;
    case 'details':
      return <DetailsPanel detail={detail} />;
    default:
      return null;
  }
}

function readFocus(): boolean {
  return readStorage(FOCUS_KEY) === '1';
}

/** The collapsed Activity pane in "focus live": one way back, labelled. */
function ActivityRail({ onExpand }: { readonly onExpand: () => void }) {
  const Show = ICONS.showPanel;
  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3 rounded-xl border bg-card py-2 shadow-xs dark:shadow-none">
      <Hint label="Show activity" side="right">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Show activity"
          onClick={onExpand}
        >
          <Show aria-hidden="true" />
        </Button>
      </Hint>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="flex-1 cursor-pointer text-sm font-medium text-muted-foreground [writing-mode:vertical-rl] hover:text-foreground"
        onClick={onExpand}
      >
        Activity
      </button>
    </div>
  );
}

/**
 * Activity beside Live (≥1280). Live takes 60% by default; dragging Activity under its minimum, or
 * "Focus the live view", collapses it to a rail and the choice is remembered. The live pane stays
 * mounted through every change, so the stream is never restarted by a layout switch.
 */
function LiveSplit({
  activity,
  live,
}: {
  readonly activity: React.ReactNode;
  readonly live: (focus: {
    readonly on: boolean;
    readonly onToggle: () => void;
  }) => React.ReactNode;
}) {
  const panel = usePanelRef();
  const [focus, setFocus] = useState(readFocus);
  const initial = useRef({ split: readSplit(), focus });
  const toggle = useCallback(() => {
    const handle = panel.current;
    if (handle === null) return;
    if (handle.isCollapsed()) handle.expand();
    else handle.collapse();
  }, [panel]);
  const onResize = useCallback(() => {
    const collapsed = panel.current?.isCollapsed() ?? false;
    setFocus((was) => {
      if (was !== collapsed) writeStorage(FOCUS_KEY, collapsed ? '1' : '0');
      return collapsed;
    });
  }, [panel]);
  return (
    <ResizablePanelGroup
      id="session-live-split"
      className="min-h-0 flex-1"
      onLayoutChanged={(layout, meta) => {
        const share = layout[ACTIVITY_PANEL];
        if (!meta.isUserInteraction || share === undefined) return;
        if (panel.current?.isCollapsed() !== true)
          writeStorage(SPLIT_KEY, String(Math.round(share)));
      }}
    >
      <ResizablePanel
        id={ACTIVITY_PANEL}
        panelRef={panel}
        defaultSize={initial.current.focus ? '4rem' : `${initial.current.split}%`}
        minSize="22rem"
        collapsible
        collapsedSize="4rem"
        onResize={onResize}
        aria-label="Session sections"
        className="min-h-0 min-w-0"
      >
        <div className="h-full min-h-0 pr-3">
          {focus ? <ActivityRail onExpand={toggle} /> : activity}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        id={LIVE_PANEL}
        defaultSize={initial.current.focus ? undefined : `${100 - initial.current.split}%`}
        minSize="26rem"
        aria-label="Live view"
        className="min-h-0 min-w-0"
      >
        <div className="h-full min-h-0 pl-3">{live({ on: focus, onToggle: toggle })}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/** Session workspace. */
export function SessionPage() {
  const id = useParams({ strict: false }).id ?? '';
  const { search, set } = useSearchState<SessionPageSearch>();
  const query = useSessionDetailQuery(id);
  const attention = useSessionAttentionQuery(id, query.isSuccess);
  const vaultEnabled = useVaultEnabled();
  const { warnings, dismiss } = useSessionWarnings(id);
  useTopic('attention');
  const band = useShellBand();
  const wide = band === 'lg' || band === 'wide';
  const session = query.data?.session;
  const liveOpen = search.live === 1;

  // A closed session has nothing to stream: a `?live=1` link opens the page with a one-line
  // notice instead of an empty pane. A session that ends while it is being watched keeps
  // its pane, which shows the ended state over the last frame.
  const watchedLive = useRef(false);
  if (session?.live === true && liveOpen) watchedLive.current = true;
  const [endedNotice, setEndedNotice] = useState(false);
  const staleLiveLink = session !== undefined && !session.live && liveOpen && !watchedLive.current;
  useEffect(() => {
    if (!staleLiveLink) return;
    setEndedNotice(true);
    set({ live: undefined, takeover: undefined, page: search.page });
  }, [staleLiveLink, set, search.page]);

  // `draining` is short; poll until the close lands in case its event was missed.
  const draining = session?.state === 'draining';
  const { refetch } = query;
  useEffect(() => {
    if (!draining) return undefined;
    const timer = setInterval(() => void refetch(), 2000);
    return () => clearInterval(timer);
  }, [draining, refetch]);

  const showLive = liveOpen && !staleLiveLink;
  const split = showLive && wide && query.isSuccess;
  useWorkspaceLayout(split);

  const pending = attention.data?.data ?? [];
  const takeover = session === undefined ? null : takeoverRequest(session, attention.data?.data);

  const toggleLive = useCallback(() => {
    set({ live: liveOpen ? undefined : 1, takeover: undefined, page: search.page });
  }, [set, liveOpen, search.page]);
  const startTakeover = useCallback(() => {
    setEndedNotice(false);
    set({ live: 1, takeover: 1, page: search.page });
  }, [set, search.page]);
  const onArmed = useCallback(
    () => set({ takeover: undefined, page: search.page }),
    [set, search.page],
  );

  const canToggle = session !== undefined && (!sessionEnded(session) || liveOpen);
  useShortcut(
    {
      id: 'session.live',
      combo: 'l',
      description: 'Toggle live view',
      scope: 'page',
      group: 'Session',
      handler: () => {
        toggleLive();
        return undefined;
      },
    },
    canToggle,
  );
  usePageActions(
    useMemo(
      () =>
        canToggle
          ? [
              {
                id: 'session.live',
                label: liveOpen ? 'Hide live view' : 'Show live view',
                icon: 'live' as const,
                hint: 'L',
                run: toggleLive,
              },
            ]
          : [],
      [canToggle, liveOpen, toggleLive],
    ),
  );

  if (query.isPending) return <SessionSkeleton />;
  if (query.isError) {
    const error = toAppError(query.error);
    return (
      <ErrorState
        tier="page"
        error={error}
        {...(error.status === 404 && { title: 'Session not found' })}
        onRetry={() => void query.refetch()}
        escape={{ label: 'Back to sessions', to: '/sessions' }}
      />
    );
  }
  const detail = query.data;
  const current = detail.session;

  const livePane = (
    layout: 'split' | 'stacked',
    focus?: { readonly on: boolean; readonly onToggle: () => void },
  ) => (
    <LivePane
      session={current}
      takeover={takeover}
      gateKnown={attention.isSuccess}
      vaultEnabled={vaultEnabled === true}
      armTakeover={search.takeover === 1}
      onArmed={onArmed}
      onClose={toggleLive}
      layout={layout}
      {...(focus !== undefined && { focus })}
    />
  );

  const tabs = (
    <Tabs
      value={search.tab}
      onValueChange={(value: unknown) => {
        if (isTab(value)) set(tabPatch(value));
      }}
      className={cn('min-w-0 gap-4', split && 'h-full min-h-0')}
    >
      <TabsList variant="line" aria-label="Session sections" className="shrink-0">
        {SESSION_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="flex-none">
            {TAB_LABEL[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent
        value={search.tab}
        className={cn(
          split && 'min-h-0',
          split && search.tab !== 'activity' && 'overflow-y-auto pr-1',
        )}
      >
        <TabBody tab={search.tab} detail={detail} pane={split} />
      </TabsContent>
    </Tabs>
  );

  const Close = ICONS.close;
  return (
    <div className={cn('flex min-w-0 flex-col gap-5', split && 'min-h-0 flex-1')}>
      <SessionHeader detail={detail} live={showLive} tab={search.tab} onToggleLive={toggleLive} />
      {pending.length > 0 ? (
        <AttentionBanner session={current} pending={pending} onTakeover={startTakeover} />
      ) : null}
      {endedNotice && !current.live ? (
        <EndedNotice detail={detail} onDismiss={() => setEndedNotice(false)} />
      ) : null}
      {warnings.map((w) => (
        <Callout
          key={w.code}
          tone="warn"
          title={w.code}
          action={
            <Button type="button" size="sm" variant="ghost" onClick={() => dismiss(w.code)}>
              <Close aria-hidden="true" /> Dismiss
            </Button>
          }
        >
          {w.message}
        </Callout>
      ))}
      {split ? (
        <LiveSplit activity={tabs} live={(focus) => livePane('split', focus)} />
      ) : (
        <>
          {showLive ? livePane('stacked') : null}
          {tabs}
        </>
      )}
    </div>
  );
}

/** One line in place of a live pane for a session that has already closed. */
function EndedNotice({
  detail,
  onDismiss,
}: {
  readonly detail: SessionDetail;
  readonly onDismiss: () => void;
}) {
  const trace = useTraceViewer(detail.session.session_id);
  const hint = traceViewerHint(detail);
  const Close = ICONS.close;
  return (
    <Callout
      tone="info"
      action={
        <span className="flex items-center gap-1">
          {hint.enabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={trace.opening}
              onClick={() => void trace.open()}
            >
              Open trace viewer
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <Close aria-hidden="true" />
          </Button>
        </span>
      }
    >
      No live view: this session has ended. {closedReasonText(detail.session.closed_reason)}.
    </Callout>
  );
}
