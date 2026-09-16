/** @module components/shared/DataTable — manual-mode table: whole-row links/clicks, sticky header on the page scroller, hover-revealed row actions, expandable rows, density, j/k/Enter/Space, skeleton rows, whole-card links on mobile, pager hidden when one page fits */
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useKeyboardScope } from '@/app/providers/KeyboardProvider.tsx';
import { Table } from '@/components/ui/table.tsx';
import type { PageSize, SortDir } from '@/lib/search/table.ts';
import { cn } from '@/lib/utils.ts';
import { ColumnMenu } from './ColumnMenu.tsx';
import { DataTableBody, isPlainClick, isRowClick, useHrefNavigate } from './DataTableBody.tsx';
import { DataTableHead } from './DataTableHead.tsx';
import { Pagination } from './Pagination.tsx';
import { SkeletonTable } from './Skeletons.tsx';
import { type DataTableColumn, type DataTableState, useDataTable } from './use-data-table.ts';
import { type Density, useDensity } from './use-density.ts';

/** Props. */
export interface DataTableProps<Row extends Record<string, unknown>> {
  /** Accessible name of the table region. */
  readonly label: string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly hasNext?: boolean;
  readonly state: DataTableState;
  readonly sortKeys?: readonly string[];
  readonly getRowId: (row: Row) => string;
  readonly onStateChange: (patch: {
    readonly sort?: string | undefined;
    readonly dir?: SortDir | undefined;
    readonly page?: number;
    readonly ps?: PageSize;
    readonly sel?: readonly string[];
  }) => void;
  /** Enables the column checkboxes in the View menu (rendered above the table). */
  readonly onHiddenChange?: (hidden: ReadonlySet<string>) => void;
  /** Card layout under `md` (768px). The whole card is the row link/click target. */
  readonly renderCard?: (row: Row) => ReactNode;
  readonly emptyState: ReactNode;
  readonly loading?: boolean;
  /**
   * Whole-row link: a stretched real `<a href>` (middle-click, Ctrl/⌘-click and "open in new tab"
   * work). Inline controls in cells stay clickable above it. Return `undefined` for rows without one.
   */
  readonly rowHref?: (row: Row) => string | undefined;
  /** Accessible name of the row link / checkbox (defaults to the row id). */
  readonly rowLabel?: (row: Row) => string;
  /** Click anywhere in the row (rows that are not links). Inline controls never trigger it. */
  readonly onRowClick?: (row: Row) => void;
  /** Enter on a focused row. Defaults to following `rowHref`, then `onRowClick`, then expanding. */
  readonly onRowOpen?: (row: Row) => void;
  /** Detail rendered in a full-width row under an expanded row. */
  readonly expandable?: (row: Row) => ReactNode;
  readonly expanded?: ReadonlySet<string>;
  /** Makes rows expand on click anywhere (with a rotating chevron column). */
  readonly onToggleExpanded?: (row: Row) => void;
  /** Row density; defaults to the operator's preference (`useDensity`). */
  readonly density?: Density;
  /** Stick the header under the topbar (default `true`). Inside a scrolling pane set `--table-sticky-top: 0px` on the pane. */
  readonly stickyHeader?: boolean;
  readonly className?: string;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Does the table need a horizontal scroller? Only then does the surface become `overflow-x: auto`
 * (which disables the page-sticky header); otherwise it clips its corners without a scroll
 * container so the header sticks under the topbar.
 */
function useHorizontalOverflow(node: HTMLElement | null): boolean {
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const table = node?.querySelector('table');
    if (node === null || table === null || table === undefined) return undefined;
    const measure = () => setOverflow(table.scrollWidth > node.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // The table resizes when rows, columns or density change; the surface when the page does.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(table);
    return () => observer.disconnect();
  }, [node]);
  return overflow;
}

