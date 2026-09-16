/** @module components/shared/DataTableBody — rows: roving focus, whole-row link (stretched `<a>`) or click, hover/focus states, selection checkboxes, reveal-on-hover cells, expandable detail rows */
import { useRouter } from '@tanstack/react-router';
import { type MouseEvent, type ReactNode, type RefObject, useCallback } from 'react';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { TableBody, TableCell, TableRow } from '@/components/ui/table.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { PRIORITY_CLASS } from './DataTableHead.tsx';
import { type RowScope, RowScopeContext } from './row-context.ts';
import type { DataTableColumn, useDataTable } from './use-data-table.ts';
import type { Density } from './use-density.ts';

/** Selector for elements inside a row that handle their own clicks. */
const INTERACTIVE =
  'a:not([data-row-link]),button,input,select,textarea,label,summary,[role="button"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="option"],[role="tab"],[data-interactive]';

/**
 * Should a click on `event.target` inside `row` count as a row click? Not when it hit an inline
 * control, happened inside a portal (menus rendered elsewhere bubble through React), or ended a
 * text selection. Exported for tests.
 */
export function isRowClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (!event.currentTarget.contains(target)) return false;
  const hit = target.closest(INTERACTIVE);
  if (hit !== null && event.currentTarget.contains(hit)) return false;
  const selection = globalThis.getSelection?.();
  if (selection !== null && selection !== undefined && selection.toString().length > 0)
    return false;
  return true;
}

/** Is this a plain primary click (no modifier) that the SPA should handle itself? */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** SPA navigation to an href; falls back to a full load outside a router (isolated component tests). */
export function useHrefNavigate(): (href: string) => void {
  const router = useRouter({ warn: false });
  return useCallback(
    (href: string) => {
      if (typeof router?.navigate === 'function') void router.navigate({ href });
      else globalThis.location.assign(href);
    },
    [router],
  );
}

const LINKED_ROW: RowScope = { linked: true, roving: true };
const PLAIN_ROW: RowScope = { linked: false, roving: true };

/** Row cell heights per density. */
export const DENSITY_CELL: { readonly [D in Density]: string } = {
  comfortable: 'h-11 py-2',
  compact: 'h-9 py-1',
};

/** Props. */
export interface DataTableBodyProps<Row extends Record<string, unknown>> {
  readonly table: ReturnType<typeof useDataTable<Row>>;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly bodyRef: RefObject<HTMLTableSectionElement | null>;
  readonly focusIndex: number;
  readonly onFocusIndex: (index: number) => void;
  readonly firstRowIndex: number;
  readonly selectable: boolean;
  readonly density: Density;
  readonly rowHref?: ((row: Row) => string | undefined) | undefined;
  readonly rowLabel?: ((row: Row) => string) | undefined;
  readonly onRowClick?: ((row: Row) => void) | undefined;
  readonly expandable?: ((row: Row) => ReactNode) | undefined;
  readonly expanded?: ReadonlySet<string> | undefined;
  readonly onToggleExpanded?: ((row: Row) => void) | undefined;
}

