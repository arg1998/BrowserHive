/** @module app/notifications/schedule.test — the calendar maths of scheduled reports (D-43, spec 03 §9.7): wall-clock instants across DST in both directions, daily and weekly occurrences, 23/24/25-hour windows, host vs channel zone, the next run and the dates reports print. */

import { describe, expect, it } from 'bun:test';
import type { DigestRule } from '@browserhive/contracts/notifications';
import {
  digestWindow,
  formatDay,
  formatSpan,
  formatStamp,
  nextHour,
  nextOccurrence,
  occurrencesBetween,
  previousOccurrence,
  scheduleKey,
  usableZone,
  wallTime,
  zonedInstant,
} from './schedule.ts';

const HOUR = 3_600_000;
const DAILY_9: DigestRule = { every: 'day', at: '09:00' };
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('zonedInstant', () => {
  const cases: readonly [string, string, [number, number, number], [number, number], number][] = [
    ['summer time', 'Europe/Berlin', [2026, 9, 29], [9, 0], utc(2026, 9, 29, 7)],
    ['winter time', 'Europe/Berlin', [2026, 12, 1], [9, 0], utc(2026, 12, 1, 8)],
    // 02:30 does not exist on 29 Mar 2026 in Berlin (02:00 → 03:00): shifted to 03:30 CEST.
    ['spring forward (gap)', 'Europe/Berlin', [2026, 3, 29], [2, 30], utc(2026, 3, 29, 1, 30)],
    // 02:30 happens twice on 25 Oct 2026 in Berlin: the first one (CEST, 00:30 UTC).
    ['fall back (repeat)', 'Europe/Berlin', [2026, 10, 25], [2, 30], utc(2026, 10, 25, 0, 30)],
    ['New York spring forward', 'America/New_York', [2026, 3, 8], [2, 30], utc(2026, 3, 8, 7, 30)],
    ['New York fall back', 'America/New_York', [2026, 11, 1], [1, 30], utc(2026, 11, 1, 5, 30)],
    ['half-hour zone', 'Asia/Kolkata', [2026, 9, 29], [9, 0], utc(2026, 9, 29, 3, 30)],
    ['UTC', 'UTC', [2026, 9, 29], [9, 0], utc(2026, 9, 29, 9)],
  ];
  for (const [name, zone, [year, month, day], [hour, minute], expected] of cases) {
    it(name, () => {
      expect(zonedInstant({ year, month, day }, { hour, minute }, zone)).toBe(expected);
    });
  }

  it('reads the wall clock back', () => {
    expect(wallTime(utc(2026, 3, 29, 1, 30), 'Europe/Berlin')).toMatchObject({
      hour: 3,
      minute: 30,
      weekday: 6,
    });
  });
});

