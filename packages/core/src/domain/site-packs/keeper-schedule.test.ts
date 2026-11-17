/** @module domain/site-packs/keeper-schedule.test — when `keep-alive` visits (spec 13 §9.4): the interval ± 20 %, waiting until due, and skipping after an agent load within the interval. */

import { describe, expect, test } from 'bun:test';
import { jitteredKeeperMs, keeperIntervalMs, keeperStep } from './keeper-schedule.ts';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

describe('keeper schedule', () => {
  test('the interval is interval_h ± 20 %', () => {
    expect(keeperIntervalMs(24)).toBe(24 * H);
    expect(jitteredKeeperMs(10, 0)).toBe(8 * H);
    expect(jitteredKeeperMs(10, 0.5)).toBe(10 * H);
    expect(jitteredKeeperMs(10, 0.999_999)).toBeLessThanOrEqual(12 * H);
    expect(jitteredKeeperMs(10, -3)).toBe(8 * H);
  });

  test('waits until due, then visits', () => {
    const base = { dueAt: T0, lastAgentLoadAt: null, intervalH: 6 };
    expect(keeperStep({ ...base, now: T0 - 1 })).toEqual({ kind: 'wait' });
    expect(keeperStep({ ...base, now: T0 })).toEqual({ kind: 'visit' });
  });

  test('an agent load within the interval skips the visit; an older one does not', () => {
    const base = { now: T0, dueAt: T0, intervalH: 6 };
    expect(keeperStep({ ...base, lastAgentLoadAt: T0 - 5 * H })).toEqual({
      kind: 'skip',
      from: T0 - 5 * H,
    });
    expect(keeperStep({ ...base, lastAgentLoadAt: T0 - 6 * H })).toEqual({ kind: 'visit' });
  });
});
