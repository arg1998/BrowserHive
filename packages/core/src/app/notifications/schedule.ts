/** @module app/notifications/schedule — the scheduled reports' calendar (D-43, spec 03 §9.7): the zone maths shared with the dashboard (`@browserhive/contracts/notifications`), the zone fallbacks, and the dates reports print in a channel's zone. */

import { type Weekday, wallTime } from '@browserhive/contracts/notifications';

export {
  digestWindow,
  nextHour,
  nextOccurrence,
  occurrencesBetween,
  parseClock,
  periodMs,
  previousOccurrence,
  scheduleKey,
  type WallTime,
  wallTime,
  zonedInstant,
} from '@browserhive/contracts/notifications';

/** The weekday of a rule as its short English name. */
export function weekdayName(day: Weekday): string {
  return WEEKDAY_LABEL[day];
}

const WEEKDAY_LABEL: { readonly [D in Weekday]: string } = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `09:05` in the zone. */
export function formatClock(at: number, zone: string): string {
  const w = wallTime(at, zone);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

/** `Tue 29 Sep` in the zone. */
export function formatDay(at: number, zone: string): string {
  const w = wallTime(at, zone);
  return `${SHORT_DAYS[w.weekday] ?? ''} ${w.day} ${SHORT_MONTHS[w.month - 1] ?? ''}`;
}

/** `29 Sep 09:00` in the zone. */
export function formatStamp(at: number, zone: string): string {
  const w = wallTime(at, zone);
  return `${w.day} ${SHORT_MONTHS[w.month - 1] ?? ''} ${formatClock(at, zone)}`;
}

/**
 * The span of a weekly window as dates (`22–29 Sep`, `29 Sep – 6 Oct`), in the zone.
 *
 * @returns The text.
 */
export function formatSpan(since: number, until: number, zone: string): string {
  const a = wallTime(since, zone);
  const b = wallTime(until, zone);
  const ma = SHORT_MONTHS[a.month - 1] ?? '';
  const mb = SHORT_MONTHS[b.month - 1] ?? '';
  return a.month === b.month && a.year === b.year
    ? `${a.day}–${b.day} ${mb}`
    : `${a.day} ${ma} – ${b.day} ${mb}`;
}

/**
 * The runtime's default zone (the host's `TZ`, or the system zone), `UTC` when unknown.
 *
 * @returns An IANA zone name.
 */
export function runtimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/**
 * Whether `zone` is usable here; falls back to `fallback` otherwise (a zone the runtime does not
 * know never stops a report).
 *
 * @returns A usable zone.
 */
export function usableZone(zone: string | undefined, fallback: string): string {
  if (zone === undefined) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}
