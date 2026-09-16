/** @module features/sessions/activity/ActivityStream — virtualised Activity rows (TanStack Virtual): on the page scroller in the document layout, or as its own scroll pane in the live workspace; sticky table header, "N new events" pill, loads older pages at the end; roving focus with j/k (↑/↓), Home/End and Enter/Space to expand */
import { useVirtualizer, useWindowVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import type { ActivityView } from '../detail-search.ts';
import { ActivityRow, TABLE_COLUMNS } from './ActivityRow.tsx';
import { type ActivityEntry, describeEntry } from './activity-model.ts';

/** Props. */
export interface ActivityStreamProps {
  readonly sessionId: string;
  readonly entries: readonly ActivityEntry[];
  readonly now: number;
  readonly view: ActivityView;
  readonly open: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  /** Newer events held back while the reader is away from the top. */
  readonly newCount: number;
  readonly onShowNew: () => void;
  /** Reports whether the newest row is in view (drives follow). */
  readonly onAtTop: (atTop: boolean) => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  /** `window`: rows scroll with the page. `pane`: the stream is its own scroller (workspace). */
  readonly scroll: 'window' | 'pane';
  readonly className?: string;
}

/**
 * Row height estimates (rows are measured after render). List rows are 57px whether or not they have
 * a second line; errors and reasons may wrap to a third (estimates match the real shapes, so
 * a row entering the list never nudges its neighbours once it is measured).
 */
function estimate(entry: ActivityEntry | undefined, view: 'list' | 'table'): number {
  if (view === 'table' || entry === undefined) return view === 'table' ? 41 : 57;
  const secondary = describeEntry(entry).secondary;
  const long =
    secondary !== undefined &&
    secondary.type !== 'url' &&
    (secondary.type === 'text' ? secondary.text : `${secondary.code} ${secondary.message}`).length >
      72;
  return long ? 77 : 57;
}

/** Stream. */
export function ActivityStream(props: ActivityStreamProps) {
  return props.scroll === 'pane' ? <PaneStream {...props} /> : <WindowStream {...props} />;
}

function WindowStream(props: ActivityStreamProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null) return undefined;
    const measure = () => setMargin(el.getBoundingClientRect().top + window.scrollY);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: props.entries.length,
    estimateSize: (index) => estimate(props.entries[index], props.view),
    getItemKey: (index) => props.entries[index]?.id ?? index,
    overscan: 8,
    scrollMargin: margin,
  });
  const { onAtTop } = props;
  useEffect(() => {
    // The newest row is "in view" while the list's top edge is still below the sticky topbar.
    const onScroll = () => onAtTop((listRef.current?.getBoundingClientRect().top ?? 0) >= 48);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [onAtTop]);
  const scrollTop = useCallback(() => {
    const panel = listRef.current?.closest('[data-activity-panel]') ?? listRef.current;
    if (panel === null || panel === undefined) return;
    const top = Math.max(0, panel.getBoundingClientRect().top + window.scrollY - 72);
    if (window.scrollY <= top) return;
    // After the held rows render (the virtualizer re-measures them first).
    window.scrollTo({ top });
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top })));
  }, []);
  return (
    <Surface
      {...props}
      listRef={listRef}
      virtualizer={virtualizer}
      margin={margin}
      onScrollTop={scrollTop}
    />
  );
}

function PaneStream(props: ActivityStreamProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.entries.length,
    getScrollElement: () => paneRef.current,
    estimateSize: (index) => estimate(props.entries[index], props.view),
    getItemKey: (index) => props.entries[index]?.id ?? index,
    overscan: 8,
    initialRect: { width: 600, height: 800 },
  });
  const { onAtTop } = props;
  const scrollTop = useCallback(() => {
    paneRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => requestAnimationFrame(() => paneRef.current?.scrollTo({ top: 0 })));
  }, []);
  return (
    <div
      ref={paneRef}
      className={cn(
        'min-h-0 flex-1 overflow-y-auto rounded-xl border bg-card shadow-xs dark:shadow-none',
        props.className,
      )}
      onScroll={(event) => onAtTop(event.currentTarget.scrollTop < 8)}
    >
      <Surface
        {...props}
        className=""
        bare
        listRef={listRef}
        virtualizer={virtualizer}
        margin={0}
        onScrollTop={scrollTop}
      />
    </div>
  );
}

