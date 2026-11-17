/** @module domain/site-packs/pace.test — the `pace-writes` buckets on a fake timeline (spec 13 §9.4): a fresh bucket is full, continuous refill up to the capacity, a write over budget held for its token when it is at most 60 s away (reserving it, so the next write waits behind it), refused beyond, jitter within 0–20 %, and a refund for a held write that never went out. */

import { describe, expect, test } from 'bun:test';
import {
  holdMs,
  MAX_PACE_HOLD_MS,
  PACE_PERIOD_MS,
  type PaceBucket,
  type PaceBudget,
  planWrite,
  refilled,
  refund,
  waitForToken,
} from './pace.ts';

const T0 = 1_700_000_000_000;
const perMinute = (capacity: number): PaceBudget => ({ capacity, periodMs: PACE_PERIOD_MS.minute });

/** Runs writes at the given times over one bucket; returns each plan. */
function run(budget: PaceBudget, times: readonly number[]) {
  let bucket: PaceBucket | undefined;
  return times.map((at) => {
    const { plan, buckets } = planWrite([{ bucket, budget }], at);
    bucket = buckets[0];
    return plan;
  });
}

describe('pace buckets', () => {
  test('a fresh bucket is full; refill is continuous and capped', () => {
    const budget = perMinute(6);
    expect(refilled(undefined, budget, T0)).toEqual({ tokens: 6, at: T0 });
    expect(refilled({ tokens: 0, at: T0 }, budget, T0 + 10_000).tokens).toBeCloseTo(1);
    expect(refilled({ tokens: 5, at: T0 }, budget, T0 + 3_600_000).tokens).toBe(6);
    expect(refilled({ tokens: 9, at: T0 }, budget, T0).tokens).toBe(6);
  });

  test('the wait for a whole token', () => {
    const budget = perMinute(6);
    expect(waitForToken({ tokens: 1, at: T0 }, budget)).toBe(0);
    expect(waitForToken({ tokens: 0, at: T0 }, budget)).toBe(10_000);
    expect(waitForToken({ tokens: -1, at: T0 }, budget)).toBe(20_000);
  });

  test('within budget the writes go; over it they are held, then refused past 60 s', () => {
    // 2 per minute: a token every 30 s.
    const plans = run(perMinute(2), [T0, T0, T0, T0, T0]);
    expect(plans).toEqual([
      { kind: 'go' },
      { kind: 'go' },
      { kind: 'hold', waitMs: 30_000 },
      // The held write reserved the next token: this one waits behind it.
      { kind: 'hold', waitMs: 60_000 },
      { kind: 'refuse', waitMs: 90_000 },
    ]);
  });

  test('a refused write takes no token; refill lets the next one go', () => {
    const budget: PaceBudget = { capacity: 1, periodMs: PACE_PERIOD_MS.hour };
    const plans = run(budget, [T0, T0 + 1_000, T0 + 3_600_000]);
    expect(plans[0]).toEqual({ kind: 'go' });
    expect(plans[1]?.kind).toBe('refuse');
    expect(plans[2]).toEqual({ kind: 'go' });
  });

  test('several rules on one guard: the longest wait decides and every bucket is charged', () => {
    const minute = perMinute(10);
    const hour: PaceBudget = { capacity: 2, periodMs: PACE_PERIOD_MS.hour };
    let buckets: readonly (PaceBucket | undefined)[] = [undefined, undefined];
    const plans = [T0, T0, T0].map((at) => {
      const result = planWrite(
        [
          { bucket: buckets[0], budget: minute },
          { bucket: buckets[1], budget: hour },
        ],
        at,
      );
      buckets = result.buckets;
      return result.plan.kind;
    });
    expect(plans).toEqual(['go', 'go', 'refuse']);
    expect(buckets[0]?.tokens).toBe(8);
  });

  test('a refund gives a held write its token back, never above the capacity', () => {
    const budget = perMinute(2);
    expect(refund({ tokens: -1, at: T0 }, budget, T0).tokens).toBe(0);
    expect(refund({ tokens: 2, at: T0 }, budget, T0).tokens).toBe(2);
  });

  test('the hold adds 0–20 % jitter', () => {
    expect(holdMs(10_000, 0)).toBe(10_000);
    expect(holdMs(10_000, 0.5)).toBe(11_000);
    expect(holdMs(10_000, 0.999_999)).toBeLessThanOrEqual(12_000);
    expect(holdMs(10_000, 7)).toBe(12_000);
    expect(MAX_PACE_HOLD_MS).toBe(60_000);
  });
});
