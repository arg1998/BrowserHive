/** @module features/sessions/activity/ActivityPanel — the Activity tab: one stream of tool calls, page visits, attention, vault fills and blocked requests with kind chips (a chip only for kinds this session has, a count only where one exists), errors-only, server search, follow-latest and a list/table view (list only under 640px, where a table cannot fit); rows expand inline */
import type { SessionDetail, TimelineKind } from '@browserhive/contracts/http';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcut } from '@/app/providers/KeyboardProvider.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { useDebouncedSearch } from '@/components/shared/FilterBar.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { readStorage, writeStorage } from '@/lib/storage.ts';
import { cn } from '@/lib/utils.ts';
import { ACTIVITY_VIEWS, type ActivityView, type SessionPageSearch } from '../detail-search.ts';
import { ActivityStream } from './ActivityStream.tsx';
import { ACTIVITY_KINDS, type ActivityEntry, toggleKind } from './activity-model.ts';
import { useActivityFeed } from './use-activity-feed.ts';

/** localStorage key for the preferred view when the URL has none. */
export const ACTIVITY_VIEW_KEY = 'bh.activity.view';

/** Below this container width the table cannot fit its columns: the stream shows the list. */
export const TABLE_MIN_WIDTH = 640;

/** Whether `ref` is narrower than `min` pixels (measured at once, then on every resize). */
function useNarrower(ref: React.RefObject<HTMLElement | null>, min: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < min);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, min]);
  return narrow;
}

/** Props. */
export interface ActivityPanelProps {
  readonly detail: SessionDetail;
  /** `pane`: fills a fixed-height workspace pane and scrolls itself. */
  readonly layout: 'page' | 'pane';
}

/**
 * Hold newer rows back while the reader is away from the top (or follow is off), so the rows they
 * are reading never move. Returns the rows to show and how many newer ones wait behind the pill.
 */
export function holdNewRows(
  entries: readonly ActivityEntry[],
  heldHead: string | null,
): { readonly shown: readonly ActivityEntry[]; readonly held: number } {
  if (heldHead === null) return { shown: entries, held: 0 };
  const index = entries.findIndex((entry) => entry.id === heldHead);
  if (index <= 0) return { shown: entries, held: 0 };
  return { shown: entries.slice(index), held: index };
}

function KindChip({
  label,
  count,
  pressed,
  tone,
  onClick,
}: {
  readonly label: string;
  readonly count?: number | undefined;
  readonly pressed: boolean;
  readonly tone?: 'danger';
  readonly onClick: () => void;
}) {
  const Check = ICONS.check;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-sm whitespace-nowrap transition-colors duration-(--duration-fast) focus-ring pointer-coarse:h-10 pointer-coarse:px-3.5',
        pressed
          ? tone === 'danger'
            ? 'border-danger-border bg-danger-bg font-medium text-danger-text hover:bg-danger-bg-hover'
            : 'border-accent-border bg-accent-bg font-medium text-accent-text hover:bg-accent-bg-hover'
          : 'border-input bg-card text-foreground hover:border-border-strong hover:bg-accent dark:bg-transparent',
      )}
      onClick={onClick}
    >
      {pressed ? <Check aria-hidden="true" className="-ml-0.5 size-3.5" /> : null}
      {label}
      {count !== undefined && count > 0 ? (
        <span
          className={cn(
            'text-xs tabular-nums',
            pressed
              ? 'opacity-80'
              : tone === 'danger'
                ? 'text-danger-text'
                : 'text-muted-foreground',
          )}
        >
          {formatNumber(count)}
        </span>
      ) : null}
    </button>
  );
}

/** Kind counts from the (live) session counts; attention has no total. */
function kindCount(detail: SessionDetail, kind: TimelineKind): number | undefined {
  switch (kind) {
    case 'tool':
      return detail.counts.tool_calls;
    case 'page':
      return detail.counts.pages;
    case 'vault':
      return detail.counts.vault_access;
    case 'blocked':
      return detail.counts.blocked;
    default:
      return undefined;
  }
}

