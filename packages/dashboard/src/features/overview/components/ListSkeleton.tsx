/** @module features/overview/components/ListSkeleton — skeleton rows at the real heights of the Overview link lists (44px one-line, 64px two-line) */
import { Skeleton } from '@/components/ui/skeleton.tsx';

/** Skeleton list. */
export function ListSkeleton({
  rows = 5,
  twoLine = false,
}: {
  readonly rows?: number;
  readonly twoLine?: boolean;
}) {
  return (
    <div aria-hidden="true" className="flex flex-col divide-y">
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <div
          key={key}
          className={
            twoLine ? 'flex h-16 flex-col justify-center gap-2 px-5' : 'flex h-11 items-center px-5'
          }
        >
          <Skeleton className="h-3.5 w-2/5" />
          {twoLine ? <Skeleton className="h-3 w-3/5" /> : null}
        </div>
      ))}
    </div>
  );
}
