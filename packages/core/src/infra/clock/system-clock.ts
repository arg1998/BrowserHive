/** @module infra/clock/system-clock — the one production `Clock`: wall time and abortable sleep (spec 05 §4.2). */

import type { Clock } from '../../ports/clock.ts';

/**
 * Builds the production {@link Clock}. This module is the only `Date.now()` call site outside
 * tests; everything else receives a `Clock` by injection.
 */
export function createSystemClock(): Clock {
  return {
    now(): number {
      return Date.now();
    },
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return sleepWith(ms, signal);
    },
  };
}

/**
 * Resolves after `ms` milliseconds, or rejects with `signal.reason` when the signal aborts first.
 * The timer is cleared on abort so nothing leaks, and the promise settles at most once.
 */
function sleepWith(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A deterministic clock for tests: `now()` returns the set value, `sleep` resolves immediately
 * after advancing time (or rejects when the signal is already aborted).
 */
export interface FakeClock extends Clock {
  /** Moves the clock forward by `ms`. */
  advance(ms: number): void;
  /** Sets the clock to `epochMs`. */
  set(epochMs: number): void;
}

/** Builds a {@link FakeClock} starting at `start` (default `0`). */
export function createFakeClock(start = 0): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(epochMs) {
      current = epochMs;
    },
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      current += Number.isFinite(ms) && ms > 0 ? ms : 0;
      return Promise.resolve();
    },
  };
}
