/** @module app/site-packs/agent-navigations — the URLs agents passed to `navigate`/`new_tab` (spec 13 §9.5): a main-frame commit of exactly that URL is the agent's own navigation, which can set no state (no request, no health change, no stop); a redirect into a challenge URL is not. */

import type { Clock } from '../../ports/clock.ts';

/** How long an expected URL waits for its commit. */
export const AGENT_NAVIGATION_TTL_MS = 120_000;

interface Expected {
  readonly href: string;
  readonly at: number;
}

/** Normalized for comparison: the parsed `href` without its fragment. */
function normalized(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/** Per page (`navigate`) and per session (`new_tab`, the page does not exist yet). */
export class AgentNavigations {
  readonly #clock: Clock;
  readonly #byPage = new WeakMap<object, Expected>();
  readonly #bySession = new Map<string, Expected[]>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** `navigate` is about to load `url` in `page`. */
  expectOnPage(page: object, url: string): void {
    const href = normalized(url);
    if (href !== null) this.#byPage.set(page, { href, at: this.#clock.now() });
  }

  /** `new_tab(url)` is about to open a page of `sessionId` at `url`. */
  expectNewTab(sessionId: string, url: string): void {
    const href = normalized(url);
    if (href === null) return;
    const now = this.#clock.now();
    const list = (this.#bySession.get(sessionId) ?? []).filter(
      (e) => now - e.at < AGENT_NAVIGATION_TTL_MS,
    );
    list.push({ href, at: now });
    this.#bySession.set(sessionId, list.slice(-8));
  }

  /**
   * The main frame of `page` committed `url`: true when it is exactly the URL the agent passed
   * (consumed). The page's expectation is consumed by its first commit whatever the URL, so a
   * later redirect or a script navigation to the same URL is never exempt.
   */
  consume(page: object, sessionId: string | null, url: string): boolean {
    const href = normalized(url);
    const now = this.#clock.now();
    const onPage = this.#byPage.get(page);
    if (onPage !== undefined) {
      this.#byPage.delete(page);
      return href !== null && onPage.href === href && now - onPage.at < AGENT_NAVIGATION_TTL_MS;
    }
    if (sessionId === null || href === null) return false;
    const list = this.#bySession.get(sessionId);
    if (list === undefined) return false;
    const index = list.findIndex((e) => e.href === href && now - e.at < AGENT_NAVIGATION_TTL_MS);
    if (index < 0) return false;
    list.splice(index, 1);
    if (list.length === 0) this.#bySession.delete(sessionId);
    return true;
  }

  /** The session closed. */
  forget(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }
}
