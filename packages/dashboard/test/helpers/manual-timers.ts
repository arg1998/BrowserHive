/** @module dashboard/test/helpers/manual-timers — a `Timers` + `Clock` pair driven by hand (`advance(ms)`), for code that takes injected timers (lib/clock) */
import type { Clock, Timers } from '@/lib/clock.ts';

interface Pending {
  readonly at: number;
  readonly fn: () => void;
  readonly every: number | null;
}

/** Manual timers: nothing fires until `advance` moves the clock past it. */
export interface ManualTimers extends Timers {
  readonly clock: Clock;
  /** Moves time forward, firing due timers in order (and letting promise callbacks run between them). */
  advance(ms: number): Promise<void>;
  /** Lets pending promise callbacks run without moving time. */
  flush(): Promise<void>;
  /** Delays of the pending one-shot timers, from now. */
  pendingDelays(): number[];
}

/** Creates manual timers starting at `start` (epoch ms). */
export function manualTimers(start = Date.UTC(2026, 10, 5, 12, 0, 0)): ManualTimers {
  let now = start;
  let next = 1;
  const pending = new Map<number, Pending>();
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const add = (fn: () => void, ms: number, every: number | null): ReturnType<typeof setTimeout> => {
    const id = next++;
    pending.set(id, { at: now + Math.max(0, ms), fn, every });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const remove = (id: ReturnType<typeof setTimeout>): void => {
    pending.delete(id as unknown as number);
  };
  return {
    clock: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: remove,
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: remove,
    flush,
    pendingDelays: () =>
      [...pending.values()].filter((p) => p.every === null).map((p) => p.at - now),
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      await flush();
      for (;;) {
        let dueId: number | null = null;
        let due: Pending | null = null;
        for (const [id, timer] of pending) {
          if (timer.at <= end && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (due === null || dueId === null) break;
        now = due.at;
        if (due.every === null) pending.delete(dueId);
        else pending.set(dueId, { ...due, at: due.at + due.every });
        due.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
