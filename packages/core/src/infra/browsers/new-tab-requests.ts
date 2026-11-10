/** @module infra/browsers/new-tab-requests — the opener of a tab Chromium opens without one (spec 13 §3.4): a Ctrl/Cmd/Shift- or middle-click, or a modified form submit, in a session's page creates a target with no `openerId`; the page's own `Page.frameRequestedNavigation` (disposition `newTab`/`newWindow`) names the URL first, and the new target is matched to it by URL. */

/** How long a requested new tab waits for its target. */
export const NEW_TAB_REQUEST_TTL_MS = 5_000;

interface Requested {
  readonly url: string;
  /** The target id of the page that asked. */
  readonly openerId: string;
  readonly at: number;
}

/**
 * Pending new-tab requests of a host's pages and the URLs of its targets. A target with no opener
 * is given the opener of the one pending request for its URL; when requests for that URL came from
 * different pages, none is chosen (the target stays unattributed, so it is parked: fail-closed).
 */
export class NewTabRequests {
  private readonly pending: Requested[] = [];
  private readonly urls = new Map<string, string>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** A page (`openerId`) asked Chromium to open `url` in a new tab or window. */
  requested(openerId: string, url: string): void {
    this.prune();
    this.pending.push({ url, openerId, at: this.now() });
  }

  /** The URL of `targetId` changed (discovery); wakes a wait for it. */
  urlOf(targetId: string, url: string): void {
    if (url === '' || url === 'about:blank') return;
    this.urls.set(targetId, url);
    for (const wake of this.waiters.get(targetId) ?? []) wake();
    this.waiters.delete(targetId);
  }

  /** The target is gone: forget its URL. */
  forget(targetId: string): void {
    this.urls.delete(targetId);
    this.waiters.delete(targetId);
  }

  /**
   * The opener of `targetId` (which has none of its own), waiting at most `waitMs` for its URL;
   * `null` when no request or more than one page's request matches.
   */
  async openerOf(targetId: string, waitMs: number): Promise<string | null> {
    if (this.pending.length === 0) return null;
    if (!this.urls.has(targetId)) await this.waitForUrl(targetId, waitMs);
    const url = this.urls.get(targetId);
    if (url === undefined) return null;
    this.prune();
    const matches = this.pending.filter((p) => p.url === url);
    const openers = new Set(matches.map((m) => m.openerId));
    const first = matches[0];
    if (first === undefined || openers.size !== 1) return null;
    this.pending.splice(this.pending.indexOf(first), 1);
    return first.openerId;
  }

  private waitForUrl(targetId: string, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      const list = this.waiters.get(targetId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(targetId, list);
    });
  }

  private prune(): void {
    const oldest = this.now() - NEW_TAB_REQUEST_TTL_MS;
    while (this.pending.length > 0 && (this.pending[0]?.at ?? 0) < oldest) this.pending.shift();
  }
}
