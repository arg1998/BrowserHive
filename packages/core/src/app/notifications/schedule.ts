/** @module app/notifications/schedule — pure calendar maths of the scheduled reports (D-43, spec 03 §9.7): wall-clock times in an IANA zone with DST handled (a skipped time is shifted by the gap, a repeated one fires once), the occurrences of a digest rule, its windows, the next run, the hourly anomaly slots, and the dates reports print. */

import type { DigestRule, Weekday } from '@browserhive/contracts/notifications';
import { WEEKDAYS } from '@browserhive/contracts/notifications';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Longest span enumerated for missed occurrences; older ones are only counted. */
const MAX_SCAN_MS = 400 * DAY;

/** A calendar date and wall-clock time in some zone. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Monday … 6 = Sunday. */
  readonly weekday: number;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = FORMATS.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    FORMATS.set(zone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/**
 * The wall-clock time of an instant in `zone`.
 *
 * @returns Year, month (1–12), day, hour (0–23), minute and weekday (0 = Monday).
 */
export function wallTime(at: number, zone: string): WallTime {
  const parts = formatter(zone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Offset of `zone` from UTC at an instant (local − UTC, ms). */
function offsetAt(at: number, zone: string): number {
  const w = wallTime(at, zone);
  const local = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return local - Math.floor(at / MINUTE) * MINUTE;
}

/**
 * The instant a wall-clock time has in `zone`. A time that occurs twice (fall back) resolves to
 * its first occurrence; a time that does not exist (spring forward) is shifted forward by the gap
 * (02:30 on a night that jumps from 02:00 to 03:00 is 03:30).
 *
 * @returns Epoch ms.
 */
export function zonedInstant(
  date: { readonly year: number; readonly month: number; readonly day: number },
  clock: { readonly hour: number; readonly minute: number },
  zone: string,
): number {
  const local = Date.UTC(date.year, date.month - 1, date.day, clock.hour, clock.minute);
  const before = offsetAt(local - 12 * HOUR, zone);
  const after = offsetAt(local + 12 * HOUR, zone);
  const matches = (at: number) => {
    const w = wallTime(at, zone);
    return (
      w.year === date.year &&
      w.month === date.month &&
      w.day === date.day &&
      w.hour === clock.hour &&
      w.minute === clock.minute
    );
  };
  const candidates = [local - before, local - after].filter(matches).sort((a, b) => a - b);
  const first = candidates[0];
  // No candidate: the time falls in a spring-forward gap. The pre-transition offset lands the
  // same distance past the gap's end.
  return first ?? local - before;
}

/** `HH:MM` as hour and minute. */
export function parseClock(at: string): { hour: number; minute: number } {
  const [h = '0', m = '0'] = at.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/** The date `n` days after a calendar date (pure calendar arithmetic, no zone). */
function addDays(
  date: { readonly year: number; readonly month: number; readonly day: number },
  n: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Weekday index (0 = Monday) of a calendar date. */
function weekdayOf(date: { readonly year: number; readonly month: number; readonly day: number }) {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

/** The weekday a rule fires on (weekly), as an index; `null` for a daily rule. */
function ruleWeekday(rule: DigestRule): number | null {
  if (rule.every !== 'week') return null;
  return WEEKDAYS.indexOf(rule.day ?? 'mon');
}

/** Nominal length of one period of a rule. */
export function periodMs(rule: DigestRule): number {
  return rule.every === 'week' ? 7 * DAY : DAY;
}

/**
 * Every scheduled instant of a rule in `(from, to]`, oldest first. A span longer than 400 days is
 * scanned from 400 days before `to` only; `older` counts the occurrences before that (nominally).
 *
 * @returns The occurrences and the count of older ones not enumerated.
 */
export function occurrencesBetween(
  rule: DigestRule,
  zone: string,
  from: number,
  to: number,
): { readonly at: readonly number[]; readonly older: number } {
  if (to <= from) return { at: [], older: 0 };
  const start = Math.max(from, to - MAX_SCAN_MS);
  const older = start > from ? Math.floor((start - from) / periodMs(rule)) : 0;
  const clock = parseClock(rule.at);
  const weekday = ruleWeekday(rule);
  const out: number[] = [];
  let date = addDays(wallTime(start, zone), -1);
  const last = addDays(wallTime(to, zone), 1);
  const lastKey = Date.UTC(last.year, last.month - 1, last.day);
  while (Date.UTC(date.year, date.month - 1, date.day) <= lastKey) {
    if (weekday === null || weekdayOf(date) === weekday) {
      const at = zonedInstant(date, clock, zone);
      if (at > start && at <= to) out.push(at);
    }
    date = addDays(date, 1);
  }
  return { at: out, older };
}

/**
 * The first scheduled instant strictly after `after`.
 *
 * @returns Epoch ms.
 */
export function nextOccurrence(rule: DigestRule, zone: string, after: number): number {
  const clock = parseClock(rule.at);
  const weekday = ruleWeekday(rule);
  let date = addDays(wallTime(after, zone), -1);
  for (let i = 0; i < 16; i++) {
    if (weekday === null || weekdayOf(date) === weekday) {
      const at = zonedInstant(date, clock, zone);
      if (at > after) return at;
    }
    date = addDays(date, 1);
  }
  return after + periodMs(rule);
}

/**
 * The last scheduled instant strictly before `before`.
 *
 * @returns Epoch ms.
 */
export function previousOccurrence(rule: DigestRule, zone: string, before: number): number {
  const clock = parseClock(rule.at);
  const weekday = ruleWeekday(rule);
  let date = addDays(wallTime(before, zone), 1);
  for (let i = 0; i < 16; i++) {
    if (weekday === null || weekdayOf(date) === weekday) {
      const at = zonedInstant(date, clock, zone);
      if (at < before) return at;
    }
    date = addDays(date, -1);
  }
  return before - periodMs(rule);
}

/**
 * The window a report scheduled at `occurrence` covers: from the previous scheduled instant (23
 * or 25 hours before across a DST change) to `occurrence`, starting no earlier than the end of the
 * last window already reported.
 *
 * @returns `{since, until}`.
 */
export function digestWindow(
  rule: DigestRule,
  zone: string,
  occurrence: number,
  lastUntil: number | null,
): { readonly since: number; readonly until: number } {
  const previous = previousOccurrence(rule, zone, occurrence);
  const since =
    lastUntil !== null && lastUntil > previous && lastUntil < occurrence ? lastUntil : previous;
  return { since, until: occurrence };
}

/** Identity of a rule in a zone: a change re-arms the schedule (spec 03 §9.7). */
export function scheduleKey(rule: DigestRule, zone: string): string {
  const day = rule.every === 'week' ? `:${rule.day ?? 'mon'}` : '';
  return `${rule.every}${day}@${rule.at}@${zone}`;
}

/** The next top of the hour after `after` (the anomaly slots, UTC-aligned). */
export function nextHour(after: number): number {
  return Math.floor(after / HOUR) * HOUR + HOUR;
}

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
    formatter(zone);
    return zone;
  } catch {
    return fallback;
  }
}
