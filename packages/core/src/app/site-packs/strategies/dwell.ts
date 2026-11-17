/** @module app/site-packs/strategies/dwell — `human-dwell` (spec 13 §9.4): before an action on a site's pages, a session waits until a random dwell in `[min_ms, max_ms]` has passed since its previous action on that site; its first action there does not wait. In memory, per process. */

import type { StrategyParams } from '../../../domain/site-packs/strategy-params.ts';

/** The last action of each (session, pack). */
export class SiteDwell {
  readonly #last = new Map<string, number>();
  readonly #random: () => number;

  /** `random` draws from [0, 1) (injected so tests are deterministic). */
  constructor(random: () => number) {
    this.#random = random;
  }

  /** How long the action must wait at `now`; 0 for the session's first action on the site. */
  waitMs(
    sessionId: string,
    packId: string,
    params: StrategyParams['human-dwell'],
    now: number,
  ): number {
    const last = this.#last.get(key(sessionId, packId));
    if (last === undefined) return 0;
    const min = Math.max(0, params.minMs);
    const max = Math.max(min, params.maxMs);
    const dwell = min + Math.floor(this.#random() * (max - min + 1));
    return Math.max(0, last + Math.min(dwell, max) - now);
  }

  /** The session finished an action on the site at `at`. */
  record(sessionId: string, packId: string, at: number): void {
    this.#last.set(key(sessionId, packId), at);
  }

  /** The session closed. */
  forget(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const k of this.#last.keys()) if (k.startsWith(prefix)) this.#last.delete(k);
  }
}

function key(sessionId: string, packId: string): string {
  return `${sessionId}\u0000${packId}`;
}
