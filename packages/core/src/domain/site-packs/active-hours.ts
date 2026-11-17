/** @module domain/site-packs/active-hours — the `active-hours` window arithmetic (spec 13 §9.4): whether an instant is inside every window of a template's sites in the template's pinned timezone, and how long until it is. Wall-clock time in an IANA zone comes from `Intl.DateTimeFormat`; the instant is always given (the caller's clock). */

import type { StrategyParams } from './strategy-params.ts';

/** One `active-hours` window (start inclusive, end exclusive; wraps past midnight when start > end). */
export type ActiveWindow = StrategyParams['active-hours'];

/** Local wall-clock parts of an instant in a timezone. */
export interface LocalTime {
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const HOUR_MS = 3_600_000;
/** How far ahead the next opening is searched (a week and a day covers `weekdays_only`). */
const SEARCH_HOURS = 8 * 24;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    // An unknown zone (never stored: creation resolves it) reads as UTC rather than failing a launch.
    made = formatterOf('UTC');
  }
  formatters.set(timeZone, made);
  return made;
}

/** The wall-clock parts of `at` (epoch ms) in `timeZone`. */
export function localTime(at: number, timeZone: string): LocalTime {
  const parts = formatterOf(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: WEEKDAYS[part('weekday')] ?? 0,
    hour: Number(part('hour')) % 24,
    minute: Number(part('minute')),
    second: Number(part('second')),
  };
}

/**
 * Whether local time `t` is inside `window`. With `weekdays_only`, the day that counts is the day
 * the window opened: a 22–02 window opened on Friday runs into Saturday, and the one Sunday night
 * opens is closed.
 */
export function insideWindow(window: ActiveWindow, t: LocalTime): boolean {
  const { startHour: start, endHour: end } = window;
  const wraps = start > end;
  const inside = wraps ? t.hour >= start || t.hour < end : t.hour >= start && t.hour < end;
  if (!inside) return false;
  if (!window.weekdaysOnly) return true;
  const openedOn = wraps && t.hour < end ? (t.weekday + 6) % 7 : t.weekday;
  return openedOn !== 0 && openedOn !== 6;
}

/**
 * Milliseconds from `now` until a launch is inside every window (the intersection: a template on
 * several sites launches only when all their windows are open): `0` inside, `null` when the
 * windows never overlap within the next eight days. Only whole local hours open a window.
 */
export function msUntilActive(
  windows: readonly ActiveWindow[],
  timeZone: string,
  now: number,
): number | null {
  const inside = (at: number) => {
    const t = localTime(at, timeZone);
    return windows.every((w) => insideWindow(w, t));
  };
  if (windows.length === 0 || inside(now)) return 0;
  let at = nextLocalHour(now, timeZone);
  for (let i = 0; i < SEARCH_HOURS; i++) {
    if (inside(at)) return at - now;
    at = nextLocalHour(at, timeZone);
  }
  return null;
}

/** The first instant after `at` that starts a local hour (offsets of 30 or 45 minutes included). */
function nextLocalHour(at: number, timeZone: string): number {
  const t = localTime(at, timeZone);
  const intoHour = (t.minute * 60 + t.second) * 1000 + (((at % 1000) + 1000) % 1000);
  return at - intoHour + HOUR_MS;
}