/** Activity tab. */
export function ActivityPanel({ detail, layout }: ActivityPanelProps) {
  const session = detail.session;
  const id = session.session_id;
  const { search, set } = useSearchState<SessionPageSearch>();
  const now = useServerNow();
  const errorsOnly = search.errors_only === 1;
  const panelRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrower(panelRef, TABLE_MIN_WIDTH);
  const storedView = readStorage(ACTIVITY_VIEW_KEY);
  const preferred: ActivityView =
    search.view ?? ACTIVITY_VIEWS.find((v) => v === storedView) ?? 'list';
  const view: ActivityView = narrow ? 'list' : preferred;
  const feed = useActivityFeed(id, { kinds: search.kinds, errorsOnly, q: search.q });
  const open = useMemo(() => new Set(search.open ?? []), [search.open]);

  // Follow latest: new rows appear on top only while the reader is at the top and follow is on.
  const [follow, setFollow] = useState(true);
  const atTop = useRef(true);
  const [heldHead, setHeldHead] = useState<string | null>(null);
  const head = feed.entries[0]?.id ?? null;
  const shownHead = useRef<string | null>(null);
  useEffect(() => {
    if (head === null) return;
    const previous = shownHead.current;
    const stillThere = previous !== null && feed.entries.some((e) => e.id === previous);
    if (previous !== null && previous !== head && stillThere && (!follow || !atTop.current)) {
      setHeldHead((current) => current ?? previous);
      return;
    }
    shownHead.current = head;
  }, [head, feed.entries, follow]);
  const { shown, held } = holdNewRows(feed.entries, heldHead);
  const release = useCallback(() => {
    setHeldHead(null);
    shownHead.current = null;
  }, []);
  const onAtTop = useCallback(
    (value: boolean) => {
      atTop.current = value;
      if (value && follow && heldHead !== null) release();
    },
    [follow, heldHead, release],
  );
  useEffect(() => {
    if (held === 0 && heldHead !== null) setHeldHead(null);
  }, [held, heldHead]);

  const onToggle = useCallback(
    (entryId: string) => {
      const next = new Set(open);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      set({ open: next.size === 0 ? undefined : [...next], page: search.page });
    },
    [open, set, search.page],
  );

  const filtered = search.kinds !== undefined || errorsOnly || search.q !== undefined;
  const clearFilters = () =>
    set({ kinds: undefined, errors_only: undefined, q: undefined, open: undefined });

  const body = feed.query.isPending ? (
    <div className="flex flex-col rounded-xl border bg-card" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={`s${String(i)}`}
          className="flex h-13 items-center gap-3 border-b px-4 last:border-b-0"
        >
          <Skeleton className="h-4 w-16" />
          <Skeleton className="size-7 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  ) : feed.query.isError ? (
    <ErrorState
      tier="region"
      error={toAppError(feed.query.error)}
      onRetry={() => void feed.query.refetch()}
    />
  ) : shown.length === 0 ? (
    <div className="rounded-xl border bg-card">
      {filtered ? (
        <EmptyState
          kind="zero-results"
          title="No activity matches these filters"
          description="Clear the filters to see every event of this session."
          onClear={clearFilters}
        />
      ) : (
        <EmptyState
          kind="zero-data"
          icon="activity"
          title={session.live ? 'Waiting for the agent' : 'No activity recorded'}
          description={
            session.live
              ? 'Tool calls, page visits and attention requests appear here as the agent works.'
              : 'This session ended without recording any tool calls or page visits.'
          }
        />
      )}
    </div>
  ) : (
    <ActivityStream
      sessionId={id}
      entries={shown}
      now={now}
      view={view}
      open={open}
      onToggle={onToggle}
      newCount={held}
      onShowNew={release}
      onAtTop={onAtTop}
      hasMore={feed.hasMore}
      loadingMore={feed.loadingMore}
      onLoadMore={() => void feed.loadMore()}
      scroll={layout === 'pane' ? 'pane' : 'window'}
    />
  );

  return (
    <div
      ref={panelRef}
      data-activity-panel=""
      className={cn(
        '@container flex min-w-0 flex-col gap-3',
        layout === 'pane' && 'h-full min-h-0',
      )}
    >
      <ActivityToolbar
        detail={detail}
        search={search}
        errorsOnly={errorsOnly}
        view={view}
        canTable={!narrow}
        attentionShown={feed.entries.some((e) => e.item.kind === 'attention')}
        follow={follow}
        onFollow={(on) => {
          setFollow(on);
          if (on && atTop.current) release();
        }}
        onChange={set}
      />
      {body}
    </div>
  );
}

