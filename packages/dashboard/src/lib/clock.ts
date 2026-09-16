/** @module lib/clock — the one place the dashboard reads the browser clock; stores take a `Clock` so tests can drive time */

/** Injectable clock: epoch milliseconds. */
export type Clock = () => number;

/** The browser clock. Prefer `useServerNow()` for anything displayed to the operator. */
export const browserClock: Clock = () => Date.now();

/** Injectable timer surface (matches the DOM signatures) so stores can be driven by fake timers. */
export interface Timers {
  readonly setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  readonly setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

/** The real timers. */
export const browserTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};
