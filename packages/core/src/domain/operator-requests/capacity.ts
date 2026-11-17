/** @module domain/operator-requests/capacity — the broker's open-queue bounds, counted with the opens still being written (review PR #83 M3): a slot is taken synchronously before the row's insert is awaited, so concurrent opens cannot pass the bound together. */

import { queueFullError } from './support.ts';
import type { OperatorRequestLimits } from './types.ts';

/** Opens in flight (checked, not yet in the broker's pending map), per session and in total. */
export class OpenSlots {
  readonly #limits: OperatorRequestLimits;
  readonly #inFlight = new Map<string, number>();
  #total = 0;

  constructor(limits: OperatorRequestLimits) {
    this.#limits = limits;
  }

  /**
   * Checks the bounds against `open` (the pending requests) plus the opens in flight, then takes a
   * slot; the returned function gives it back (once the request is pending, or its open failed).
   * @throws `RATE_LIMITED` when the per-session or global queue is full.
   */
  take(sessionId: string, open: { readonly session: number; readonly total: number }): () => void {
    const perSession = open.session + (this.#inFlight.get(sessionId) ?? 0);
    const total = open.total + this.#total;
    if (perSession >= this.#limits.perSession || total >= this.#limits.global) {
      throw queueFullError(perSession, total, this.#limits);
    }
    this.#inFlight.set(sessionId, (this.#inFlight.get(sessionId) ?? 0) + 1);
    this.#total += 1;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.#total -= 1;
      const left = (this.#inFlight.get(sessionId) ?? 1) - 1;
      if (left <= 0) this.#inFlight.delete(sessionId);
      else this.#inFlight.set(sessionId, left);
    };
  }
}
