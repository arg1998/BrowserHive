/** @module app/maintenance/timer — interval seam shared by the maintenance schedulers (tests drive ticks without real time). */

/** Starts a repeating timer and returns its cancel function. */
export interface IntervalScheduler {
  setInterval(fn: () => void, ms: number): () => void;
}

/** Real `setInterval`, unref'd so maintenance never keeps the process alive on its own. */
export const realIntervalScheduler: IntervalScheduler = {
  setInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    const maybe: { unref?: () => void } = timer;
    maybe.unref?.();
    return () => clearInterval(timer);
  },
};
