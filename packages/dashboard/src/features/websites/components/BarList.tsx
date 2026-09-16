/** @module features/websites/components/BarList — compact ranked bars (label over a proportional fill, value right-aligned); each row is a real link, a toggle button (aria-pressed) or static; used by Most visited domains and the blocklist patterns/hosts */
import type { ReactElement, ReactNode } from 'react';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** One bar. */
export interface BarListItem {
  readonly key: string;
  readonly label: ReactNode;
  /** Accessible/plain name (defaults to `key`). */
  readonly name?: string;
  readonly value: number;
  /** Replaces the formatted value (e.g. `—` for never). */
  readonly valueLabel?: string;
  /** Row is a link. */
  readonly href?: string;
  /** Row is a toggle button (ignored when `href` is set). */
  readonly onClick?: () => void;
  readonly active?: boolean;
  /** Tooltip on the row. */
  readonly hint?: ReactNode;
}

/** Props. */
export interface BarListProps {
  readonly label: string;
  readonly items: readonly BarListItem[];
  /** Fill colour: data blue (default) or warn for refusals. */
  readonly tone?: 'chart' | 'warn';
  /** Flow the ranking into newspaper columns (1 → 2 from 640px → 3 from 1280px), read down each column. */
  readonly columns?: boolean;
  readonly className?: string;
}

// The bar is a thin proportional meter under the label, on a faint full-width track: a tinted box
// behind the text ended mid-word for short values and read as a text highlight, and a full-height
// fill on the longest row read as a selection. Selection has its own treatment (ring,
// check, semibold).
const FILL = {
  chart: 'bg-chart-1/70 group-hover/bar:bg-chart-1',
  warn: 'bg-warn-solid/70 group-hover/bar:bg-warn-solid',
} as const;

/** Bar list. */
export function BarList({
  label,
  items,
  tone = 'chart',
  columns = false,
  className,
}: BarListProps) {
  const go = useHrefNavigate();
  const Check = ICONS.check;
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul
      aria-label={label}
      className={cn(
        columns ? 'columns-1 gap-x-6 sm:columns-2 xl:columns-3' : 'flex flex-col gap-1',
        className,
      )}
    >
      {items.map((item) => {
        const width = item.value > 0 ? Math.max(2, (item.value / max) * 100) : 0;
        const body = (
          <>
            <span
              aria-hidden="true"
              className="absolute inset-x-2.5 bottom-1 h-[3px] overflow-hidden rounded-full bg-muted dark:bg-white/[0.06]"
            >
              <span
                className={cn(
                  'block h-full rounded-full transition-[background-color] duration-(--duration-fast)',
                  FILL[tone],
                  item.active === true && 'bg-primary',
                )}
                style={{ width: `${width}%` }}
              />
            </span>
            <span
              className={cn(
                'relative flex min-w-0 items-center gap-1.5',
                item.active === true && 'font-semibold text-foreground',
              )}
            >
              {item.active === true ? (
                <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
              ) : null}
              <span className="min-w-0 truncate">{item.label}</span>
            </span>
            <span className="relative shrink-0 text-sm text-muted-foreground tabular-nums">
              {item.valueLabel ?? formatNumber(item.value)}
            </span>
          </>
        );
        const rowClass = cn(
          'group/bar relative flex h-9 w-full min-w-0 items-center justify-between gap-3 rounded-md px-2.5 pb-1.5 text-left text-sm focus-ring',
          (item.href !== undefined || item.onClick !== undefined) &&
            'hover:bg-accent/70 dark:hover:bg-white/[0.035]',
          item.active === true && 'ring-1 ring-primary/60 ring-inset',
        );
        const name = item.name ?? item.key;
        let row: ReactElement;
        if (item.href !== undefined) {
          const href = item.href;
          row = (
            <a
              href={href}
              className={rowClass}
              aria-label={`${name}: ${item.valueLabel ?? formatNumber(item.value)}`}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                go(href);
              }}
            >
              {body}
            </a>
          );
        } else if (item.onClick !== undefined) {
          row = (
            <button
              type="button"
              className={rowClass}
              aria-pressed={item.active === true}
              aria-label={`${name}: ${item.valueLabel ?? formatNumber(item.value)}`}
              onClick={item.onClick}
            >
              {body}
            </button>
          );
        } else {
          row = (
            <div className={rowClass} role="presentation">
              {body}
            </div>
          );
        }
        return (
          <li key={item.key} className={cn('min-w-0', columns && 'mb-1 break-inside-avoid')}>
            {item.hint !== undefined ? <Hint label={item.hint}>{row}</Hint> : row}
          </li>
        );
      })}
    </ul>
  );
}
