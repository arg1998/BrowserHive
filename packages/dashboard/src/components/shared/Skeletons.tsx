/** @module components/shared/Skeletons — placeholders that match the final layout: `SkeletonTable` (40px header + 44/36px rows in a table surface), `SkeletonTiles`, `SkeletonCard`, `SkeletonKv` */
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { cn } from '@/lib/utils.ts';
import { Grid } from './layout.tsx';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
/** Deterministic widths so skeleton rows look like text, not bars. */
const WIDTHS = ['w-2/5', 'w-3/5', 'w-1/3', 'w-1/2', 'w-2/3'] as const;

/** Row heights per density (keep in sync with `DataTable`). */
export const ROW_HEIGHT = { comfortable: 'h-11', compact: 'h-9' } as const;

/** Table placeholder with the same header and row heights as `DataTable`. */
export function SkeletonTable({
  rowCount = 8,
  columns = 4,
  density = 'comfortable',
  className,
}: {
  readonly rowCount?: number;
  readonly columns?: number;
  readonly density?: 'comfortable' | 'compact';
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none',
        className,
      )}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex h-10 items-center gap-6 border-b px-4">
        {rows(columns).map((c) => (
          <Skeleton key={c} className="h-3 w-16" />
        ))}
      </div>
      {rows(rowCount).map((i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-6 border-b px-4 last:border-b-0',
            ROW_HEIGHT[density],
          )}
        >
          {rows(columns).map((c) => (
            <div key={c} className={cn('flex', c === 0 ? 'flex-[2]' : 'flex-1')}>
              <Skeleton className={cn('h-3.5', WIDTHS[(i + c) % WIDTHS.length])} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Tile grid placeholder at the exact `StatTile` geometry (label row 24px, 32px value, 22px sub line:
 * 120px with the border), so tiles replace it without a shift. Pass the real grid's classes as
 * `className`; `tileClassName` receives each tile's index (for column spans).
 */
export function SkeletonTiles({
  count = 4,
  sub = true,
  className,
  tileClassName,
  label = 'Loading',
}: {
  readonly count?: number;
  readonly sub?: boolean;
  readonly className?: string;
  readonly tileClassName?: (index: number) => string | undefined;
  readonly label?: string;
}) {
  const tiles = rows(count).map((i) => (
    <div
      key={i}
      className={cn(
        'flex h-full min-w-0 flex-col gap-1 rounded-xl border bg-card p-4 shadow-xs dark:shadow-none',
        tileClassName?.(i),
      )}
    >
      <div className="flex min-h-6 items-center">
        <Skeleton className="h-3.5 w-24" />
      </div>
      <div className="flex h-8 items-center">
        <Skeleton className="h-6 w-14" />
      </div>
      {sub ? (
        <div className="mt-auto flex h-5.5 items-end pt-0.5">
          <Skeleton className="h-3.5 w-20" />
        </div>
      ) : null}
    </div>
  ));
  return className === undefined ? (
    <Grid role="status" aria-busy="true" aria-label={label}>
      {tiles}
    </Grid>
  ) : (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {tiles}
    </div>
  );
}

/** Card placeholder. */
export function SkeletonCard({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-xl border bg-card p-5', className)}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** Key/value placeholder. */
export function SkeletonKv({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading">
      {rows(count).map((i) => (
        <div key={i} className="grid grid-cols-[minmax(7rem,38%)_1fr] gap-4">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className={cn('h-3.5', WIDTHS[i % WIDTHS.length])} />
        </div>
      ))}
    </div>
  );
}
