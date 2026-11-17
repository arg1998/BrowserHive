/** @module domain/site-packs/active-hours.test — `active-hours` arithmetic (spec 13 §9.4): inside and outside a window, wrapping past midnight, `weekdays_only` (the day a window opened counts), the template's IANA timezone (half-hour offsets, a DST jump), the intersection of several sites' windows and windows that never overlap. */

import { describe, expect, it } from 'bun:test';
import { type ActiveWindow, insideWindow, localTime, msUntilActive } from './active-hours.ts';

const H = 3_600_000;
const M = 60_000;
const w = (startHour: number, endHour: number, weekdaysOnly = false): ActiveWindow => ({
  startHour,
  endHour,
  weekdaysOnly,
});
/** 2026-11-17 is a Tuesday; November in Toronto is EST (UTC−5). */
const utc = (day: number, hour: number, minute = 0, second = 0, ms = 0) =>
  Date.UTC(2026, 10, day, hour, minute, second, ms);

describe('localTime', () => {
  it('reads the wall clock of an IANA zone', () => {
    expect(localTime(utc(17, 12), 'UTC')).toEqual({ weekday: 2, hour: 12, minute: 0, second: 0 });
    expect(localTime(utc(17, 3), 'America/Toronto')).toEqual({
      weekday: 1,
      hour: 22,
      minute: 0,
      second: 0,
    });
    expect(localTime(utc(17, 12), 'Asia/Kolkata')).toMatchObject({ hour: 17, minute: 30 });
  });

  it('reads an unknown zone as UTC instead of failing', () => {
    expect(localTime(utc(17, 12), 'Not/AZone').hour).toBe(12);
  });
});

describe('msUntilActive', () => {
  it('is 0 inside the window and the time to its start outside', () => {
    expect(msUntilActive([w(8, 22)], 'UTC', utc(17, 12))).toBe(0);
    expect(msUntilActive([w(8, 22)], 'America/Toronto', utc(17, 12))).toBe(H); // 07:00 local
    expect(msUntilActive([w(8, 22)], 'America/Toronto', utc(17, 12, 20, 30, 250))).toBe(
      39 * M + 29_750,
    );
    // 22:00 is the end (exclusive): the next start is 08:00 tomorrow.
    expect(msUntilActive([w(8, 22)], 'UTC', utc(17, 22))).toBe(10 * H);
  });

  it('follows the template timezone, half-hour offsets included', () => {
    // 12:00Z is 17:30 in Kolkata: an 18–20 window opens in 30 minutes.
    expect(msUntilActive([w(18, 20)], 'Asia/Kolkata', utc(17, 12))).toBe(30 * M);
    expect(msUntilActive([w(18, 20)], 'UTC', utc(17, 12))).toBe(6 * H);
  });

  it('wraps past midnight', () => {
    const night = [w(22, 2)];
    expect(msUntilActive(night, 'UTC', utc(17, 23, 30))).toBe(0);
    expect(msUntilActive(night, 'UTC', utc(18, 1, 59))).toBe(0);
    expect(msUntilActive(night, 'UTC', utc(18, 2))).toBe(20 * H);
    expect(msUntilActive(night, 'UTC', utc(18, 3))).toBe(19 * H);
  });

  it('weekdays_only counts the day the window opened', () => {
    // Saturday 21 Nov 10:00 → Monday 08:00.
    expect(msUntilActive([w(8, 22, true)], 'UTC', utc(21, 10))).toBe(46 * H);
    // Friday night runs into Saturday; the Sunday-night window stays shut into Monday morning.
    expect(msUntilActive([w(22, 2, true)], 'UTC', utc(21, 1))).toBe(0);
    expect(msUntilActive([w(22, 2, true)], 'UTC', utc(22, 23))).toBe(23 * H);
    expect(msUntilActive([w(22, 2, true)], 'UTC', utc(23, 1))).toBe(21 * H);
    // The weekday is the template's: Monday 03:00Z is still Sunday evening in Toronto.
    expect(msUntilActive([w(8, 22, true)], 'America/Toronto', utc(23, 3))).toBe(10 * H);
  });

  it('several sites: the launch must be inside every window', () => {
    expect(msUntilActive([w(8, 22), w(20, 23)], 'UTC', utc(17, 12))).toBe(8 * H);
    expect(msUntilActive([w(8, 22), w(20, 23)], 'UTC', utc(17, 21))).toBe(0);
    expect(msUntilActive([w(8, 10), w(12, 14)], 'UTC', utc(17, 12))).toBeNull();
    expect(msUntilActive([], 'UTC', utc(17, 12))).toBe(0);
  });

  it('counts across a DST jump in the template zone', () => {
    // 14 Mar 2027 in Toronto: 02:00 EST jumps to 03:00 EDT. 06:30Z is 01:30 EST.
    const at = Date.UTC(2027, 2, 14, 6, 30);
    expect(msUntilActive([w(3, 5)], 'America/Toronto', at)).toBe(30 * M);
  });
});

describe('insideWindow', () => {
  it('start inclusive, end exclusive', () => {
    const t = (hour: number) => ({ weekday: 3, hour, minute: 0, second: 0 });
    expect(insideWindow(w(8, 22), t(8))).toBe(true);
    expect(insideWindow(w(8, 22), t(21))).toBe(true);
    expect(insideWindow(w(8, 22), t(22))).toBe(false);
    expect(insideWindow(w(8, 22), t(7))).toBe(false);
  });
});
