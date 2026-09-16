/** @module ports/clock — time source injected everywhere a timestamp or delay is produced. */

/**
 * Wall-clock and timer capability. Exactly one production implementation (infra) calls `Date.now()`.
 */
export interface Clock {
  /** Current epoch time in milliseconds. */
  now(): number;
  /** Resolves after `ms` milliseconds, or rejects with the signal's reason when aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
