/** @module infra/browsers/humanize/clock — the one injectable sleep the humanize layer uses. */

/**
 * Kept injectable everywhere it is consumed so unit tests can assert a *schedule* — the list of
 * delays a plan produces — without spending that time in real life. The `timer.unref?.()` is the
 * house idiom: a pending humanize delay must never be the reason the process refuses to exit.
 *
 * Production callers pass `clock.sleep` from the injected `Clock` port; this default exists so the
 * pure helpers stay usable without threading a clock through every geometry call.
 */

/** Resolve after `ms`. A non-positive delay yields to the microtask queue and returns. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The sleep signature every humanize entry point accepts, so tests can pass a no-op. */
export type Sleep = (ms: number) => Promise<void>;
