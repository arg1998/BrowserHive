/** @module features/blocklist/components/AttemptsTable — blocked attempts `DataTable` with the shared row pattern: whole-row link to the session, URL grows and truncates, source as quiet text, a hover-revealed filter menu (host / pattern); card mode under 768px (spec 04 §12.6) */
import type { BlockedRequestRow } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { SessionTitle } from '@/features/websites/components/SessionTitle.tsx';
import { formatAbsoluteShort } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import type { PageSize, SortDir } from '@/lib/search/table.ts';

/** Props. */
export interface AttemptsTableProps {
  readonly rows: readonly BlockedRequestRow[];
  readonly total: number | undefined;
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly state: {
    readonly sort?: string | undefined;
    readonly dir?: SortDir | undefined;
    readonly page: number;
    readonly pageSize: PageSize;
  };
  readonly onStateChange: (patch: Record<string, unknown>) => void;
  readonly onFilter: (patch: { readonly domain?: string; readonly pattern?: string }) => void;
  readonly emptyState: ReactNode;
}

const SORT_KEYS = ['time', 'session', 'source', 'domain', 'pattern'] as const;

/** Source label: the tool name for tool-level blocks, "In-page" for network-level ones. */
export function SourceLabel({ row }: { readonly row: BlockedRequestRow }) {
  const Icon = row.source === 'tool' ? ICONS.command : ICONS.link;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {row.source === 'tool' ? (
        <span className="font-mono text-sm">{row.tool ?? 'tool'}</span>
      ) : (
        'In-page'
      )}
    </span>
  );
}

function FilterMenu({
  row,
  onFilter,
}: {
  readonly row: BlockedRequestRow;
  readonly onFilter: AttemptsTableProps['onFilter'];
}) {
  const Filter = ICONS.filter;
  const domain = row.domain;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Filter attempts like this"
          />
        }
      >
        <Filter aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        <DropdownMenuLabel>Show only attempts with</DropdownMenuLabel>
        {domain !== null ? (
          <DropdownMenuItem onClick={() => onFilter({ domain })}>
            Host <span className="ml-1 truncate font-mono text-sm">{domain}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => onFilter({ pattern: row.pattern })}>
          Pattern <span className="ml-1 truncate font-mono text-sm">{row.pattern}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function columns(onFilter: AttemptsTableProps['onFilter']): DataTableColumn<BlockedRequestRow>[] {
  return [
    {
      id: 'time',
      header: 'Time',
      sortable: true,
      nowrap: true,
      priority: 1,
      cell: (row) => <RelativeTime at={row.ts} mode="absolute" className="text-muted-foreground" />,
    },
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      priority: 1,
      className: 'max-w-56',
      cell: (row) =>
        row.session_id === null ? (
          <span className="text-subtle-foreground">—</span>
        ) : (
          <SessionTitle id={row.session_id} slug={row.session_slug} />
        ),
    },
    {
      id: 'url',
      header: 'URL',
      priority: 1,
      grow: true,
      cell: (row) => <UrlCell url={row.url} head={40} tail={20} className="min-w-0" />,
    },
    {
      id: 'pattern',
      header: 'Pattern',
      sortable: true,
      priority: 2,
      className: 'max-w-56',
      cell: (row) => <span className="block truncate font-mono text-sm">{row.pattern}</span>,
    },
    {
      id: 'source',
      header: 'Source',
      sortable: true,
      priority: 3,
      nowrap: true,
      cell: (row) => <SourceLabel row={row} />,
    },
    {
      id: 'actions',
      header: 'Filter',
      hideHeader: true,
      revealOnHover: true,
      align: 'end',
      className: 'w-12',
      cell: (row) => <FilterMenu row={row} onFilter={onFilter} />,
    },
  ];
}

/** Attempts table. */
export function AttemptsTable({
  rows,
  total,
  hasNext,
  loading,
  state,
  onStateChange,
  onFilter,
  emptyState,
}: AttemptsTableProps) {
  return (
    <DataTable<BlockedRequestRow>
      label="Blocked attempts"
      columns={columns(onFilter)}
      rows={rows}
      {...(total !== undefined && { rowCount: total })}
      hasNext={hasNext}
      state={state}
      sortKeys={SORT_KEYS}
      getRowId={(row) => row.event_id}
      onStateChange={onStateChange}
      loading={loading}
      rowHref={(row) =>
        row.session_id === null ? undefined : `/sessions/${encodeURIComponent(row.session_id)}`
      }
      rowLabel={(row) => `Open session ${row.session_slug ?? row.session_id ?? ''} (${row.url})`}
      renderCard={(row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center justify-between gap-3">
            {row.session_id === null ? (
              <span className="text-muted-foreground">No session</span>
            ) : (
              <SessionTitle id={row.session_id} slug={row.session_slug} />
            )}
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
              {formatAbsoluteShort(row.ts)}
            </span>
          </div>
          <UrlCell url={row.url} copy={false} className="min-w-0" />
          <span className="truncate font-mono text-sm text-muted-foreground">{row.pattern}</span>
        </div>
      )}
      emptyState={emptyState}
    />
  );
}
