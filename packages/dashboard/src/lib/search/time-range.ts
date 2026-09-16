/** @module lib/search/time-range — the time-window vocabulary shared by every windowed surface (spec 04 §11) */
import { z } from 'zod';

/** Trailing windows; `all` means all time, never a silent 168 h. */
export const TIME_RANGES = [
  { value: '24h', label: '24h', ms: 24 * 3_600_000, bucketMs: 3_600_000 },
  { value: '3d', label: '3d', ms: 72 * 3_600_000, bucketMs: 3 * 3_600_000 },
  { value: '7d', label: '7d', ms: 168 * 3_600_000, bucketMs: 6 * 3_600_000 },
  { value: '14d', label: '14d', ms: 336 * 3_600_000, bucketMs: 12 * 3_600_000 },
  { value: '30d', label: '30d', ms: 720 * 3_600_000, bucketMs: 24 * 3_600_000 },
  { value: 'all', label: 'All', ms: null, bucketMs: 24 * 3_600_000 },
] as const;

/** Range value. */
export const TimeRangeValue = z.enum(['24h', '3d', '7d', '14d', '30d', 'all']);
/** Range value. */
export type TimeRangeValue = z.infer<typeof TimeRangeValue>;
/** The default window: a week. */
export const DEFAULT_TIME_RANGE: TimeRangeValue = '7d';

/** `range` search param with the default applied and invalid values corrected. */
export const rangeParam = TimeRangeValue.catch(DEFAULT_TIME_RANGE).default(DEFAULT_TIME_RANGE);

/** Resolve a range to `since`/`until` epoch ms anchored on `now` (`all` → no bounds). */
export function rangeWindow(
  value: TimeRangeValue,
  now: number,
): { readonly since?: number; readonly until?: number; readonly bucketMs: number } {
  const range = TIME_RANGES.find((r) => r.value === value) ?? TIME_RANGES[2];
  if (range.ms === null) return { bucketMs: range.bucketMs };
  return { since: now - range.ms, until: now, bucketMs: range.bucketMs };
}
