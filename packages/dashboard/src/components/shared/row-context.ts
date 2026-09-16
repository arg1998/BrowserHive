/** @module components/shared/row-context — tells cell content it renders inside a DataTable row: whether the row is a stretched link, and that the row (not its secondary controls) is the tab stop */
import { createContext, useContext } from 'react';

/** What a table row tells the content of its cells. */
export interface RowScope {
  /** The row is a whole-row link: display text sits under the link, so text tooltips are unreachable. */
  readonly linked: boolean;
  /**
   * The row is a roving-tabindex stop (j/k, arrows). Secondary controls inside it (copy, open URL)
   * leave the tab order so one Tab moves past the row; they stay reachable by pointer and through
   * the row menu (Shift+F10).
   */
  readonly roving: boolean;
}

/** Provided by `DataTableBody` around each row's cells; `null` outside tables. */
export const RowScopeContext = createContext<RowScope | null>(null);

/** The enclosing row, or `null` outside a DataTable row. */
export function useRowScope(): RowScope | null {
  return useContext(RowScopeContext);
}

/**
 * `tabIndex` for a secondary control (copy, open-in-new-tab) in a cell: `-1` inside a roving row,
 * `undefined` (natural order) elsewhere. Feature cells can use it for their own reveal-on-hover
 * buttons; the row menu trigger should stay a normal tab stop.
 */
export function useRowControlTabIndex(): -1 | undefined {
  return useContext(RowScopeContext)?.roving === true ? -1 : undefined;
}
