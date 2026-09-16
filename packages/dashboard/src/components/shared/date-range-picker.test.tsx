/** @module components/shared/date-range-picker.test — calendar maths, ISO/time parsing and draft resolution, token-boundary wrapping */
import { describe, expect, it } from 'bun:test';
import { breakableParts } from './breakable.tsx';
import { monthMatrix, parseDay, parseTime, resolveDraft } from './date-range-picker.tsx';

describe('date range picker', () => {
  it('lays a month out in six Monday-first weeks', () => {
    const weeks = monthMatrix(2026, 8); // September 2026 starts on a Tuesday
    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]).toEqual({ year: 2026, month: 7, day: 31 });
    expect(weeks[0]?.[1]).toEqual({ year: 2026, month: 8, day: 1 });
  });

  it('parses real ISO dates and 24h times only', () => {
    expect(parseDay('2026-02-28')).toEqual({ year: 2026, month: 1, day: 28 });
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('dd/mm/yyyy')).toBeNull();
    expect(parseTime('')).toBeUndefined();
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime('24:00')).toBeNull();
  });

  it('includes the whole To day unless a time is given, and rejects inverted windows', () => {
    const whole = resolveDraft({ from: '2026-09-01', fromTime: '', to: '2026-09-02', toTime: '' });
    expect(whole).toEqual({
      since: new Date(2026, 8, 1).getTime(),
      until: new Date(2026, 8, 3).getTime() - 1,
    });
    const timed = resolveDraft({
      from: '2026-09-01',
      fromTime: '08:30',
      to: '2026-09-01',
      toTime: '09:00',
    });
    expect(timed).toEqual({
      since: new Date(2026, 8, 1, 8, 30).getTime(),
      until: new Date(2026, 8, 1, 9, 1).getTime() - 1,
    });
    expect(resolveDraft({ from: '', fromTime: '', to: '', toTime: '' })).toBeNull();
    expect(
      resolveDraft({ from: '2026-09-05', fromTime: '', to: '2026-09-01', toTime: '' }),
    ).toEqual({
      error: 'From must be before To.',
    });
  });
});

describe('breakable', () => {
  it('splits after path and URL boundaries, never inside a segment', () => {
    expect(breakableParts('/var/lib/browserhive/profiles')).toEqual([
      '/',
      'var/',
      'lib/',
      'browserhive/',
      'profiles',
    ]);
    expect(breakableParts('Mozilla/5.0 (X11)').join('')).toBe('Mozilla/5.0 (X11)');
    expect(breakableParts('plain')).toEqual(['plain']);
  });
});