describe('occurrences and windows', () => {
  it('lists a daily schedule in its zone, oldest first', () => {
    const from = utc(2026, 9, 27, 12);
    const to = utc(2026, 9, 30, 12);
    expect(occurrencesBetween(DAILY_9, 'Europe/Berlin', from, to).at).toEqual([
      utc(2026, 9, 28, 7),
      utc(2026, 9, 29, 7),
      utc(2026, 9, 30, 7),
    ]);
  });

  it('is exclusive of from and inclusive of to', () => {
    const at = utc(2026, 9, 29, 7);
    expect(occurrencesBetween(DAILY_9, 'Europe/Berlin', at, at + HOUR).at).toEqual([]);
    expect(occurrencesBetween(DAILY_9, 'Europe/Berlin', at - HOUR, at).at).toEqual([at]);
  });

  it('gives 23-, 24- and 25-hour windows across the DST changes', () => {
    const zone = 'Europe/Berlin';
    const span = (occ: number) => {
      const w = digestWindow(DAILY_9, zone, occ, null);
      return (w.until - w.since) / HOUR;
    };
    // The night of 28→29 Mar 2026 is an hour short; 24→25 Oct is an hour long.
    expect(span(utc(2026, 3, 29, 7))).toBe(23);
    expect(span(utc(2026, 3, 30, 7))).toBe(24);
    expect(span(utc(2026, 10, 25, 8))).toBe(25);
  });

  it('fires once on a repeated local time and at the shifted time on a skipped one', () => {
    const at230: DigestRule = { every: 'day', at: '02:30' };
    const fallBack = occurrencesBetween(
      at230,
      'Europe/Berlin',
      utc(2026, 10, 24, 12),
      utc(2026, 10, 25, 12),
    );
    expect(fallBack.at).toEqual([utc(2026, 10, 25, 0, 30)]);
    const springForward = occurrencesBetween(
      at230,
      'Europe/Berlin',
      utc(2026, 3, 28, 12),
      utc(2026, 3, 29, 12),
    );
    expect(springForward.at).toEqual([utc(2026, 3, 29, 1, 30)]);
  });

  it('keeps a weekly schedule on its weekday', () => {
    const weekly: DigestRule = { every: 'week', at: '08:30', day: 'mon' };
    const found = occurrencesBetween(weekly, 'Europe/Berlin', utc(2026, 9, 20), utc(2026, 10, 12));
    expect(found.at).toEqual(
      [
        utc(2026, 9, 21, 6, 30),
        utc(2026, 9, 28, 6, 30),
        utc(2026, 10, 5, 6, 30),
        utc(2026, 10, 12, 6, 30),
      ].filter((t) => t <= utc(2026, 10, 12)),
    );
    for (const at of found.at) expect(wallTime(at, 'Europe/Berlin').weekday).toBe(0);
    const w = digestWindow(weekly, 'Europe/Berlin', utc(2026, 9, 28, 6, 30), null);
    expect(w.since).toBe(utc(2026, 9, 21, 6, 30));
  });

  it('runs a weekly rule without a day on Friday, covering the full seven days (D-43)', () => {
    const weekly: DigestRule = { every: 'week', at: '17:00' };
    const found = occurrencesBetween(weekly, 'Europe/Berlin', utc(2026, 9, 21), utc(2026, 10, 3));
    // Fri 25 Sep and Fri 2 Oct at 17:00 in Berlin (UTC+2).
    expect(found.at).toEqual([utc(2026, 9, 25, 15), utc(2026, 10, 2, 15)]);
    const w = digestWindow(weekly, 'Europe/Berlin', utc(2026, 10, 2, 15), null);
    expect(w).toEqual({ since: utc(2026, 9, 25, 15), until: utc(2026, 10, 2, 15) });
    expect((w.until - w.since) / HOUR).toBe(7 * 24);
  });

  it('runs every day, weekends included, unless weekdays only (D-43)', () => {
    const zone = 'Europe/Berlin';
    // Mon 21 Sep → Mon 28 Sep 2026: seven daily runs, five with weekdays only.
    const every = occurrencesBetween(DAILY_9, zone, utc(2026, 9, 21, 8), utc(2026, 9, 28, 8));
    expect(every.at).toHaveLength(7);
    const weekdays: DigestRule = { ...DAILY_9, weekdays_only: true };
    const found = occurrencesBetween(weekdays, zone, utc(2026, 9, 21, 8), utc(2026, 9, 28, 8));
    expect(found.at.map((at) => wallTime(at, zone).weekday)).toEqual([1, 2, 3, 4, 0]);
    // Monday's digest starts at Friday's run: the weekend is in it.
    const monday = digestWindow(weekdays, zone, utc(2026, 9, 28, 7), null);
    expect(monday).toEqual({ since: utc(2026, 9, 25, 7), until: utc(2026, 9, 28, 7) });
    expect(nextOccurrence(weekdays, zone, utc(2026, 9, 25, 8))).toBe(utc(2026, 9, 28, 7));
    expect(previousOccurrence(weekdays, zone, utc(2026, 9, 28, 7))).toBe(utc(2026, 9, 25, 7));
  });

  it('keeps weekdays only on the wall clock across a DST week', () => {
    const zone = 'Europe/Berlin';
    const weekdays: DigestRule = { ...DAILY_9, weekdays_only: true };
    // Clocks go back on Sun 25 Oct 2026: Friday 09:00 is 07:00 UTC, Monday 09:00 is 08:00 UTC.
    const found = occurrencesBetween(weekdays, zone, utc(2026, 10, 22, 12), utc(2026, 10, 27, 12));
    expect(found.at).toEqual([utc(2026, 10, 23, 7), utc(2026, 10, 26, 8), utc(2026, 10, 27, 8)]);
    const monday = digestWindow(weekdays, zone, utc(2026, 10, 26, 8), null);
    // Friday 09:00 CEST → Monday 09:00 CET: 73 hours (the weekend and the extra hour).
    expect((monday.until - monday.since) / HOUR).toBe(73);
  });

  it('starts a window at the end of the last one when that is later', () => {
    const occ = utc(2026, 9, 29, 7);
    const lastUntil = utc(2026, 9, 28, 16);
    expect(digestWindow(DAILY_9, 'Europe/Berlin', occ, lastUntil)).toEqual({
      since: lastUntil,
      until: occ,
    });
    expect(digestWindow(DAILY_9, 'Europe/Berlin', occ, utc(2026, 9, 1)).since).toBe(
      utc(2026, 9, 28, 7),
    );
  });

  it('follows the channel zone, not the host zone', () => {
    const from = utc(2026, 9, 28, 23);
    const to = utc(2026, 9, 29, 22, 59);
    expect(occurrencesBetween(DAILY_9, 'Asia/Tokyo', from, to).at).toEqual([utc(2026, 9, 29, 0)]);
    expect(occurrencesBetween(DAILY_9, 'America/New_York', from, to).at).toEqual([
      utc(2026, 9, 29, 13),
    ]);
  });

  it('counts, without listing, occurrences older than 400 days', () => {
    const to = utc(2026, 9, 29, 12);
    const r = occurrencesBetween(DAILY_9, 'UTC', to - 500 * 24 * HOUR, to);
    expect(r.at.length).toBe(400);
    expect(r.older).toBe(100);
  });

  it('knows the next and previous runs', () => {
    const now = utc(2026, 9, 29, 10);
    expect(nextOccurrence(DAILY_9, 'Europe/Berlin', now)).toBe(utc(2026, 9, 30, 7));
    expect(previousOccurrence(DAILY_9, 'Europe/Berlin', now)).toBe(utc(2026, 9, 29, 7));
    expect(nextHour(utc(2026, 9, 29, 10, 20))).toBe(utc(2026, 9, 29, 11));
  });
});

