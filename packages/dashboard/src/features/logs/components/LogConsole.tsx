/** @module features/logs/components/LogConsole — the log pane: status strip (live/paused/reconnecting, record count, "N new" resume), column header, the virtualised newest-first list (the pane is the only scroller), "Load older" at the end. Scrolling away from the newest record pauses the tail only on real user input (wheel, touch, keys, scrollbar drag), never on layout measurement. */
import type { LogRecord } from '@browserhive/contracts/http';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { StatusDot } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import type { StatusEntry } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import type { SocketStatus } from '@/lib/ws/store.ts';
import type { PauseReason } from '../log-buffer.ts';
import { formatLogTime, LOG_GRID, LogRow } from './LogRow.tsx';

/** Estimated collapsed row height (px) before measurement. */
const ROW_ESTIMATE = 33;
/** Rows rendered without virtualisation while the scroll element has no layout (first paint, tests). */
const NO_LAYOUT_ROWS = 200;
/** Scrolled further than this from the top counts as "away from the newest record". */
const AWAY_PX = 24;
/** How long a wheel/touch/key/pointer event marks the next scroll events as user-driven. */
const INTENT_MS = 1000;

/** Status line for the strip. */
export function consoleStatus(input: {
  readonly tailing: boolean;
  readonly connection: SocketStatus;
  readonly paused: PauseReason | null;
}): StatusEntry & { readonly pulse: boolean } {
  if (!input.tailing)
    return { label: 'Time window closed, not tailing', tone: 'neutral', pulse: false };
  if (input.connection === 'connecting')
    return { label: 'Reconnecting…', tone: 'warn', pulse: true };
  if (input.connection === 'offline' || input.connection === 'idle')
    return { label: 'Offline', tone: 'danger', pulse: false };
  if (input.paused === 'manual') return { label: 'Paused', tone: 'neutral', pulse: false };
  if (input.paused === 'scroll')
    return { label: 'Paused while you read', tone: 'neutral', pulse: false };
  return { label: 'Live', tone: 'success', pulse: true };
}

/** Props. */
export interface LogConsoleProps {
  readonly records: readonly LogRecord[];
  readonly held: number;
  /** Records in the buffer hidden by the dashboard traffic view filter. */
  readonly hidden?: number;
  readonly onShowHidden?: () => void;
  readonly paused: PauseReason | null;
  readonly tailing: boolean;
  readonly connection: SocketStatus;
  readonly received: number;
  readonly olderCursor: string | null;
  readonly olderPending: boolean;
  readonly truncated: boolean;
  readonly gap: boolean;
  readonly traceTemplate: string | undefined;
  readonly onPause: (reason: PauseReason) => void;
  readonly onResume: () => void;
  readonly onLoadOlder: () => void;
  /** Replaces the list (skeleton, empty, error) while keeping the strip and header. */
  readonly body?: ReactNode;
}

