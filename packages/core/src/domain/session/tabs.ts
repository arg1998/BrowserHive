/** @module domain/session/tabs — per-session TabRegistry: opaque stable `t-<id>` ids ↔ Playwright pages, active tab, popup adoption. */

import type { Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';

/** Sentinel tab id reported when the active-tab fallback finds no open tab. */
export const ACTIVE_TAB_SENTINEL = '<active>';

/** Builds the typed `TAB_NOT_FOUND` error with its public message text. */
export function tabNotFound(sessionId: string, tabId: string): AppError<'TAB_NOT_FOUND'> {
  return new AppError(
    'TAB_NOT_FOUND',
    { session_id: sessionId, tab_id: tabId },
    { publicMessage: `Tab '${tabId}' not found in session '${sessionId}'.` },
  );
}

/**
 * The agent never sees a raw Playwright `Page`; it sees an opaque, stable `tab_id`. This registry is
 * the sole translation layer between the two. One registry lives on each session.
 *
 * Invariants:
 *   - A tab id is `t-<nanoid6>` (minted by the injected generator) and is stable for the life of the
 *     tab. It is never reused, even after the tab closes.
 *   - Exactly one tab is "active" whenever at least one tab is open. Page-targeting tools that omit
 *     `tab_id` operate on the active tab.
 *   - When the browser itself opens a page (a `target=_blank` link, `window.open`), the owner feeds
 *     it through {@link TabRegistry.add} from the context `page` event, so `list_tabs` stays accurate.
 */
export class TabRegistry {
  /** tab_id → Page. Insertion order is the tab order shown by `list_tabs`. */
  private readonly byId = new Map<string, Page>();
  /** Page → tab_id, so pages that close (or arrive via events) resolve back to their id. */
  private readonly idByPage = new Map<Page, string>();
  private activeId: string | undefined;
  private readonly activeListeners = new Set<(tabId: string | undefined) => void>();

  constructor(
    private readonly sessionId: string,
    private readonly mintId: () => string,
  ) {}

  /**
   * Register a page and return its (new or existing) tab id. Idempotent: a page already tracked
   * returns its existing id rather than allocating a second. The first registered page becomes
   * active. Subscribes to the page's `close` event so a tab the site closes disappears on its own.
   */
  add(page: Page): string {
    const existing = this.idByPage.get(page);
    if (existing !== undefined) return existing;
    const id = this.mintId();
    this.byId.set(id, page);
    this.idByPage.set(page, id);
    if (this.activeId === undefined) this.setActiveId(id);
    // Guarded so unit fakes without an event emitter still work.
    const emitter: { on?: unknown } = page;
    if (typeof emitter.on === 'function') {
      page.on('close', () => this.remove(id));
    }
    return id;
  }

  /** The id of the active tab, or `undefined` when no tabs are open. */
  activeTabId(): string | undefined {
    return this.activeId;
  }

  /** The active tab's page, or `undefined` when no tabs are open. */
  activePage(): Page | undefined {
    return this.activeId === undefined ? undefined : this.byId.get(this.activeId);
  }

  /**
   * Resolve a page by tab id, or the active page when `tabId` is omitted.
   *
   * @throws `TAB_NOT_FOUND` for an unknown id, or with tab id `<active>` when no tab is open.
   */
  resolve(tabId?: string): Page {
    if (tabId === undefined) {
      const active = this.activePage();
      if (active === undefined) throw tabNotFound(this.sessionId, ACTIVE_TAB_SENTINEL);
      return active;
    }
    const page = this.byId.get(tabId);
    if (page === undefined) throw tabNotFound(this.sessionId, tabId);
    return page;
  }

  /** Resolves a tab id to its page, or `undefined`. */
  get(tabId: string): Page | undefined {
    return this.byId.get(tabId);
  }

  /** The tab id for a page, or `undefined` if it is not tracked. */
  idFor(page: Page): string | undefined {
    return this.idByPage.get(page);
  }

  /** True when `tabId` is open. */
  has(tabId: string): boolean {
    return this.byId.has(tabId);
  }

  /**
   * Make `tabId` the active tab.
   *
   * @throws `TAB_NOT_FOUND` for an unknown id.
   */
  setActive(tabId: string): Page {
    const page = this.byId.get(tabId);
    if (page === undefined) throw tabNotFound(this.sessionId, tabId);
    this.setActiveId(tabId);
    return page;
  }

  /**
   * Forget a tab. If it was the active tab, the most-recently-added surviving tab becomes active
   * (or `undefined` when the last tab closes). Idempotent. Returns whether a tab was removed.
   */
  remove(tabId: string): boolean {
    const page = this.byId.get(tabId);
    if (page === undefined) return false;
    this.byId.delete(tabId);
    this.idByPage.delete(page);
    if (this.activeId === tabId) {
      const remaining = [...this.byId.keys()];
      this.setActiveId(remaining.at(-1));
    }
    return true;
  }

  /**
   * Calls `listener` with the new active tab id whenever the active tab changes (switch, a new tab
   * made active, the active tab closing). Returns the unsubscribe. A throwing listener is ignored.
   */
  onActiveChange(listener: (tabId: string | undefined) => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  private setActiveId(tabId: string | undefined): void {
    if (this.activeId === tabId) return;
    this.activeId = tabId;
    for (const listener of [...this.activeListeners]) {
      try {
        listener(tabId);
      } catch {
        // Observers (live view) must never break tab bookkeeping.
      }
    }
  }

  /** Ordered snapshot of `[tab_id, page]` pairs for `list_tabs`. */
  entries(): ReadonlyArray<readonly [string, Page]> {
    return [...this.byId.entries()];
  }

  /** Ordered tab ids. */
  ids(): readonly string[] {
    return [...this.byId.keys()];
  }

  /** Number of open tabs (page count for `session_info`). */
  size(): number {
    return this.byId.size;
  }
}
