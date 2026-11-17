/** @module app/site-packs/strategies/site-slots — the `serialize-site` slots (spec 13 §9.4): at most `max_parallel` sessions of a template act on a site's pages at once; the others wait in FIFO order up to 30 s. In memory, per process (lead decision 1). */

import type { Clock } from '../../../ports/clock.ts';

/** How long an action waits for its turn before it is refused (`TEMPLATE_BUSY` `pace`). */
export const SERIALIZE_WAIT_MS = 30_000;

interface Waiter {
  readonly sessionId: string;
  granted: boolean;
  readonly grant: () => void;
}

interface Slot {
  max: number;
  /** Session → actions it runs now (a session's own concurrent calls share its slot). */
  readonly holders: Map<string, number>;
  readonly queue: Waiter[];
}

/** A held turn; `release` is idempotent. */
export interface SlotTurn {
  /** How long the action waited for its turn. */
  readonly waitedMs: number;
  release(): void;
}

/** The slots of every (template, site) pair. */
export class SiteSlots {
  readonly #clock: Clock;
  readonly #waitMs: number;
  readonly #slots = new Map<string, Slot>();

  /** `waitMs` is a test seam; production uses {@link SERIALIZE_WAIT_MS}. */
  constructor(clock: Clock, waitMs: number = SERIALIZE_WAIT_MS) {
    this.#clock = clock;
    this.#waitMs = waitMs;
  }

  /**
   * Takes a turn on `key` for `sessionId`, waiting in FIFO order while `max` other sessions hold
   * one. Resolves with the turn, or `'timeout'` after the wait budget.
   *
   * @throws the signal's reason when the call is aborted while waiting
   */
  async acquire(
    key: string,
    sessionId: string,
    max: number,
    signal: AbortSignal,
  ): Promise<SlotTurn | 'timeout'> {
    if (signal.aborted) throw signal.reason;
    const slot = this.#slot(key, max);
    const startedAt = this.#clock.now();
    const own = slot.holders.get(sessionId);
    if (own !== undefined || (slot.holders.size < slot.max && slot.queue.length === 0)) {
      slot.holders.set(sessionId, (own ?? 0) + 1);
      return this.#turn(key, sessionId, 0);
    }
    let grant: () => void = () => undefined;
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const waiter: Waiter = {
      sessionId,
      granted: false,
      grant: () => {
        waiter.granted = true;
        grant();
      },
    };
    slot.queue.push(waiter);
    const timer = new AbortController();
    const onAbort = () => timer.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const outcome = await Promise.race([
        granted.then(() => 'granted' as const),
        this.#clock.sleep(this.#waitMs, timer.signal).then(
          () => 'timeout' as const,
          () => 'aborted' as const,
        ),
      ]);
      if (waiter.granted) {
        if (outcome === 'aborted' && signal.aborted) {
          this.#release(key, sessionId);
          throw signal.reason;
        }
        return this.#turn(key, sessionId, this.#clock.now() - startedAt);
      }
      this.#dequeue(key, waiter);
      if (outcome === 'aborted') throw signal.reason;
      return 'timeout';
    } finally {
      signal.removeEventListener('abort', onAbort);
      timer.abort();
    }
  }

  /** Sessions holding a turn on `key` now (tests, logs). */
  holders(key: string): number {
    return this.#slots.get(key)?.holders.size ?? 0;
  }

  /** Actions waiting on `key` now (tests, logs). */
  waiting(key: string): number {
    return this.#slots.get(key)?.queue.length ?? 0;
  }

  #slot(key: string, max: number): Slot {
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = { max, holders: new Map(), queue: [] };
      this.#slots.set(key, slot);
    }
    // The pack's current value applies from now on (a lower value lets fewer in at the next turn).
    slot.max = max;
    return slot;
  }

  #turn(key: string, sessionId: string, waitedMs: number): SlotTurn {
    let released = false;
    return {
      waitedMs,
      release: () => {
        if (released) return;
        released = true;
        this.#release(key, sessionId);
      },
    };
  }

  #release(key: string, sessionId: string): void {
    const slot = this.#slots.get(key);
    if (slot === undefined) return;
    const count = slot.holders.get(sessionId) ?? 0;
    if (count <= 1) slot.holders.delete(sessionId);
    else slot.holders.set(sessionId, count - 1);
    this.#pump(key, slot);
  }

  /** Grants waiting turns in FIFO order while there is room. */
  #pump(key: string, slot: Slot): void {
    while (slot.queue.length > 0) {
      const next = slot.queue[0];
      if (next === undefined) break;
      const own = slot.holders.get(next.sessionId);
      if (own === undefined && slot.holders.size >= slot.max) break;
      slot.queue.shift();
      slot.holders.set(next.sessionId, (own ?? 0) + 1);
      next.grant();
    }
    if (slot.holders.size === 0 && slot.queue.length === 0) this.#slots.delete(key);
  }

  #dequeue(key: string, waiter: Waiter): void {
    const slot = this.#slots.get(key);
    if (slot === undefined) return;
    const index = slot.queue.indexOf(waiter);
    if (index >= 0) slot.queue.splice(index, 1);
    // A waiter leaving the head may let the next one in.
    this.#pump(key, slot);
  }
}