/** Data table. */
export function DataTable<Row extends Record<string, unknown>>(props: DataTableProps<Row>) {
  const {
    label,
    columns,
    rows,
    rowCount,
    hasNext,
    state,
    sortKeys,
    getRowId,
    onStateChange,
    onHiddenChange,
    renderCard,
    emptyState,
    loading,
    rowHref,
    rowLabel,
    onRowClick,
    onRowOpen,
    expandable,
    expanded,
    onToggleExpanded,
    stickyHeader = true,
    className,
  } = props;
  const [preferredDensity] = useDensity();
  const density = props.density ?? preferredDensity;
  const go = useHrefNavigate();
  const selectable = state.selection !== undefined;
  const table = useDataTable<Row>({
    columns,
    rows,
    getRowId,
    state,
    ...(sortKeys !== undefined && { sortKeys }),
    onSortChange: (sort, dir) => onStateChange({ sort, dir }),
    ...(selectable && {
      onSelectionChange: (ids: ReadonlySet<string>) => onStateChange({ sel: [...ids] }),
    }),
    ...(onHiddenChange !== undefined && { onHiddenChange }),
  });
  const [focusIndex, setFocusIndex] = useState(0);
  const [regionFocused, setRegionFocused] = useState(false);
  useKeyboardScope('table', regionFocused);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const model = table.getRowModel().rows;
  const overflow = useHorizontalOverflow(surface);

  const open = (row: Row) => {
    if (onRowOpen !== undefined) return onRowOpen(row);
    const href = rowHref?.(row);
    if (href !== undefined) return go(href);
    if (onRowClick !== undefined) return onRowClick(row);
    if (onToggleExpanded !== undefined) return onToggleExpanded(row);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (model.length === 0) return;
    const inControl =
      event.target instanceof Element &&
      event.target !== event.currentTarget &&
      event.target.closest('tr') === null;
    if (inControl) return;
    const onRow = event.target instanceof HTMLTableRowElement;
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(model.length - 1, next));
      setFocusIndex(clamped);
      bodyRef.current
        ?.querySelector<HTMLTableRowElement>(`tr[data-row-index="${clamped}"]`)
        ?.focus();
      event.preventDefault();
    };
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        return move(focusIndex + 1);
      case 'k':
      case 'ArrowUp':
        return move(focusIndex - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(model.length - 1);
      case 'Enter': {
        const row = model[focusIndex];
        if (row !== undefined && (onRow || event.target === event.currentTarget)) {
          event.preventDefault();
          open(row.original);
        }
        return;
      }
      case 'F10':
      case 'ContextMenu':
      case '.': {
        // Shift+F10 / the menu key / `.` open the focused row's menu: its secondary controls are
        // out of the tab order, so the menu is how the keyboard reaches them.
        if (event.key === 'F10' && !event.shiftKey) return;
        if (!onRow) return;
        const trigger = (event.target as HTMLElement).querySelector<HTMLElement>(
          'button[aria-haspopup="menu"]',
        );
        if (trigger === null) return;
        event.preventDefault();
        trigger.focus();
        trigger.click();
        return;
      }
      case ' ':
      case 'x': {
        const row = model[focusIndex];
        if (row !== undefined && selectable && (onRow || event.target === event.currentTarget)) {
          event.preventDefault();
          row.toggleSelected();
        }
        return;
      }
      default:
        return;
    }
  };

  const pager = (
    <Pagination
      page={state.page}
      pageSize={state.pageSize as PageSize}
      {...(rowCount !== undefined && { total: rowCount })}
      {...(hasNext !== undefined && { hasNext })}
      onPage={(page) => onStateChange({ page })}
      onPageSize={(ps) => onStateChange({ ps })}
    />
  );
  const visibleColumns = columns.filter((c) => !(state.hidden ?? EMPTY_SET).has(c.id)).length;

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {onHiddenChange !== undefined ? (
        <div className="flex justify-end">
          <ColumnMenu
            columns={columns}
            hidden={state.hidden ?? EMPTY_SET}
            onHiddenChange={onHiddenChange}
          />
        </div>
      ) : null}
      {loading === true ? (
        <SkeletonTable
          density={density}
          columns={Math.min(Math.max(visibleColumns, 2), 6)}
          // A full page of rows (typical for paged lists), so the pager under the table doesn't jump
          // when the data lands; capped so a 100-row page doesn't paint a screenful of bars.
          rowCount={Math.max(1, Math.min(state.pageSize, rowCount ?? state.pageSize, 50))}
        />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-xs dark:shadow-none">{emptyState}</div>
      ) : (
        <>
          {renderCard !== undefined ? (
            <ul className="flex flex-col gap-2 md:hidden" aria-label={label}>
              {model.map((row) => {
                const href = rowHref?.(row.original);
                const click = onRowClick !== undefined ? () => onRowClick(row.original) : undefined;
                const interactive = href !== undefined || click !== undefined;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the card's click is a pointer shortcut; keyboard users use its link or controls
                  <li
                    key={row.id}
                    data-reveal-scope=""
                    data-row-link-scope={href !== undefined ? '' : undefined}
                    className={cn(
                      'relative rounded-xl border bg-card p-4 shadow-xs transition-colors dark:shadow-none',
                      interactive && 'cursor-pointer hover:bg-accent/60 active:bg-accent',
                      row.getIsSelected() && 'border-accent-border bg-accent-bg/50',
                    )}
                    onClick={
                      click !== undefined && href === undefined
                        ? (event) => {
                            if (isRowClick(event)) click();
                          }
                        : undefined
                    }
                  >
                    {href !== undefined ? (
                      <a
                        href={href}
                        data-row-link=""
                        className="absolute inset-0 rounded-xl"
                        onClick={(event) => {
                          if (!isPlainClick(event)) return;
                          event.preventDefault();
                          go(href);
                        }}
                      >
                        <span className="sr-only">
                          {rowLabel?.(row.original) ?? `Open ${row.id}`}
                        </span>
                      </a>
                    ) : null}
                    {renderCard(row.original)}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <section
            ref={setSurface}
            aria-label={label}
            data-overflow={overflow ? '' : undefined}
            data-density={density}
            onKeyDown={onKeyDown}
            onFocus={() => setRegionFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setRegionFocused(false);
            }}
            className={cn(
              'min-w-0 rounded-xl border bg-card shadow-xs dark:shadow-none',
              overflow ? 'overflow-x-auto' : 'overflow-clip',
              renderCard !== undefined && 'hidden md:block',
            )}
          >
            <Table
              // Rows carry roving focus plus aria-expanded / aria-selected, which only a grid or
              // treegrid allows on a row. Tables with neither stay plain tables.
              role={
                expandable !== undefined && onToggleExpanded !== undefined
                  ? 'treegrid'
                  : selectable
                    ? 'grid'
                    : undefined
              }
              aria-multiselectable={selectable ? true : undefined}
              aria-rowcount={rowCount ?? rows.length}
            >
              <DataTableHead
                table={table}
                columns={columns}
                sort={state.sort}
                dir={state.dir}
                selectable={selectable}
                expandable={expandable !== undefined}
                sticky={stickyHeader && !overflow}
                onSort={(sort, dir) => onStateChange({ sort, dir })}
              />
              <DataTableBody
                table={table}
                columns={columns}
                bodyRef={bodyRef}
                focusIndex={focusIndex}
                onFocusIndex={setFocusIndex}
                firstRowIndex={(state.page - 1) * state.pageSize + 1}
                selectable={selectable}
                density={density}
                rowHref={rowHref}
                rowLabel={rowLabel}
                onRowClick={onRowClick}
                expandable={expandable}
                expanded={expanded}
                onToggleExpanded={onToggleExpanded}
              />
            </Table>
          </section>
        </>
      )}
      {pager}
    </div>
  );
}
