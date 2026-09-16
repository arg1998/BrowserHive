/** @module features/attention/HistoryTable — settled requests: FilterBar (search, Mode and Outcome chips with API facet counts, session token, time range) + DataTable whose rows expand on click into the full decision record (reason, message, page, tool, resolution, options) (spec 04 §12.4) */
import type { Facet, OperatorRequestRow } from '@browserhive/contracts/http';
import { useState } from 'react';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { KeyValue } from '@/components/shared/KeyValue.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { buttonVariants } from '@/components/ui/button.tsx';
import { formatAbsolute, formatDuration } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { cn } from '@/lib/utils.ts';
import { useAttentionHistory } from './api.ts';
import {
  ATTENTION_SORT_KEYS,
  type AttentionSearch,
  hasHistoryFilters,
  SETTLED_STATUSES,
} from './search.ts';
import { sessionHref } from './session-link.ts';

const MODE_LABEL: Record<string, string> = { takeover: 'Take over', notify: 'Notify' };
const STATUS_LABEL: Record<string, string> = {
  resolved: 'Resolved',
  rejected: 'Rejected',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
};

/**
 * Chip options for a facet dimension: every known value in `values` order, with the API count
 * (the server omits zero counts, so missing values read 0).
 */
export function facetOptions(
  facets: readonly Facet[] | undefined,
  values: readonly string[],
): Facet[] {
  return values.map((value) => ({
    value,
    count: facets?.find((f) => f.value === value)?.count ?? 0,
  }));
}

/** Expanded row: the full decision record. */
function RowDetail({ row }: { readonly row: OperatorRequestRow }) {
  const go = useHrefNavigate();
  const href = sessionHref(row.session_id);
  const Arrow = ICONS.arrowRight;
  const hasOptions =
    row.options !== null &&
    row.options !== undefined &&
    (typeof row.options !== 'object' || Object.keys(row.options).length > 0);
  return (
    <div className="flex flex-col gap-4 py-2 text-base">
      <p className="font-medium text-pretty break-words">{row.reason}</p>
      <KeyValue
        columns={2}
        items={[
          {
            key: 'Message to agent',
            value: row.message !== null && row.message !== '' ? row.message : '—',
          },
          { key: 'Resolution', value: row.resolution_reason ?? '—' },
          { key: 'Page', value: <UrlCell url={row.page_url} head={40} tail={20} /> },
          { key: 'Tool', value: row.tool ?? '—', mono: true },
          { key: 'Requested', value: formatAbsolute(row.created_at) },
          {
            key: 'Settled',
            value:
              row.resolved_at === null
                ? '—'
                : `${formatAbsolute(row.resolved_at)}${row.resolved_by !== null ? ` by ${row.resolved_by}` : ''}`,
          },
        ]}
      />
      {hasOptions ? (
        <div className="flex flex-col gap-1.5">
          <span className="section-label">Options from the agent</span>
          <JsonView value={row.options} />
        </div>
      ) : null}
      <div>
        <a
          href={href}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            go(href);
          }}
        >
          Open session
          <Arrow aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

/**
 * Phone card: outcome and mode, the reason over three lines, then session · waited ·
 * requested. Tapping the card expands the full decision record in place.
 */
function HistoryCard({
  row,
  expanded,
}: {
  readonly row: OperatorRequestRow;
  readonly expanded: boolean;
}) {
  const Chevron = ICONS.chevronDown;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <StatusBadge domain="request" value={row.status} />
          {row.mode !== null ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-muted-foreground">{MODE_LABEL[row.mode] ?? row.mode}</span>
            </>
          ) : null}
        </span>
        <Chevron
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
            expanded && 'rotate-180',
          )}
        />
      </div>
      {expanded ? (
        <RowDetail row={row} />
      ) : (
        <>
          <p className="line-clamp-3 break-words">{row.reason}</p>
          {row.message !== null && row.message !== '' ? (
            <p className="truncate text-sm text-muted-foreground">“{row.message}”</p>
          ) : null}
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className="min-w-0 truncate">{row.session_slug}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">
              waited {formatDuration(row.waited_ms ?? 0)}
            </span>
            <span aria-hidden="true">·</span>
            <RelativeTime at={row.created_at} className="shrink-0" />
          </p>
        </>
      )}
    </div>
  );
}

/** A session link inside an expandable row (a real link; clicks never toggle the row). */
function SessionLink({ id, slug }: { readonly id: string; readonly slug: string }) {
  const go = useHrefNavigate();
  const href = sessionHref(id);
  return (
    <a
      href={href}
      className="block truncate font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 hover:underline"
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        go(href);
      }}
    >
      {slug}
    </a>
  );
}

