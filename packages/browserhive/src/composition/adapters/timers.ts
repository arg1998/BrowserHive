/** @module composition/adapters/timers — unref'd timer seams (`schedule`, `every`) for the realtime hub and periodic housekeeping; every callback is wrapped so a throw is reported, never unhandled. */

/** One-shot timer; returns its cancel function. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;

/** Repeating timer; returns its cancel function. */
export type EveryFn = (fn: () => void, ms: number) => () => void;

function unref(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return;
  const fn: unknown = timer.unref;
  if (typeof fn === 'function') Reflect.apply(fn, timer, []);
}

/** Builds `schedule`/`every` whose callbacks report throws through `onError`. */
export function createTimers(onError: (error: unknown) => void): {
  schedule: ScheduleFn;
  every: EveryFn;
} {
  const guard = (fn: () => void) => (): void => {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  };
  return {
    schedule(fn, ms) {
      const timer = setTimeout(guard(fn), ms);
      unref(timer);
      return () => clearTimeout(timer);
    },
    every(fn, ms) {
      const timer = setInterval(guard(fn), ms);
      unref(timer);
      return () => clearInterval(timer);
    },
  };
}

/** Runs an async tick from a timer: `void tick().catch(report)` (spec 01 §6). */
export function asyncTick(
  tick: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  return () => {
    void tick().catch(onError);
  };
}
