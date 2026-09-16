/** @module domain/session/lease.test — sliding reset, pause banking, resume restore, expiry rules over explicit clocks. */

import { describe, expect, it } from 'bun:test';
import {
  isLeaseExpired,
  leaseRemainingMs,
  newLease,
  pauseLease,
  resumeLease,
  touchLease,
} from './lease.ts';

const WINDOW = 7_200_000;

describe('lease', () => {
  it('seeds at now + window, running', () => {
    expect(newLease(1_000, WINDOW)).toEqual({ expiresAt: 1_000 + WINDOW, pausedAt: null });
  });

  it('touch slides the deadline to now + window', () => {
    const lease = newLease(1_000, WINDOW);
    expect(touchLease(lease, 5_000, WINDOW)).toEqual({ expiresAt: 5_000 + WINDOW, pausedAt: null });
  });

  it('is expired only once the deadline passes while running', () => {
    const lease = newLease(1_000, WINDOW);
    expect(isLeaseExpired(lease, 1_000 + WINDOW - 1)).toBe(false);
    expect(isLeaseExpired(lease, 1_000 + WINDOW)).toBe(true);
    expect(isLeaseExpired(lease, 1_000 + WINDOW + 5)).toBe(true);
  });

  it('pause banks the remaining time; expiry is impossible while paused', () => {
    const lease = newLease(1_000, WINDOW);
    const paused = pauseLease(lease, 1_000 + 100_000);
    expect(paused).toEqual({ expiresAt: 1_000 + WINDOW, pausedAt: 101_000 });
    expect(isLeaseExpired(paused, 1_000 + WINDOW)).toBe(false);
    expect(isLeaseExpired(paused, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(leaseRemainingMs(paused, Number.MAX_SAFE_INTEGER)).toBe(WINDOW - 100_000);
  });

  it('pause is idempotent (keeps the first pause instant)', () => {
    const paused = pauseLease(newLease(1_000, WINDOW), 2_000);
    expect(pauseLease(paused, 9_000)).toBe(paused);
  });

  it('touch while paused does not move the deadline', () => {
    const paused = pauseLease(newLease(1_000, WINDOW), 2_000);
    expect(touchLease(paused, 50_000, WINDOW)).toBe(paused);
  });

  it('resume restores exactly the banked remaining time from now', () => {
    const lease = newLease(1_000, WINDOW);
    const paused = pauseLease(lease, 1_000 + 100_000);
    const resumed = resumeLease(paused, 50_000_000);
    expect(resumed).toEqual({ expiresAt: 50_000_000 + (WINDOW - 100_000), pausedAt: null });
    expect(isLeaseExpired(resumed, 50_000_000 + WINDOW - 100_000 - 1)).toBe(false);
    expect(isLeaseExpired(resumed, 50_000_000 + WINDOW - 100_000)).toBe(true);
  });

  it('resume never restores negative time (paused after expiry instant)', () => {
    const lease = newLease(1_000, WINDOW);
    const paused = pauseLease(lease, 1_000 + WINDOW + 500);
    const resumed = resumeLease(paused, 10_000_000);
    expect(resumed.expiresAt).toBe(10_000_000);
  });

  it('resume is idempotent when running', () => {
    const lease = newLease(1_000, WINDOW);
    expect(resumeLease(lease, 5_000)).toBe(lease);
  });

  it('remaining ms while running is the distance to the deadline, never negative', () => {
    const lease = newLease(1_000, WINDOW);
    expect(leaseRemainingMs(lease, 1_000)).toBe(WINDOW);
    expect(leaseRemainingMs(lease, 1_000 + WINDOW / 2)).toBe(WINDOW / 2);
    expect(leaseRemainingMs(lease, 1_000 + WINDOW + 10)).toBe(0);
  });
});