/** History table. */
export function HistoryTable() {
  const { search, set, clear } = useSearchState<AttentionSearch>();
  const pager = useCursorPager();
  const query = useAttentionHistory(search, pager);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const columns: readonly DataTableColumn<OperatorRequestRow>[] = [
    {
      id: 'status',
      header: 'Outcome',
      nowrap: true,
      cell: (r) => <StatusBadge domain="request" value={r.status} />,
    },
    {
      id: 'reason',
      header: 'Reason',
      grow: true,
      cell: (r) => (
        <div className="flex min-w-0 flex-col py-0.5">
          <span className="line-clamp-2 break-words">{r.reason}</span>
          {r.message !== null && r.message !== '' ? (
            <span className="truncate text-sm text-muted-foreground">“{r.message}”</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'mode',
      header: 'Mode',
      priority: 2,
      nowrap: true,
      cell: (r) => (
        <span className="text-muted-foreground">
          {r.mode === null ? '—' : (MODE_LABEL[r.mode] ?? r.mode)}
        </span>
      ),
    },
    {
      id: 'session',
      header: 'Session',
      priority: 2,
      className: 'max-w-56',
      cell: (r) => <SessionLink id={r.session_id} slug={r.session_slug} />,
    },
    {
      id: 'waited',
      header: 'Waited',
      sortable: true,
      nowrap: true,
      align: 'end',
      cell: (r) => <span className="tabular-nums">{formatDuration(r.waited_ms ?? 0)}</span>,
    },
    {
      id: 'created',
      header: 'Requested',
      sortable: true,
      priority: 2,
      nowrap: true,
      align: 'end',
      cell: (r) => <RelativeTime at={r.created_at} className="text-muted-foreground" />,
    },
  ];
  const filtered = hasHistoryFilters(search);
  const facets = query.data?.facets;
  return (
    <div className="flex flex-col gap-3">
      <FilterBar
        search={{ param: 'q', placeholder: 'Search reason or session…', value: search.q }}
        chips={[
          {
            param: 'status',
            label: 'Outcome',
            options: facetOptions(facets?.status, SETTLED_STATUSES),
            selected: search.status ?? [],
            format: (v) => STATUS_LABEL[v] ?? v,
          },
          {
            param: 'mode',
            label: 'Mode',
            options: facetOptions(facets?.mode, ['takeover', 'notify']),
            selected: search.mode ?? [],
            format: (v) => MODE_LABEL[v] ?? v,
          },
        ]}
        tokens={
          search.session !== undefined
            ? [
                {
                  key: 'session',
                  value: search.session,
                  onRemove: () => set({ session: undefined }),
                },
              ]
            : []
        }
        range={
          <TimeRangeControl
            value={search.range}
            since={search.since}
            until={search.until}
            onChange={(patch) => {
              pager.reset();
              set({ ...patch });
            }}
          />
        }
        {...(query.data?.page.total !== undefined && { matching: query.data.page.total })}
        onChange={(param, value) => {
          pager.reset();
          set({ [param]: value });
        }}
        onClear={() => {
          pager.reset();
          clear();
        }}
      />
      <DataPanel query={query} skeleton={<SkeletonTable />} isEmpty={() => false} empty={null}>
        {(data) => (
          <DataTable<OperatorRequestRow>
            label="Settled requests"
            columns={columns}
            rows={data.data}
            {...(data.page.total !== undefined && { rowCount: data.page.total })}
            hasNext={data.page.next_cursor !== null}
            state={{ sort: search.sort, dir: search.dir, page: search.page, pageSize: search.ps }}
            sortKeys={ATTENTION_SORT_KEYS}
            getRowId={(r) => r.request_id}
            rowLabel={(r) => r.reason}
            expandable={(r) => <RowDetail row={r} />}
            expanded={expanded}
            onToggleExpanded={(r) => toggle(r.request_id)}
            onRowClick={(r) => toggle(r.request_id)}
            renderCard={(r) => <HistoryCard row={r} expanded={expanded.has(r.request_id)} />}
            onStateChange={(patch) => {
              if (patch.page === undefined) pager.reset();
              set({ ...patch });
            }}
            emptyState={
              filtered ? (
                <EmptyState
                  kind="zero-results"
                  title="No settled requests match these filters"
                  onClear={() => clear()}
                />
              ) : (
                <EmptyState
                  kind="zero-data"
                  icon="attention"
                  title="No settled requests yet"
                  description="Decisions and timeouts are recorded here."
                />
              )
            }
          />
        )}
      </DataPanel>
    </div>
  );
}