/** Body. */
export function DataTableBody<Row extends Record<string, unknown>>({
  table,
  columns,
  bodyRef,
  focusIndex,
  onFocusIndex,
  firstRowIndex,
  selectable,
  density,
  rowHref,
  rowLabel,
  onRowClick,
  expandable,
  expanded,
  onToggleExpanded,
}: DataTableBodyProps<Row>) {
  const go = useHrefNavigate();
  const Chevron = ICONS.chevronRight;
  const visibleColumns = table.getVisibleLeafColumns().length;
  const span = visibleColumns + (selectable ? 1 : 0) + (expandable !== undefined ? 1 : 0);
  return (
    <TableBody ref={bodyRef}>
      {table.getRowModel().rows.map((row, index) => {
        const original = row.original;
        const isExpanded = expanded?.has(row.id) ?? false;
        const href = rowHref?.(original);
        const toggle =
          expandable !== undefined && onToggleExpanded !== undefined
            ? () => onToggleExpanded(original)
            : undefined;
        const click = onRowClick !== undefined ? () => onRowClick(original) : toggle;
        const interactive = href !== undefined || click !== undefined;
        const selected = row.getIsSelected();
        return (
          <RowGroup key={row.id}>
            <TableRow
              tabIndex={index === focusIndex ? 0 : -1}
              aria-rowindex={firstRowIndex + index}
              aria-selected={selectable ? selected : undefined}
              aria-expanded={toggle !== undefined ? isExpanded : undefined}
              data-state={selected ? 'selected' : undefined}
              data-reveal-scope=""
              data-row-link-scope={href !== undefined ? '' : undefined}
              data-row-index={index}
              onFocus={(event) => {
                if (event.target === event.currentTarget) onFocusIndex(index);
              }}
              onClick={
                click !== undefined && href === undefined
                  ? (event) => {
                      if (isRowClick(event)) click();
                    }
                  : undefined
              }
              className={cn(
                'group/row relative focus-ring-inset',
                interactive && 'cursor-pointer hover:bg-accent/70 dark:hover:bg-white/[0.035]',
                isExpanded && 'bg-accent/50 dark:bg-white/[0.03]',
              )}
            >
              <RowScopeContext.Provider value={href !== undefined ? LINKED_ROW : PLAIN_ROW}>
                {selectable ? (
                  <TableCell className={cn('w-10', DENSITY_CELL[density])}>
                    <span className="flex items-center">
                      <Checkbox
                        aria-label={`Select row ${rowLabel?.(original) ?? row.id}`}
                        // The row is the tab stop; Space or x selects it.
                        tabIndex={-1}
                        checked={selected}
                        onCheckedChange={(checked) => row.toggleSelected(checked)}
                      />
                    </span>
                  </TableCell>
                ) : null}
                {row.getVisibleCells().map((cell, cellIndex) => {
                  const column = columns.find((c) => c.id === cell.column.id);
                  const content = column?.cell(original);
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        DENSITY_CELL[density],
                        PRIORITY_CLASS[column?.priority ?? 1],
                        column?.align === 'end' && 'text-right',
                        column?.mono === true && 'font-mono text-sm',
                        (column?.nowrap === true || column?.truncate === true) &&
                          'whitespace-nowrap',
                        column?.grow === true && 'w-full max-w-0',
                        column?.className,
                      )}
                    >
                      {cellIndex === 0 && href !== undefined ? (
                        <a
                          href={href}
                          data-row-link=""
                          tabIndex={-1}
                          className="absolute inset-0 outline-none"
                          onClick={(event) => {
                            if (!isPlainClick(event)) return;
                            event.preventDefault();
                            go(href);
                          }}
                        >
                          <span className="sr-only">
                            {rowLabel?.(original) ?? `Open ${row.id}`}
                          </span>
                        </a>
                      ) : null}
                      {column?.truncate === true ? (
                        <div
                          className={cn(
                            'min-w-0 truncate',
                            column.revealOnHover === true && 'reveal',
                          )}
                        >
                          {content}
                        </div>
                      ) : column?.revealOnHover === true ? (
                        <div
                          className={cn(
                            'reveal inline-flex items-center gap-1',
                            column.align === 'end' && 'justify-end',
                          )}
                        >
                          {content}
                        </div>
                      ) : column?.grow === true ? (
                        <div className="flex min-w-0">{content}</div>
                      ) : (
                        content
                      )}
                    </TableCell>
                  );
                })}
                {expandable !== undefined ? (
                  <TableCell className={cn('w-10 text-right', DENSITY_CELL[density])}>
                    {toggle !== undefined ? (
                      <Chevron
                        aria-hidden="true"
                        className={cn(
                          'inline size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-hover/row:text-foreground',
                          isExpanded && 'rotate-90',
                        )}
                      />
                    ) : null}
                  </TableCell>
                ) : null}
              </RowScopeContext.Provider>
            </TableRow>
            {expandable !== undefined && isExpanded ? (
              <TableRow data-expanded-row="">
                <TableCell
                  colSpan={span}
                  className="bg-muted/40 px-4 py-4 [overflow-wrap:normal] dark:bg-white/[0.02]"
                >
                  {expandable(original)}
                </TableCell>
              </TableRow>
            ) : null}
          </RowGroup>
        );
      })}
    </TableBody>
  );
}

function RowGroup({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
