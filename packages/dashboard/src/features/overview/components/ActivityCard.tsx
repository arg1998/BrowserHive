/** @module features/overview/components/ActivityCard — `ChartFrame` around the activity chart: bucket wording in the description, legend, "Show as table" alternative, one empty state, a zoom hint when all activity sits in the last few hours; the chart area and legend keep one height while loading and refetching so nothing below moves (spec 04 §12.1) */
import type { ActivityResponse } from '@browserhive/contracts/http';
import { ChartFrame } from '@/components/shared/chart-frame.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ICONS } from '@/lib/icons.ts';
import { ActivityChart, bucketRange } from './ActivityChart.tsx';
import { bucketWording, callsOf, sparseActivitySpan, toPoints } from './activity-points.ts';

/** Props. */
export interface ActivityCardProps {
  readonly activity: ActivityResponse | undefined;
  readonly rangeLabel: string;
  /** Offered when all activity sits inside the last day of a wider trailing window. */
  readonly onZoom?: (() => void) | undefined;
}

/** "the last 6 hours" / "the last hour" / "the last day". */
export function lastSpanWording(spanMs: number): string {
  const hours = Math.max(1, Math.round(spanMs / 3_600_000));
  if (hours >= 24) return 'the last day';
  return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
}

/** Plot placeholder at the chart's exact geometry (y axis, plot, marker row, x labels). */
function ChartSkeleton() {
  return (
    <div
      className="grid h-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] gap-x-3"
      role="status"
      aria-label="Loading chart"
    >
      <div className="flex min-w-6 flex-col justify-between py-0.5">
        {['t4', 't3', 't2', 't1', 't0'].map((key) => (
          <Skeleton key={key} className="h-2.5 w-5" />
        ))}
      </div>
      <Skeleton className="h-full w-full rounded-lg opacity-60" />
      <div />
      <div className="mt-5.5 flex h-4 items-center justify-between px-[4%]">
        {['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].map((key) => (
          <Skeleton key={key} className="h-2.5 w-9" />
        ))}
      </div>
    </div>
  );
}

/** Activity card. */
export function ActivityCard({ activity, rangeLabel, onZoom }: ActivityCardProps) {
  const loading = activity === undefined;
  const bucketMs = activity?.window.bucket_ms ?? 3_600_000;
  const points = activity === undefined ? [] : toPoints(activity.buckets, bucketMs);
  const empty = !loading && points.every((p) => callsOf(p) === 0 && p.sessions_started === 0);
  const sparse = loading || empty ? null : sparseActivitySpan(points);
  const Zoom = ICONS.search;
  return (
    <ChartFrame
      title="Activity"
      description={
        loading || empty ? (
          `Tool calls · ${rangeLabel}`
        ) : sparse !== null && onZoom !== undefined ? (
          `Tool calls per ${bucketWording(bucketMs)} · ${rangeLabel}. All of it happened in ${lastSpanWording(sparse)}.`
        ) : (
          <>
            Tool calls per {bucketWording(bucketMs)} · {rangeLabel}
            <span className="max-sm:hidden">
              . Click a bar to open the sessions of that window.
            </span>
          </>
        )
      }
      series={[
        { id: 'ok', label: 'Calls', color: 'chart-1' },
        { id: 'errors', label: 'Errors', color: 'chart-5' },
        { id: 'starts', label: 'Session started', color: 'chart-3' },
      ]}
      actions={
        sparse !== null && onZoom !== undefined ? (
          <Button type="button" variant="ghost" size="xs" onClick={onZoom}>
            <Zoom aria-hidden="true" />
            Zoom to 24h
          </Button>
        ) : undefined
      }
      isEmpty={empty}
      empty={
        <EmptyState
          kind="zero-data"
          icon="activity"
          title="No activity in this window"
          description="Tool calls appear here as agents work. Widen the range to look further back."
        />
      }
      {...(!loading && {
        table: {
          columns: ['Window', 'Calls', 'Errors', 'Sessions started', 'Sessions closed'],
          rows: points
            .filter((p) => callsOf(p) > 0 || p.sessions_started > 0 || p.sessions_closed > 0)
            .map((p) => [
              bucketRange(p),
              callsOf(p),
              p.errors,
              p.sessions_started,
              p.sessions_closed,
            ]),
        },
      })}
    >
      {loading ? <ChartSkeleton /> : <ActivityChart points={points} bucketMs={bucketMs} />}
    </ChartFrame>
  );
}
