/** @module app/site-packs/strategies/dwell — `human-dwell` (spec 13 §9.4): before an action on a site's pages, a session waits until a random dwell in `[min_ms, max_ms]` has passed since its previous action on that site; its first action there does not wait, except right after a restart: a session's first action then counts from the template's last action on the site before the restart (D53), so a restart does not reset the spacing. */

import type { StrategyParams } from '../../../domain/site-packs/strategy-params.ts';
import type { StrategyStateStore } from '../strategy-state.ts';

/** The template-level memory of the last actions across a restart. */
export interface DwellMemory {
  /** The template's last action on the pack's site as the boot restored it. */
  restoredAt(sessionId: string, packId: string): number | undefined;
  /** The session's template acted on the site at `at`. */
  record(sessionId: string, packId: string, at: number): void;
}

/** A {@link DwellMemory} over the persisted strategy state; `templateOf` maps a session to its template. */
export function persistedDwell(
  state: StrategyStateStore,
  templateOf: (sessionId: string) => string | null,
): DwellMemory {
  return {
    restoredAt: (sessionId, packId) => {
      const templateId = templateOf(sessionId);
      if (templateId === null) return undefined;
      return state.restored('human-dwell', { templateId, packId })?.lastAt;
    },
    record: (sessionId, packId, at) => {
      const templateId = templateOf(sessionId);
      // Written at most every few seconds: a dwell is seconds long (no write per keystroke).
      if (templateId !== null)
        state.set('human-dwell', { templateId, packId }, { lastAt: at }, 'soon');
    },
  };
}

/** The last action of each (session, pack). */
export class SiteDwell {
  readonly #last = new Map<string, number>();
  readonly #random: () => number;
  readonly #memory: DwellMemory | null;

  /** `random` draws from [0, 1) (injected so tests are deterministic); `memory` spans restarts. */
  constructor(random: () => number, memory: DwellMemory | null = null) {
    this.#random = random;
    this.#memory = memory;
  }

  /** How long the action must wait at `now`; 0 for the session's first action on the site. */
  waitMs(
    sessionId: string,
    packId: string,
    params: StrategyParams['human-dwell'],
    now: number,
  ): number {
    const last =
      this.#last.get(key(sessionId, packId)) ?? this.#memory?.restoredAt(sessionId, packId);
    if (last === undefined) return 0;
    const min = Math.max(0, params.minMs);
    const max = Math.max(min, params.maxMs);
    const dwell = min + Math.floor(this.#random() * (max - min + 1));
    return Math.max(0, last + Math.min(dwell, max) - now);
  }

  /** The session finished an action on the site at `at`. */
  record(sessionId: string, packId: string, at: number): void {
    this.#last.set(key(sessionId, packId), at);
    this.#memory?.record(sessionId, packId, at);
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