/** Log console. */
export function LogConsole({
  records,
  held,
  hidden = 0,
  onShowHidden,
  paused,
  tailing,
  connection,
  received,
  olderCursor,
  olderPending,
  truncated,
  gap,
  traceTemplate,
  onPause,
  onResume,
  onLoadOlder,
  body,
}: LogConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 16,
    getItemKey: (index) => records[index]?.seq ?? index,
  });

  // User intent: only these inputs may pause or resume the tail from scrolling.
  const intentAt = useRef(0);
  const markIntent = useCallback(() => {
    intentAt.current = performance.now();
  }, []);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null || el.clientHeight === 0) return;
    if (performance.now() - intentAt.current > INTENT_MS) return;
    if (el.scrollTop > AWAY_PX) {
      if (paused === null && tailing) onPause('scroll');
    } else if (el.scrollTop <= 1 && paused === 'scroll') {
      onResume();
    }
  }, [paused, tailing, onPause, onResume]);

  // Resuming returns the reader to the newest record.
  const wasPaused = useRef(paused);
  useEffect(() => {
    if (wasPaused.current !== null && paused === null) scrollRef.current?.scrollTo({ top: 0 });
    wasPaused.current = paused;
  }, [paused]);

  const toggle = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  const status = consoleStatus({ tailing, connection, paused });
  const oldest = records[records.length - 1];
  const items = virtualizer.getVirtualItems();
  const noLayout = (virtualizer.scrollRect?.height ?? 0) === 0;
  const ArrowUp = ICONS.chevronUp;

  const row = (record: LogRecord) => (
    <LogRow
      record={record}
      expanded={expanded.has(record.seq)}
      onToggle={toggle}
      traceTemplate={traceTemplate}
    />
  );

  const footer = (
    <div className="flex min-h-14 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-3 text-sm text-muted-foreground">
      {olderCursor !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={olderPending}
          onClick={onLoadOlder}
        >
          {olderPending ? <Spinner /> : <ICONS.chevronDown aria-hidden="true" />}
          Load older records
        </Button>
      ) : truncated ? (
        <span>Showing the newest {formatNumber(records.length)} records.</span>
      ) : (
        <span>Start of the log buffer</span>
      )}
    </div>
  );

  return (
    <section
      aria-label="Log console"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none"
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5">
        {status.label !== 'Live' ? (
          <StatusDot entry={status} pulse={status.pulse} className="text-sm" />
        ) : null}
        <span className="text-sm text-muted-foreground tabular-nums">
          {formatNumber(records.length)} {records.length === 1 ? 'record' : 'records'}
          {oldest !== undefined ? (
            <span className="hidden sm:inline">
              {' '}
              · since {formatLogTime(oldest.ts).slice(0, 8)}
            </span>
          ) : null}
          {received > 0 ? (
            <span className="hidden md:inline"> · {formatNumber(received)} received live</span>
          ) : null}
          {hidden > 0 ? (
            <>
              {' '}
              · {formatNumber(hidden)} dashboard {hidden === 1 ? 'record' : 'records'} hidden
              {onShowHidden !== undefined ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="relative cursor-pointer rounded-xs font-medium text-link underline-offset-4 focus-ring after:absolute after:-inset-x-1 after:-inset-y-2.5 hover:underline"
                    onClick={onShowHidden}
                  >
                    Show
                  </button>
                </>
              ) : null}
            </>
          ) : null}
        </span>
        {gap ? (
          <span className="text-sm text-warn-text">Some records were missed while offline</span>
        ) : null}
        {paused !== null && tailing ? (
          <Button
            type="button"
            size="xs"
            variant={held > 0 ? 'default' : 'outline'}
            className="ml-auto"
            onClick={onResume}
          >
            <ArrowUp aria-hidden="true" />
            {held > 0
              ? `${formatNumber(held)} new ${held === 1 ? 'record' : 'records'}`
              : 'Back to live'}
          </Button>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'hidden h-9 shrink-0 border-b bg-muted/50 px-4 text-sm font-medium text-muted-foreground dark:bg-white/[0.02]',
          LOG_GRID,
        )}
      >
        <span />
        <span>Time</span>
        <span>Level</span>
        <span>Module</span>
        <span>Message</span>
      </div>
      {body !== undefined ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
      ) : (
        <div
          ref={scrollRef}
          role="log"
          aria-label="Log records"
          aria-live="off"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must be keyboard-scrollable
          tabIndex={0}
          onScroll={onScroll}
          onWheel={markIntent}
          onTouchStart={markIntent}
          onTouchMove={markIntent}
          onPointerDown={markIntent}
          onKeyDown={markIntent}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {noLayout ? (
            records
              .slice(0, NO_LAYOUT_ROWS)
              .map((record) => <div key={record.seq}>{row(record)}</div>)
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {items.map((item) => {
                const record = records[item.index];
                if (record === undefined) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {row(record)}
                  </div>
                );
              })}
            </div>
          )}
          {footer}
        </div>
      )}
    </section>
  );
}
