/** @module features/overview/components/ActivityChart — HTML stacked-bar activity chart: nice y-axis, day/clock x labels, every non-empty bucket is a real link to `/sessions?since&until` (hover column highlight + pointer + focus ring; on touch the first tap selects and the second opens), a hover/focus tooltip owned by React state that clears when the pointer leaves the plot (never sticks) */
import { useState } from 'react';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { cn } from '@/lib/utils.ts';
import {
  type ActivityPoint,
  axisLabels,
  callsOf,
  type NiceScale,
  niceScale,
} from './activity-points.ts';

/** Props. */
export interface ActivityChartProps {
  readonly points: readonly ActivityPoint[];
  readonly bucketMs: number;
  readonly className?: string;
}

const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Sep 16, 08:00 – 14:00" (end date repeated only when it differs). */
export function bucketRange(point: Pick<ActivityPoint, 'ts' | 'end'>): string {
  const start = new Date(point.ts);
  const end = new Date(point.end);
  const sameDay = start.toDateString() === new Date(point.end - 1).toDateString();
  return `${dateTime.format(start)} – ${sameDay ? clock.format(end) : dateTime.format(end)}`;
}

/** Sessions list filtered to a bucket's window. */
export function sessionsWindowHref(point: Pick<ActivityPoint, 'ts' | 'end'>): string {
  return `/sessions?since=${point.ts}&until=${point.end}`;
}

function pct(value: number, scale: NiceScale): string {
  return `${(value / scale.max) * 100}%`;
}

function Tooltip({
  point,
  index,
  count,
}: {
  readonly point: ActivityPoint;
  readonly index: number;
  readonly count: number;
}) {
  // Beside the hovered column (right of it on the left half, left of it on the right half), pinned
  // to the top of the plot: it never covers the bar being read and never leaves the card.
  const right = (index + 0.5) / count < 0.5;
  const calls = callsOf(point);
  return (
    <div
      role="presentation"
      className={cn(
        'pointer-events-none absolute top-2 z-(--z-popover) w-max min-w-44 rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-popover',
        right ? 'ml-2' : '-ml-2 -translate-x-full',
      )}
      style={{ left: `${((right ? index + 1 : index) / count) * 100}%` }}
    >
      <p className="text-xs font-medium text-muted-foreground">{bucketRange(point)}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-0.5 tabular-nums">
        <dt className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-chart-1" />
          Calls
        </dt>
        <dd className="text-right font-medium">{formatNumber(calls)}</dd>
        <dt className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-chart-5" />
          Errors
        </dt>
        <dd className="text-right font-medium">{formatNumber(point.errors)}</dd>
        <dt className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-chart-3" />
          Sessions started
        </dt>
        <dd className="text-right font-medium">{formatNumber(point.sessions_started)}</dd>
      </dl>
      {calls > 0 || point.sessions_started > 0 ? (
        <p className="mt-1.5 border-t pt-1.5 text-xs text-muted-foreground">
          <span className="pointer-coarse:hidden">Click to open these sessions</span>
          <span className="hidden pointer-coarse:inline">Tap again to open these sessions</span>
        </p>
      ) : null}
    </div>
  );
}

