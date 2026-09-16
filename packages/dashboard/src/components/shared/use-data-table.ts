/** @module components/shared/use-data-table — TanStack Table v9 in manual mode, isolated behind one hook; the `DataTableColumn` contract */
import {
  type ColumnDef,
  columnVisibilityFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { SortDir } from '@/lib/search/table.ts';

/** Column contract. */
export interface DataTableColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** Sortable only when `id` is in the server whitelist (`sortKeys`). */
  readonly sortable?: boolean;
  /**
   * Other sort keys this column displays (e.g. an Activity column showing calls and errors), each
   * with the label shown beside the header while that key sorts the table. A sort by a key with no
   * column of its own otherwise has no visible indicator.
   */
  readonly sortAliases?: Readonly<Record<string, string>>;
  /** 1 = always visible, 2 = hidden under `md` (768), 3 = only from `xl` (1280). */
  readonly priority?: 1 | 2 | 3;
  readonly align?: 'start' | 'end';
  /** 13px mono (ids, hashes). URLs should use `UrlCell` instead. */
  readonly mono?: boolean;
  /** Keep the cell on one line (cells wrap by default). */
  readonly nowrap?: boolean;
  /** One line with an ellipsis; set a `max-w-*` in `className` to bound it. */
  readonly truncate?: boolean;
  /** Hide the cell content until the row is hovered/focused (row actions); always shown on touch. */
  readonly revealOnHover?: boolean;
  /**
   * The column that absorbs spare width and shrinks first: its content truncates instead of
   * widening the table (URLs, reasons). Give at most one column `grow`.
   */
  readonly grow?: boolean;
  /** Visually hide the header label (actions columns); it stays available to screen readers. */
  readonly hideHeader?: boolean;
  /** Extra classes for the cell and header (width hints like `w-32`, `max-w-64`). */
  readonly className?: string;
}

/** Table state owned by the URL. */
export interface DataTableState {
  readonly sort?: string | undefined;
  readonly dir?: SortDir | undefined;
  readonly page: number;
  readonly pageSize: number;
  readonly selection?: ReadonlySet<string>;
  readonly hidden?: ReadonlySet<string>;
}

/** Feature set registered once. */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
});

type Features = typeof dataTableFeatures;

/** Options. */
export interface UseDataTableOptions<Row extends Record<string, unknown>> {
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly getRowId: (row: Row) => string;
  readonly state: DataTableState;
  readonly sortKeys?: readonly string[];
  readonly onSortChange: (sort: string | undefined, dir: SortDir | undefined) => void;
  readonly onSelectionChange?: (ids: ReadonlySet<string>) => void;
  readonly onHiddenChange?: (ids: ReadonlySet<string>) => void;
}

const EMPTY: never[] = [];

/** Build the table instance (manual sorting/pagination; selection + visibility controlled). */
export function useDataTable<Row extends Record<string, unknown>>(
  options: UseDataTableOptions<Row>,
) {
  const {
    columns,
    rows,
    getRowId,
    state,
    sortKeys,
    onSortChange,
    onSelectionChange,
    onHiddenChange,
  } = options;
  const defs = useMemo<ColumnDef<Features, Row, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        // Manual mode never sorts client-side; the accessor only makes the column sortable.
        accessorFn: (row: Row) => row[column.id] ?? null,
        header: column.header,
        cell: ({ row }) => column.cell(row.original),
        enableSorting:
          column.sortable === true && (sortKeys === undefined || sortKeys.includes(column.id)),
        enableHiding: column.priority !== 1,
      })),
    [columns, sortKeys],
  );
  const sorting = useMemo(
    () => (state.sort === undefined ? [] : [{ id: state.sort, desc: state.dir !== 'asc' }]),
    [state.sort, state.dir],
  );
  const rowSelection = useMemo(
    () => Object.fromEntries([...(state.selection ?? [])].map((id) => [id, true as const])),
    [state.selection],
  );
  const columnVisibility = useMemo(
    () => Object.fromEntries([...(state.hidden ?? [])].map((id) => [id, false])),
    [state.hidden],
  );

  return useTable({
    features: dataTableFeatures,
    columns: defs,
    data: rows.length === 0 ? (EMPTY as Row[]) : (rows as Row[]),
    getRowId: (row) => getRowId(row),
    manualSorting: true,
    enableMultiSort: false,
    enableRowSelection: onSelectionChange !== undefined,
    state: { sorting, rowSelection, columnVisibility },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      onSortChange(first?.id, first === undefined ? undefined : first.desc ? 'desc' : 'asc');
    },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      onSelectionChange?.(new Set(Object.keys(next).filter((id) => next[id] === true)));
    },
    onColumnVisibilityChange: (updater) => {
      const next = typeof updater === 'function' ? updater(columnVisibility) : updater;
      onHiddenChange?.(new Set(Object.keys(next).filter((id) => next[id] === false)));
    },
  });
}