function Surface({
  sessionId,
  entries,
  now,
  view,
  open,
  onToggle,
  newCount,
  onShowNew,
  hasMore,
  loadingMore,
  onLoadMore,
  className,
  bare = false,
  listRef,
  virtualizer,
  margin,
  onScrollTop,
}: ActivityStreamProps & {
  readonly bare?: boolean;
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly virtualizer: Virtualizer<Window, Element> | Virtualizer<HTMLDivElement, Element>;
  readonly margin: number;
  readonly onScrollTop: () => void;
}) {
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  // Roving focus: one row toggle is tabbable; j/k (or ↑/↓), Home/End move it, scrolling the row into
  // view first when it is virtualised away.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusIndex = focusId === null ? -1 : entries.findIndex((e) => e.id === focusId);
  const renderedFocus = items.some((v) => v.index === focusIndex);
  const tabbableIndex = renderedFocus ? focusIndex : (items[0]?.index ?? 0);
  const moveFocus = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(entries.length - 1, index));
      const entry = entries[next];
      if (entry === undefined) return;
      setFocusId(entry.id);
      const focusRow = () =>
        listRef.current
          ?.querySelector<HTMLButtonElement>(`[data-index="${next}"] [data-row-toggle]`)
          ?.focus({ preventScroll: false });
      const row = listRef.current?.querySelector(`[data-index="${next}"]`);
      if (row === null || row === undefined) {
        virtualizer.scrollToIndex(next, { align: 'auto' });
        requestAnimationFrame(() => requestAnimationFrame(focusRow));
      } else {
        row.scrollIntoView({ block: 'nearest' });
        focusRow();
      }
    },
    [entries, listRef, virtualizer],
  );
  const onRowKeyDown = useCallback(
    (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const go = (to: number) => {
        event.preventDefault();
        moveFocus(to);
      };
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          return go(index + 1);
        case 'k':
        case 'ArrowUp':
          return go(index - 1);
        case 'Home':
          return go(0);
        case 'End':
          return go(entries.length - 1);
        default:
          return undefined;
      }
    },
    [moveFocus, entries.length],
  );
  useEffect(() => {
    if (last !== undefined && last.index >= entries.length - 1 && hasMore && !loadingMore)
      onLoadMore();
  }, [last, entries.length, hasMore, loadingMore, onLoadMore]);
  const ArrowUp = ICONS.sortAsc;
  return (
    <section
      aria-label="Activity"
      className={cn(
        '@container relative min-w-0',
        !bare && 'rounded-xl border bg-card shadow-xs dark:shadow-none',
        className,
      )}
    >
      {newCount > 0 ? (
        <div className="pointer-events-none sticky top-[calc(var(--table-sticky-top,var(--topbar-height))+2.75rem)] z-20 flex h-0 justify-center">
          <Button
            type="button"
            size="sm"
            className="pointer-events-auto mt-2 rounded-full shadow-md"
            onClick={() => {
              onShowNew();
              onScrollTop();
            }}
          >
            <ArrowUp aria-hidden="true" />
            {formatNumber(newCount)} new {newCount === 1 ? 'event' : 'events'}
          </Button>
        </div>
      ) : null}
      {view === 'table' ? <TableHeader /> : null}
      <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((virtual) => {
          const entry = entries[virtual.index];
          if (entry === undefined) return null;
          return (
            <div
              key={virtual.key}
              data-index={virtual.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtual.start - margin}px)` }}
            >
              <ActivityRow
                sessionId={sessionId}
                entry={entry}
                now={now}
                view={view}
                expanded={open.has(entry.id)}
                onToggle={onToggle}
                tabbable={virtual.index === tabbableIndex}
                onFocusRow={() => setFocusId(entry.id)}
                onRowKeyDown={onRowKeyDown(virtual.index)}
              />
            </div>
          );
        })}
      </div>
      <StreamFooter hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </section>
  );
}

function TableHeader() {
  const cell = 'text-sm font-medium text-muted-foreground';
  return (
    <div
      role="presentation"
      className="sticky top-(--table-sticky-top,var(--topbar-height)) z-10 flex h-10 items-center gap-3 rounded-t-xl border-b bg-card px-4"
    >
      <span className={cn(cell, TABLE_COLUMNS.time)}>Time</span>
      <span className={cn(cell, 'shrink-0 pl-7', TABLE_COLUMNS.event)}>Event</span>
      <span className={cn(cell, 'min-w-0 flex-1')}>Details</span>
      <span className={cn(cell, 'shrink-0', TABLE_COLUMNS.status)}>
        <span className="sr-only">Status</span>
      </span>
      <span className={cn(cell, 'shrink-0', TABLE_COLUMNS.duration)}>Duration</span>
      <span className={cn(cell, 'shrink-0', TABLE_COLUMNS.size)}>Size</span>
      <span className="w-5.5 shrink-0" />
    </div>
  );
}

function StreamFooter({
  hasMore,
  loading,
  onLoadMore,
}: {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}): ReactNode {
  return (
    <div className="flex h-11 items-center justify-center text-sm text-muted-foreground">
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <Spinner className="size-4" /> Loading older activity…
        </span>
      ) : hasMore ? (
        <Button type="button" variant="ghost" size="sm" onClick={onLoadMore}>
          Load older activity
        </Button>
      ) : (
        <span>Start of the session</span>
      )}
    </div>
  );
}
