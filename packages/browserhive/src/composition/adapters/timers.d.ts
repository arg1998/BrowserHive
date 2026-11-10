/** @module composition/adapters/timers — unref'd timer seams (`schedule`, `every`) for the realtime hub and periodic housekeeping; every callback is wrapped so a throw is reported, never unhandled. */
/** One-shot timer; returns its cancel function. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void;
/** Repeating timer; returns its cancel function. */
export type EveryFn = (fn: () => void, ms: number) => () => void;
/** Builds `schedule`/`every` whose callbacks report throws through `onError`. */
export declare function createTimers(onError: (error: unknown) => void): {
  schedule: ScheduleFn;
  every: EveryFn;
};
/** Runs an async tick from a timer: `void tick().catch(report)` (spec 01 §6). */
export declare function asyncTick(
  tick: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void;
//# sourceMappingURL=timers.d.ts.map
