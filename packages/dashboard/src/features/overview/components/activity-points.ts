/** @module features/overview/components/activity-points — pure chart maths for the activity chart: bucket → point shaping, "nice" y-axis scale, x-axis label selection and bucket wording (unit-tested) */
import type { ActivityBucket } from '@browserhive/contracts/http';
import { formatAbsoluteShort } from '@/lib/format/time.ts';

/** One plotted bucket. */
export interface ActivityPoint {
  readonly ts: number;
  readonly end: number;
  /** Calls without an error (the stack sums to all calls). */
  readonly ok: number;
  readonly errors: number;
  readonly sessions_started: number;
  readonly sessions_closed: number;
  readonly label: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Shape buckets for the chart (ok = calls − errors so the stack sums to calls). */
export function toPoints(buckets: readonly ActivityBucket[], bucketMs: number): ActivityPoint[] {
  return buckets.map((b) => ({
    ts: b.ts,
    end: b.ts + bucketMs,
    ok: Math.max(0, b.tool_calls - b.errors),
    errors: b.errors,
    sessions_started: b.sessions_started,
    sessions_closed: b.sessions_closed,
    label: formatAbsoluteShort(b.ts),
  }));
}

/** Total calls of a point. */
export function callsOf(point: Pick<ActivityPoint, 'ok' | 'errors'>): number {
  return point.ok + point.errors;
}

/** Y-axis scale: a round top value and evenly spaced integer ticks from 0. */
export interface NiceScale {
  readonly max: number;
  readonly ticks: readonly number[];
}

/**
 * The smallest "nice" scale (steps of 1, 2, 2.5 or 5 × 10ⁿ, integers only) that holds `value` in at
 * most `maxIntervals` intervals. 108 → 0‥125 by 25; 70 → 0‥80 by 20; 3 → 0‥3 by 1; 0 → 0‥4 by 1.
 */
export function niceScale(value: number, maxIntervals = 5): NiceScale {
  const top = Math.max(0, Math.ceil(value));
  if (top === 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = top / maxIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = 1;
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const candidate = factor * magnitude;
    if (Number.isInteger(candidate) && candidate >= raw) {
      step = candidate;
      break;
    }
  }
  step = Math.max(1, step);
  const intervals = Math.max(1, Math.ceil(top / step));
  const ticks = Array.from({ length: intervals + 1 }, (_, i) => i * step);
  return { max: intervals * step, ticks };
}

/** An x-axis label under bucket `index`, centred over the `span` buckets it names (a day of 6h buckets spans 4). */
export interface AxisLabel {
  readonly index: number;
  readonly text: string;
  readonly span: number;
}

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Pick at most `maxLabels` x-axis labels. Sub-day buckets over a multi-day window are labelled at the
 * first bucket of each local day ("Sep 10"); windows up to a day use clock times ("14:00"); daily
 * buckets use dates. Labels are thinned evenly when there are too many.
 */
export function axisLabels(
  points: readonly Pick<ActivityPoint, 'ts'>[],
  bucketMs: number,
  maxLabels = 8,
): AxisLabel[] {
  if (points.length === 0) return [];
  const first = points[0]?.ts ?? 0;
  const last = points.at(-1)?.ts ?? first;
  const span = last - first + bucketMs;
  let candidates: AxisLabel[];
  if (span <= DAY + bucketMs && bucketMs < DAY) {
    candidates = points.map((p, index) => ({ index, text: hourFormat.format(p.ts), span: 1 }));
  } else if (bucketMs < DAY) {
    const days: { index: number; text: string; span: number }[] = [];
    points.forEach((p, index) => {
      const previous = index === 0 ? undefined : points[index - 1];
      if (previous === undefined || dayKey(previous.ts) !== dayKey(p.ts)) {
        days.push({ index, text: dayFormat.format(p.ts), span: 1 });
      } else {
        const current = days.at(-1);
        if (current !== undefined) current.span += 1;
      }
    });
    // A partial day is only labelled when at least half of it is in the window, so its label
    // (centred over its buckets) never crowds the neighbouring day's.
    const perDay = Math.max(1, Math.round(DAY / bucketMs));
    candidates = days.filter((d) => d.span * 2 >= perDay);
  } else {
    candidates = points.map((p, index) => ({ index, text: dayFormat.format(p.ts), span: 1 }));
  }
  if (candidates.length <= maxLabels) return candidates;
  const stride = Math.ceil(candidates.length / maxLabels);
  return candidates.filter((_, i) => i % stride === 0);
}

/**
 * When a trailing window holds activity in fewer than 3 buckets, all of it inside the last day, the
 * chart is a single bar at the right edge; return the span (ms) that holds all of it so the card can
 * say so and offer a zoom. `null` when the chart already reads well.
 */
export function sparseActivitySpan(points: readonly ActivityPoint[]): number | null {
  const active = points.filter((p) => callsOf(p) > 0 || p.sessions_started > 0);
  const first = active[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || active.length >= 3) return null;
  const spanMs = last.end - first.ts;
  return spanMs <= DAY && points.length > 8 ? spanMs : null;
}

/** "6 hours" / "hour" / "day" wording of a bucket size for the chart description. */
export function bucketWording(bucketMs: number): string {
  if (bucketMs % DAY === 0) return bucketMs === DAY ? 'day' : `${bucketMs / DAY} days`;
  if (bucketMs % HOUR === 0) return bucketMs === HOUR ? 'hour' : `${bucketMs / HOUR} hours`;
  const minutes = Math.round(bucketMs / 60_000);
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}
