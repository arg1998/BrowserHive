/** @module features/attention/HistoryTable — settled requests: FilterBar (search, Mode and Outcome chips with API facet counts, session token, time range) + DataTable whose rows expand on click into the full decision record (reason, message, page, tool, resolution, options) (spec 04 §12.4) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { useState } from 'react';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { formatDuration } from '@/lib/format/time.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useAttentionHistory } from './api.ts';
import {
  facetOptions,
  HistoryCard,
  interceptLabel,
  MODE_LABEL,
  RowDetail,
  SessionLink,
  STATUS_LABEL,
} from './history-parts.tsx';
import {
  ATTENTION_SORT_KEYS,
  type AttentionSearch,
  hasHistoryFilters,
  SETTLED_STATUSES,
} from './search.ts';

export { facetOptions } from './history-parts.tsx';

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
          <span className="line-clamp-2 break-words">
            {interceptLabel(r) !== null ? (
              <span className="mr-1.5 font-medium">{interceptLabel(r)}:</span>
            ) : null}
            {r.reason}
          </span>
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