/** Activity chart. */
export function ActivityChart({ points, bucketMs, className }: ActivityChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const go = useHrefNavigate();
  const peak = Math.max(0, ...points.map(callsOf));
  const scale = niceScale(peak, 4);
  const labels = axisLabels(points, bucketMs);
  const count = Math.max(1, points.length);
  const hovered = active === null ? undefined : points[active];
  const hasStarts = points.some((p) => p.sessions_started > 0);
  const dense = points.length > 60;
  return (
    <div
      className={cn(
        'grid h-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] gap-x-3',
        className,
      )}
      data-testid="activity-chart"
    >
      {/* Y axis */}
      <div aria-hidden="true" className="relative min-w-6">
        {scale.ticks.map((tick) => (
          <span
            key={tick}
            className="absolute right-0 translate-y-1/2 text-xs leading-none text-chart-axis tabular-nums"
            style={{ bottom: pct(tick, scale) }}
          >
            {formatNumber(tick)}
          </span>
        ))}
        {/* width holder for the widest tick */}
        <span className="invisible text-xs tabular-nums">{formatNumber(scale.max)}</span>
      </div>

      {/* Plot */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only tooltip dismissal; bars drive it on focus/blur */}
      <div className="relative min-h-0" onMouseLeave={() => setActive(null)}>
        {scale.ticks.map((tick) => (
          <span
            key={tick}
            aria-hidden="true"
            className={cn(
              'absolute inset-x-0 border-t',
              tick === 0 ? 'border-chart-axis/40' : 'border-dashed border-chart-grid',
            )}
            style={{ bottom: pct(tick, scale) }}
          />
        ))}
        <ol
          aria-label="Tool calls per bucket"
          className={cn('absolute inset-0 flex items-stretch', dense ? 'gap-px' : 'gap-0.5')}
        >
          {points.map((point, index) => {
            const calls = callsOf(point);
            const interactive = calls > 0 || point.sessions_started > 0;
            const label = `${bucketRange(point)}: ${formatNumber(calls)} calls, ${formatNumber(point.errors)} errors, ${formatNumber(point.sessions_started)} sessions started`;
            const bars = (
              <span className="mx-auto flex h-full w-full max-w-10 flex-col justify-end gap-0.5">
                {point.errors > 0 ? (
                  <span
                    className={cn(
                      'block w-full shrink-0 rounded-t-[4px] bg-chart-5 transition-[filter]',
                      point.ok === 0 && 'rounded-b-[1px]',
                    )}
                    style={{ height: `max(3px, calc(${pct(point.errors, scale)} - 2px))` }}
                  />
                ) : null}
                {point.ok > 0 ? (
                  <span
                    className={cn(
                      'block w-full shrink-0 bg-chart-1 transition-[filter]',
                      point.errors === 0 ? 'rounded-t-[4px]' : 'rounded-t-[1px]',
                    )}
                    style={{ height: `max(3px, ${pct(point.ok, scale)})` }}
                  />
                ) : null}
              </span>
            );
            const columnClass = cn(
              'flex h-full w-full rounded-sm focus-ring-inset',
              dense ? 'px-0' : 'px-[14%]',
            );
            return (
              <li
                key={point.ts}
                className="relative flex min-w-0 flex-1"
                onMouseEnter={() => setActive(index)}
              >
                {interactive ? (
                  <a
                    href={sessionsWindowHref(point)}
                    aria-label={label}
                    onClick={(event) => {
                      if (!isPlainClick(event)) return;
                      event.preventDefault();
                      // Bars are a few px wide on a phone: the first tap selects (tooltip), a second
                      // tap on the same bar opens it, so a near-miss never navigates somewhere else.
                      const touch =
                        (event.nativeEvent as PointerEvent).pointerType === 'touch' ||
                        (event.nativeEvent as PointerEvent).pointerType === 'pen';
                      if (touch && active !== index) {
                        setActive(index);
                        return;
                      }
                      go(sessionsWindowHref(point));
                    }}
                    className={cn(
                      columnClass,
                      'group/bar hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] [&:hover_span_span]:brightness-110',
                      active === index && 'bg-foreground/[0.05]',
                    )}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                  >
                    {bars}
                  </a>
                ) : (
                  <span className={columnClass}>
                    <span className="sr-only">{label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {hovered !== undefined && active !== null ? (
          <Tooltip point={hovered} index={active} count={count} />
        ) : null}
      </div>

      {/* Session-start markers (row always reserved so the plot height never depends on data) + x labels */}
      <div />
      <div aria-hidden="true" className="flex flex-col">
        <div className="relative mt-1.5 h-2">
          {hasStarts
            ? points.map((point, index) =>
                point.sessions_started > 0 ? (
                  <span
                    key={point.ts}
                    className="absolute top-0 size-2 -translate-x-1/2 rounded-full bg-chart-3"
                    style={{ left: `${((index + 0.5) / count) * 100}%` }}
                  />
                ) : null,
              )
            : null}
        </div>
        <div className="relative mt-2 h-4">
          {labels.map((label, i) => {
            const center = ((label.index + label.span / 2) / count) * 100;
            return (
              <span
                key={label.index}
                className={cn(
                  'absolute top-0 text-xs leading-4 whitespace-nowrap text-chart-axis',
                  center < 4 ? '' : center > 96 ? '-translate-x-full' : '-translate-x-1/2',
                  i % 2 === 1 && 'max-sm:hidden',
                )}
                style={{ left: center < 4 ? '0%' : center > 96 ? '100%' : `${center}%` }}
              >
                {label.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
