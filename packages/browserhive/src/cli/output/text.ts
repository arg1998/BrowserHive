/** @module cli/output/text — width-aware word wrapping and the aligned table renderer used by help, `config show`, `doctor`, `db status`, `admin tokens list` and `purge` */
import { padVisible, visibleWidth } from './style.ts';

/** Minimum and maximum help/table width (spec 08 §7.2). */
export const MIN_WIDTH = 60;
/** Maximum rendering width (spec 08 §7.2). */
export const MAX_WIDTH = 120;
/** Width used when the stream is not a terminal (and by the goldens). */
export const DEFAULT_WIDTH = 100;

/**
 * Clamps a terminal width into `[60, 120]`; `undefined` (not a TTY) yields 100.
 *
 * @returns The rendering width.
 */
export function clampWidth(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(columns)));
}

/**
 * Greedy word wrap on spaces. Words longer than `width` are kept whole on their own line. ANSI
 * sequences do not count towards the width.
 *
 * @returns The wrapped lines (at least one, possibly empty).
 */
export function wrapWords(text: string, width: number): readonly string[] {
  const words = text.split(/ +/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

/** One table column. */
export interface TableColumn {
  readonly header: string;
  readonly align?: 'left' | 'right';
}

/**
 * Renders rows as space-separated aligned columns with a header row (header styled by `header`).
 * The last column is never padded, so no line carries trailing spaces.
 *
 * @returns The table lines.
 */
export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  header: (text: string) => string = (text) => text,
): readonly string[] {
  const widths = columns.map((column, index) =>
    Math.max(visibleWidth(column.header), ...rows.map((row) => visibleWidth(row[index] ?? ''))),
  );
  const renderRow = (cells: readonly string[], style: (text: string) => string): string =>
    columns
      .map((column, index) => {
        const cell = cells[index] ?? '';
        const last = index === columns.length - 1;
        const padded =
          last && column.align !== 'right'
            ? cell
            : padVisible(cell, widths[index] ?? 0, column.align ?? 'left');
        return style(padded);
      })
      .join('  ')
      .trimEnd();
  return [
    renderRow(
      columns.map((column) => column.header),
      header,
    ),
    ...rows.map((row) => renderRow(row, (text) => text)),
  ];
}