function ActivityToolbar({
  detail,
  search,
  errorsOnly,
  view,
  canTable,
  attentionShown,
  follow,
  onFollow,
  onChange,
}: {
  readonly detail: SessionDetail;
  readonly search: SessionPageSearch;
  readonly errorsOnly: boolean;
  readonly view: ActivityView;
  /** The container fits the table view (the toggle is hidden otherwise). */
  readonly canTable: boolean;
  /** An attention request is among the loaded rows (sessions carry no attention total). */
  readonly attentionShown: boolean;
  readonly follow: boolean;
  readonly onFollow: (on: boolean) => void;
  readonly onChange: (patch: Partial<Record<keyof SessionPageSearch & string, unknown>>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useDebouncedSearch(search.q ?? '', (value) =>
    onChange({ q: value, open: undefined }),
  );
  useShortcut({
    id: 'filter.focus',
    combo: '/',
    description: 'Search activity',
    scope: 'page',
    group: 'Page',
    handler: () => {
      inputRef.current?.focus();
      return undefined;
    },
  });
  const SearchIcon = ICONS.search;
  const Close = ICONS.close;
  const ListIcon = ICONS.list;
  const TableIcon = ICONS.table;
  const errors = detail.counts.errors;
  // A chip only for kinds this session has (or that are selected): no "Blocked 0" or "Vault 0".
  // Attention has no total on the session, so its chip shows without a count, and only when a
  // request exists.
  const has = (kind: TimelineKind): boolean => {
    if (search.kinds?.includes(kind) === true) return true;
    if (kind === 'attention') return attentionShown || detail.counts.attention_open > 0;
    return (kindCount(detail, kind) ?? 0) > 0;
  };
  const shownKinds = ACTIVITY_KINDS.filter((kind) => has(kind.value));
  const showErrors = errors > 0 || errorsOnly;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
      role="toolbar"
      aria-label="Activity filters"
    >
      <div className="relative order-1 flex w-full min-w-0 items-center @lg:w-auto @lg:flex-1 @3xl:max-w-72 @3xl:flex-none @3xl:basis-64">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
        />
        <label htmlFor="activity-search" className="sr-only">
          Search activity
        </label>
        <Input
          id="activity-search"
          ref={inputRef}
          type="search"
          size="sm"
          placeholder="Search tools, URLs, errors…"
          className="data-[size=sm]:pr-8 data-[size=sm]:pl-8"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && draft !== '') {
              event.stopPropagation();
              setDraft('');
            }
          }}
        />
        {draft === '' ? (
          <Kbd className="pointer-events-none absolute right-2 hidden sm:inline-flex">/</Kbd>
        ) : (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute right-1 flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setDraft('');
              inputRef.current?.focus();
            }}
          >
            <Close aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {shownKinds.length > 0 || showErrors ? (
        <fieldset className="order-3 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 @lg:basis-full @3xl:order-2 @3xl:basis-auto">
          <legend className="sr-only">Event kinds (none selected shows every kind)</legend>
          {shownKinds.map((kind) => (
            <KindChip
              key={kind.value}
              label={kind.label}
              count={kindCount(detail, kind.value)}
              pressed={search.kinds?.includes(kind.value) ?? false}
              onClick={() =>
                onChange({ kinds: toggleKind(search.kinds, kind.value), open: undefined })
              }
            />
          ))}
          {showErrors ? (
            <>
              {shownKinds.length > 0 ? (
                <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
              ) : null}
              <KindChip
                label="Errors"
                count={errors}
                tone="danger"
                pressed={errorsOnly}
                onClick={() =>
                  onChange({ errors_only: errorsOnly ? undefined : 1, open: undefined })
                }
              />
            </>
          ) : null}
        </fieldset>
      ) : null}
      <div className="order-4 ml-auto flex shrink-0 items-center gap-3 @lg:order-2 @3xl:order-3">
        {detail.session.live ? (
          <Hint label="Show new events as they arrive while you are at the top">
            <label
              htmlFor="activity-follow"
              className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground select-none hover:text-foreground"
            >
              <Switch
                id="activity-follow"
                aria-label="Follow new events"
                size="sm"
                checked={follow}
                onCheckedChange={(on: boolean) => onFollow(on)}
              />
              Follow
            </label>
          </Hint>
        ) : null}
        {canTable ? (
          <ToggleGroup
            aria-label="Activity view"
            size="sm"
            spacing={0}
            value={[view]}
            onValueChange={(value: readonly string[]) => {
              const next = ACTIVITY_VIEWS.find((v) => v === value[0]);
              if (next === undefined) return;
              writeStorage(ACTIVITY_VIEW_KEY, next);
              onChange({ view: next === 'list' ? undefined : next, page: search.page });
            }}
          >
            <Hint label="List">
              <ToggleGroupItem value="list" aria-label="List view" className="px-2">
                <ListIcon aria-hidden="true" />
              </ToggleGroupItem>
            </Hint>
            <Hint label="Table">
              <ToggleGroupItem value="table" aria-label="Table view" className="px-2">
                <TableIcon aria-hidden="true" />
              </ToggleGroupItem>
            </Hint>
          </ToggleGroup>
        ) : null}
      </div>
    </div>
  );
}