describe('keys, zones and labels', () => {
  it('changes the schedule key with the zone or the rule', () => {
    expect(scheduleKey(DAILY_9, 'UTC')).toBe('day@09:00@UTC');
    // A weekly rule without a day runs on Friday (D-43).
    expect(scheduleKey({ every: 'week', at: '09:00' }, 'UTC')).toBe('week:fri@09:00@UTC');
    expect(scheduleKey({ ...DAILY_9, weekdays_only: true }, 'UTC')).toBe('day-weekdays@09:00@UTC');
    expect(scheduleKey(DAILY_9, 'Europe/Berlin')).not.toBe(scheduleKey(DAILY_9, 'UTC'));
  });

  it('falls back from an unknown zone', () => {
    expect(usableZone('Mars/Olympus', 'UTC')).toBe('UTC');
    expect(usableZone(undefined, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(usableZone('Asia/Tokyo', 'UTC')).toBe('Asia/Tokyo');
  });

  it('prints dates in the zone', () => {
    const at = utc(2026, 9, 28, 23, 30);
    expect(formatDay(at, 'UTC')).toBe('Mon 28 Sep');
    expect(formatDay(at, 'Asia/Tokyo')).toBe('Tue 29 Sep');
    expect(formatStamp(at, 'Europe/Berlin')).toBe('29 Sep 01:30');
    expect(formatSpan(utc(2026, 9, 21, 7), utc(2026, 9, 28, 7), 'UTC')).toBe('21–28 Sep');
    expect(formatSpan(utc(2026, 9, 28, 7), utc(2026, 10, 5, 7), 'UTC')).toBe('28 Sep – 5 Oct');
  });
});
