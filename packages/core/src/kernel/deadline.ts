/** @module kernel/deadline — abort signals with deadlines for every I/O call that can hang (spec 05 §6). */

import { AppError } from './errors/app-error.ts';

/** Marker carried as `signal.reason` when a deadline fires, so callers can tell timeout from cancel. */
export class DeadlineExceeded extends Error {
  /** The deadline that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`deadline of ${timeoutMs}ms exceeded`);
    this.name = 'DeadlineExceeded';
    this.timeoutMs = timeoutMs;
  }
}

/** A composed signal plus the handle that releases its timer. Disposable for `using`. */
export interface Deadline {
  /** Aborts when the parent aborts or when the deadline elapses, whichever comes first. */
  readonly signal: AbortSignal;
  /** Clears the timer and detaches from the parent. Idempotent; call when the work finished early. */
  clear(): void;
  /** `using` support; same as {@link Deadline.clear}. */
  [Symbol.dispose](): void;
}

/**
 * Derives a signal that aborts after `ms` milliseconds or when `parent` aborts.
 *
 * @param parent Optional upstream signal (request cancellation, shutdown).
 * @param ms Deadline in milliseconds; non-finite or negative values mean "no deadline".
 * @remarks The timer is `unref`'d so a forgotten deadline never keeps the process alive.
 */
export function withDeadline(parent: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };

  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
    if (Number.isFinite(ms) && ms >= 0) {
      timer = setTimeout(() => controller.abort(new DeadlineExceeded(ms)), ms);
      unrefTimer(timer);
    }
  }

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parent?.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, clear, [Symbol.dispose]: clear };
}

/**
 * Combines several signals into one that aborts as soon as any of them does, carrying the first
 * reason. `undefined` entries are skipped so optional signals can be passed through directly.
 */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  const listeners: Array<() => void> = [];
  const detachAll = (): void => {
    for (const detach of listeners) detach();
  };
  for (const signal of present) {
    const handler = (): void => {
      controller.abort(signal.reason);
      detachAll();
    };
    signal.addEventListener('abort', handler, { once: true });
    listeners.push(() => signal.removeEventListener('abort', handler));
  }
  return controller.signal;
}

/** True when `reason` (typically `signal.reason`) is a deadline expiry rather than a cancellation. */
export function isDeadlineExceeded(reason: unknown): reason is DeadlineExceeded {
  return reason instanceof DeadlineExceeded;
}

/**
 * Maps a deadline expiry to the registry code `WAIT_TIMEOUT`.
 *
 * @param what Human label of the awaited thing (`'navigation'`, `'db drain'`).
 * @param timeoutMs The deadline that elapsed.
 * @param cause The abort reason, attached as `cause`.
 */
export function timeoutError(
  what: string,
  timeoutMs: number,
  cause?: unknown,
): AppError<'WAIT_TIMEOUT'> {
  return new AppError(
    'WAIT_TIMEOUT',
    { what, timeout_ms: timeoutMs },
    { message: `timed out after ${timeoutMs}ms waiting for ${what}`, cause },
  );
}

/**
 * Rejects with {@link timeoutError} when `signal` aborts from a deadline, or with the signal's own
 * reason on a plain cancellation. Resolves with the awaited value otherwise.
 *
 * @throws `WAIT_TIMEOUT` when the deadline elapses first.
 */
export async function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  what: string,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw abortReasonToError(signal.reason, what, timeoutMs);
  let detach = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const handler = (): void => reject(abortReasonToError(signal.reason, what, timeoutMs));
    signal.addEventListener('abort', handler, { once: true });
    detach = () => signal.removeEventListener('abort', handler);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    detach();
  }
}

function abortReasonToError(reason: unknown, what: string, timeoutMs: number): unknown {
  if (isDeadlineExceeded(reason)) return timeoutError(what, reason.timeoutMs, reason);
  if (reason instanceof Error) return reason;
  return timeoutError(what, timeoutMs, reason);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe: { unref?: () => void } = timer;
  maybe.unref?.();
}
