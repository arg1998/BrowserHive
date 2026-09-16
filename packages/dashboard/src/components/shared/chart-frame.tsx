/** @module components/shared/chart-frame — chart container: title, legend (always present for ≥ 2 series), loading/empty states, "Show as table" alternative; charts themselves are lazy (spec 04 §7) */
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { cn } from '@/lib/utils.ts';

/** Chart colour slots (`--color-chart-n` tokens); the only colours a chart may use besides hue tokens. */
export type ChartColor = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5' | 'chart-6';

/** Swatch classes per slot (tokens only). */
export const CHART_SWATCH: { readonly [C in ChartColor]: string } = {
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5',
  'chart-6': 'bg-chart-6',
};

/**
 * CSS variable reference for a slot, for SVG `fill`/`stroke`.
 *
 * Points at the `:root` spine variable (`--chart-n`), never at the `@theme inline` alias
 * (`--color-chart-n`): Tailwind only emits theme aliases whose names appear literally in
 * scanned source, so a name built at runtime resolves to nothing and SVG paints black.
 */
export function chartVar(color: ChartColor): string {
  return `var(--${color})`;
}

/** Non-series chart ink (grid, axis ticks, the surface gap between adjacent marks), `:root` spine vars. */
export const CHART_INK = {
  grid: 'var(--chart-grid)',
  axis: 'var(--chart-axis)',
  surface: 'var(--card)',
} as const;

/** One legend entry. */
export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: ChartColor;
}

/** Accessible table alternative of the plotted data. */
export interface ChartTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number)[])[];
}

/** Props. */
export interface ChartFrameProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly series?: readonly ChartSeries[];
  readonly loading?: boolean;
  /** Rendered instead of the chart when there is nothing to plot. */
  readonly empty?: ReactNode;
  readonly isEmpty?: boolean;
  readonly table?: ChartTable;
  readonly actions?: ReactNode;
  readonly height?: 'sm' | 'md' | 'lg';
  readonly children: ReactNode;
  readonly className?: string;
}

const HEIGHT = { sm: 'h-40', md: 'h-64', lg: 'h-80' } as const;

/** Chart frame. */
export function ChartFrame({
  title,
  description,
  series = [],
  loading = false,
  empty,
  isEmpty = false,
  table,
  actions,
  height = 'md',
  children,
  className,
}: ChartFrameProps) {
  const titleId = useId();
  const [asTable, setAsTable] = useState(false);
  const showTable = asTable && table !== undefined;
  return (
    <figure
      aria-labelledby={titleId}
      className={cn(
        '@container flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 shadow-xs dark:shadow-none',
        className,
      )}
    >
      <figcaption className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span id={titleId} className="text-base font-semibold">
            {title}
          </span>
          {description !== undefined ? (
            <span className="text-sm text-muted-foreground">{description}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {table !== undefined && !loading && !isEmpty ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? 'Show chart' : 'Show as table'}
            </Button>
          ) : null}
        </div>
      </figcaption>
      {loading ? (
        <Skeleton className={cn('w-full', HEIGHT[height])} aria-label="Loading chart" />
      ) : isEmpty ? (
        <div className={cn('flex items-center justify-center', HEIGHT[height])}>{empty}</div>
      ) : showTable ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="h-9 px-3 text-left font-medium text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional data with no id
                <tr key={index} className="border-t">
                  {row.map((cell, cellIndex) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                      key={cellIndex}
                      className="h-9 px-3 tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={cn('w-full min-w-0', HEIGHT[height])}>{children}</div>
      )}
      {series.length >= 2 && !loading && !isEmpty ? (
        <ul
          className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground"
          aria-label="Legend"
        >
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn('size-2.5 rounded-full', CHART_SWATCH[s.color])}
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}
