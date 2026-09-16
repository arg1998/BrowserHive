/** @module components/shared/DataTableHead — sticky header row (sticks under the topbar, or to `--table-sticky-top` inside a scrolling pane): `aria-sort`, whitelisted sort buttons, select-all checkbox */
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ICONS } from '@/lib/icons.ts';
import { nextSort, type SortDir } from '@/lib/search/table.ts';
import { cn } from '@/lib/utils.ts';
import type { DataTableColumn, useDataTable } from './use-data-table.ts';

/** Classes hiding low-priority columns per band. */
export const PRIORITY_CLASS = {
  1: '',
  2: 'hidden md:table-cell',
  3: 'hidden xl:table-cell',
} as const;

/** Sticky header cell classes (shared with the expand/select columns). */
export const STICKY_HEAD =
  'sticky top-(--table-sticky-top,var(--topbar-height)) z-(--z-sticky) bg-card';

/** Props. */
export interface DataTableHeadProps<Row extends Record<string, unknown>> {
  readonly table: ReturnType<typeof useDataTable<Row>>;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly sort: string | undefined;
  readonly dir: SortDir | undefined;
  readonly selectable: boolean;
  readonly expandable: boolean;
  readonly sticky: boolean;
  readonly onSort: (sort: string | undefined, dir: SortDir | undefined) => void;
}

/** Header. */
export function DataTableHead<Row extends Record<string, unknown>>({
  table,
  columns,
  sort,
  dir,
  selectable,
  expandable,
  sticky,
  onSort,
}: DataTableHeadProps<Row>) {
  const some = table.getIsSomeRowsSelected();
  const all = table.getIsAllRowsSelected();
  const icons = { asc: ICONS.sortAsc, desc: ICONS.sortDesc, none: ICONS.sortNone } as const;
  const stick = sticky ? STICKY_HEAD : 'bg-card';
  return (
    <TableHeader>
      {table.getHeaderGroups().map((group) => (
        <TableRow key={group.id}>
          {selectable ? (
            <TableHead className={cn('w-10', stick)}>
              <span className="flex items-center">
                <Checkbox
                  aria-label="Select all rows on this page"
                  checked={all}
                  indeterminate={some && !all}
                  onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
                />
              </span>
            </TableHead>
          ) : null}
          {group.headers.map((header) => {
            const column = columns.find((c) => c.id === header.column.id);
            const alias =
              sort !== undefined && sort !== header.column.id
                ? column?.sortAliases?.[sort]
                : undefined;
            const sorted =
              sort === header.column.id || alias !== undefined ? (dir ?? 'desc') : undefined;
            const canSort = header.column.getCanSort();
            const Icon = icons[sorted ?? 'none'];
            return (
              <TableHead
                key={header.id}
                aria-sort={
                  canSort
                    ? sorted === 'asc'
                      ? 'ascending'
                      : sorted === 'desc'
                        ? 'descending'
                        : 'none'
                    : undefined
                }
                className={cn(
                  stick,
                  PRIORITY_CLASS[column?.priority ?? 1],
                  column?.align === 'end' && 'text-right',
                  column?.grow === true && 'w-full',
                  column?.className,
                )}
              >
                {canSort ? (
                  <button
                    type="button"
                    className={cn(
                      'group/sort -mx-1.5 inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm px-1.5 hover:bg-accent hover:text-foreground',
                      sorted !== undefined && 'text-foreground',
                      column?.align === 'end' && 'flex-row-reverse',
                    )}
                    onClick={() => {
                      const next = nextSort({ sort, dir }, header.column.id);
                      onSort(next.sort, next.dir);
                    }}
                  >
                    {column?.header}
                    {alias !== undefined ? (
                      <span className="font-normal text-muted-foreground">· {alias}</span>
                    ) : null}
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        'size-3.5',
                        sorted === undefined &&
                          'text-subtle-foreground opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100',
                      )}
                    />
                  </button>
                ) : column?.hideHeader === true ? (
                  <span className="sr-only">{column.header}</span>
                ) : (
                  column?.header
                )}
              </TableHead>
            );
          })}
          {expandable ? (
            <TableHead className={cn('w-10', stick)}>
              <span className="sr-only">Expand row</span>
            </TableHead>
          ) : null}
        </TableRow>
      ))}
    </TableHeader>
  );
}
