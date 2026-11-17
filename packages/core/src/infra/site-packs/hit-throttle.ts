/** @module infra/site-packs/hit-throttle — coalesces identical guard hits (review PR #83 L3): a page looping a blocked request writes one `site_guard_hits` row per (session, rule, method, type, URL, action) per second, and the number left out is logged when the window closes. */

/** The coalescing window. */
export const HIT_WINDOW_MS = 1_000;
/** Keys remembered at most; the map is emptied when full (a new window then writes again). */
const MAX_KEYS = 1_024;

interface Window {
  readonly startedAt: number;
  dropped: number;
}

/** Decides per hit whether it is written; reports what a closed window left out. */
export class HitThrottle {
  readonly #windows = new Map<string, Window>();

  /**
   * `true` when the hit opens a new window (write it); `false` when an identical hit was written
   * less than {@link HIT_WINDOW_MS} ago (counted, not written). `closed` receives the number a
   * previous window of the key left out, when it is more than zero.
   */
  admit(key: string, ts: number, closed: (dropped: number) => void): boolean {
    const open = this.#windows.get(key);
    if (open !== undefined && ts - open.startedAt < HIT_WINDOW_MS) {
      open.dropped += 1;
      return false;
    }
    if (open !== undefined && open.dropped > 0) closed(open.dropped);
    if (this.#windows.size >= MAX_KEYS) this.#windows.clear();
    this.#windows.set(key, { startedAt: ts, dropped: 0 });
    return true;
  }
}
