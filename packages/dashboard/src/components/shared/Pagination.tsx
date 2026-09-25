/** @module components/shared/Pagination — "1–25 of 180", rows-per-page select, prev/next; clamps out-of-range pages and hides itself when everything fits on one page */
import { useId } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { clampPage, PAGE_SIZES, type PageSize } from '@/lib/search/table.ts';
import { cn } from '@/lib/utils.ts';

/** Props. `S` is the page-size union; lists with their own sizes pass `sizes`. */
export interface PaginationProps<S extends number = PageSize> {
  readonly page: number;
  readonly pageSize: S;
  /** Unknown total (cursor-only lists) still allows next when `hasNext`. */
  readonly total?: number;
  readonly hasNext?: boolean;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (size: S) => void;
  /** Rows-per-page choices (default {@link PAGE_SIZES}). */
  readonly sizes?: readonly S[];
  /** Render even when a single page fits (default `false`). */
  readonly alwaysShow?: boolean;
  readonly className?: string;
}

/** Does the pager have anything to offer? (pure; exported for tests) */
export function pagerNeeded(
  page: number,
  pageSize: number,
  total: number | undefined,
  hasNext: boolean | undefined,
): boolean {
  if (page > 1) return true;
  if (hasNext === true) return true;
  if (total === undefined) return false;
  return total > pageSize;
}

/** Pager. */
export function Pagination<S extends number = PageSize>({
  page,
  pageSize,
  total,
  hasNext,
  onPage,
  onPageSize,
  sizes,
  alwaysShow = false,
  className,
}: PaginationProps<S>) {
  const choices: readonly number[] = sizes ?? PAGE_SIZES;
  const labelId = useId();
  if (!alwaysShow && !pagerNeeded(page, pageSize, total, hasNext)) return null;
  const current = clampPage(page, total, pageSize);
  const pages = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = total === undefined ? current * pageSize : Math.min(current * pageSize, total);
  const canPrev = current > 1;
  const canNext = pages === undefined ? hasNext === true : current < pages;
  const Prev = ICONS.chevronLeft;
  const Next = ICONS.chevronRight;
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-muted-foreground',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span id={labelId}>Rows per page</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            const size = choices.find((s) => String(s) === value);
            if (size !== undefined) onPageSize(size as S);
          }}
        >
          <SelectTrigger size="sm" className="w-18" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {choices.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-3">
        <span className="tabular-nums" aria-live="polite">
          {total === undefined
            ? `${formatNumber(first)}–${formatNumber(last)}`
            : `${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)}`}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!canPrev}
            onClick={() => onPage(current - 1)}
          >
            <Prev aria-hidden="true" />
          </Button>
          <span className="min-w-14 text-center text-foreground tabular-nums">
            {current}
            {pages !== undefined ? ` / ${pages}` : ''}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={!canNext}
            onClick={() => onPage(current + 1)}
          >
            <Next aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
}
