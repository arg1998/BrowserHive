/** @module test/helpers/fake-clock — deterministic Clock for unit tests (spec 09 §4). */

import type { Clock } from '../../src/ports/clock.ts';

interface PendingSleep {
  readonly wakeAt: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/** A Clock whose time only moves through `advance()`/`set()`; pending sleeps resolve in order. */
export class FakeClock implements Clock {
  private current: number;
  private readonly pending: PendingSleep[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry: PendingSleep = { wakeAt: this.current + Math.max(0, ms), resolve, reject };
      this.pending.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.pending.indexOf(entry);
          if (i >= 0) this.pending.splice(i, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** Moves time forward by `ms` and wakes every sleep whose deadline passed, in deadline order. */
  async advance(ms: number): Promise<void> {
    await this.set(this.current + ms);
  }

  /** Jumps to `at` (must not go backwards) and wakes due sleeps. */
  async set(at: number): Promise<void> {
    if (at < this.current) throw new Error('FakeClock cannot move backwards');
    this.current = at;
    const due = this.pending.filter((p) => p.wakeAt <= at).sort((a, b) => a.wakeAt - b.wakeAt);
    for (const p of due) {
      const i = this.pending.indexOf(p);
      if (i >= 0) this.pending.splice(i, 1);
      p.resolve();
    }
    // Let continuations run before returning so callers observe the effects.
    await Promise.resolve();
  }

  /** Number of sleeps waiting for time to move. */
  get pendingSleeps(): number {
    return this.pending.length;
  }
}
