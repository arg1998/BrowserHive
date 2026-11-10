/** @module infra/browsers/template-targets — a template host's browser-level DevTools session: target discovery (target id → opener, also for targets that close before Playwright adopts them), background windows through `Target.createTarget`, and window bounds (spec 13 §3.3, §3.4). */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TargetFacts } from './page-attribution.ts';

/** What discovery knows about one page target of the host's context. */
interface DiscoveredTarget {
  readonly openerId: string | null;
  destroyed: boolean;
}

/** Discovered targets kept per host (closed ones are dropped first). */
const DISCOVERED_LIMIT = 10_000;

/** A new window's geometry and state (spec 13 §3.3). */
export interface WindowRequest {
  readonly width: number;
  readonly height: number;
  readonly minimized: boolean;
}

/**
 * The browser-level CDP session of one template host. `Target.setDiscoverTargets` reports every
 * page target of the browser with its `openerId` as soon as Chromium creates it, before Playwright
 * adopts the page; the attribution dispatcher reads facts from here so that a page closing before
 * its own facts are read still leaves its real target id (and therefore a tombstone its children
 * follow) through {@link onLostTarget}.
 */
export class HostTargets {
  readonly browserContextId: string;
  private readonly cdp: CDPSession;
  private readonly context: BrowserContext;
  private readonly log: Logger;
  private readonly discovered = new Map<string, DiscoveredTarget>();
  /** Target ids a page's facts read returned (so a destroyed one is not a lost target). */
  private readonly matched = new Set<string>();
  private lost: ((facts: TargetFacts) => void) | null = null;
  private destroyedListener: ((targetId: string) => void) | null = null;
  private disposed = false;

  private constructor(
    cdp: CDPSession,
    context: BrowserContext,
    browserContextId: string,
    logger: Logger,
  ) {
    this.cdp = cdp;
    this.context = context;
    this.browserContextId = browserContextId;
    this.log = logger;
  }

  /**
   * Opens the browser session of `context` and starts discovery. `anchor` is any open page of the
   * context (the sentinel): its target info names the context's `browserContextId`.
   */
  static async open(context: BrowserContext, anchor: Page, logger: Logger): Promise<HostTargets> {
    const browser = context.browser();
    if (browser === null) {
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'template-host-browser' },
        { message: 'a template host needs a browser-level DevTools session' },
      );
    }
    const pageCdp = await context.newCDPSession(anchor);
    let browserContextId: string | undefined;
    try {
      const { targetInfo } = await pageCdp.send('Target.getTargetInfo');
      browserContextId = targetInfo.browserContextId;
    } finally {
      await pageCdp.detach().catch(() => undefined);
    }
    if (browserContextId === undefined) {
      throw new AppError('INTERNAL_ERROR', { ref: 'template-host-context-id' });
    }
    const cdp = await browser.newBrowserCDPSession();
    const targets = new HostTargets(cdp, context, browserContextId, logger);
    cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type !== 'page' || targetInfo.browserContextId !== browserContextId) return;
      targets.remember(targetInfo.targetId, targetInfo.openerId ?? null);
    });
    cdp.on('Target.targetDestroyed', ({ targetId }) => targets.destroyed(targetId));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    return targets;
  }

  /**
   * Called when Chromium reports a page target destroyed. A killed browser reports nothing (its
   * pipe just closes), so this tells a window closed in the browser from a dead browser.
   */
  onDestroyed(listener: (targetId: string) => void): void {
    this.destroyedListener = listener;
  }

  /** Called with the facts of a page target that closed before any page of it was read. */
  onLostTarget(listener: (facts: TargetFacts) => void): void {
    this.lost = listener;
  }

  /**
   * The facts of an adopted page: its target id from its own DevTools session, its opener from
   * discovery (falling back to the target info). Rejects when the page is already gone.
   */
  async factsOf(page: Page): Promise<TargetFacts> {
    const cdp = await this.context.newCDPSession(page);
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      this.matched.add(targetInfo.targetId);
      const known = this.discovered.get(targetInfo.targetId);
      return {
        targetId: targetInfo.targetId,
        openerId: known?.openerId ?? targetInfo.openerId ?? null,
      };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * Creates a background window at `about:blank` in the host's context (navigated afterwards: under
   * Patchright a headed `createTarget` given a URL misses the context's init scripts). Returns its
   * target id; the page arrives through Playwright's adoption.
   */
  async createWindow(request: WindowRequest): Promise<string> {
    const base = {
      url: 'about:blank',
      newWindow: true,
      background: true,
      browserContextId: this.browserContextId,
      width: request.width,
      height: request.height,
    };
    if (!request.minimized) return (await this.cdp.send('Target.createTarget', base)).targetId;
    try {
      const params = { ...base, windowState: 'minimized' as const };
      return (await this.cdp.send('Target.createTarget', params)).targetId;
    } catch (err) {
      // Older Chromium refuses `windowState` here: create normal, then minimize.
      this.log.debug('minimized window refused', { err: serializeError(err) });
      const targetId = (await this.cdp.send('Target.createTarget', base)).targetId;
      await this.minimize(targetId);
      return targetId;
    }
  }

  /** The window id of a target, or `null` when it cannot be read. */
  async windowOf(targetId: string): Promise<number | null> {
    try {
      return (await this.cdp.send('Browser.getWindowForTarget', { targetId })).windowId;
    } catch (err) {
      this.log.debug('window id unreadable', { err: serializeError(err) });
      return null;
    }
  }

  /** Minimizes the window of `targetId` (best effort: a bare X server may not have a window manager). */
  async minimize(targetId: string): Promise<void> {
    const windowId = await this.windowOf(targetId);
    if (windowId === null) return;
    await this.setBounds(windowId, { windowState: 'minimized' });
  }

  /** Resizes a window without moving it (spec 13 §3.3 `set_viewport` on a headed host). */
  async resize(targetId: string, width: number, height: number): Promise<void> {
    const windowId = await this.windowOf(targetId);
    if (windowId === null) return;
    // Size only: never a position, never a state change (restoring would raise the window).
    await this.setBounds(windowId, { width, height });
  }

  /** Closes a target that was never handed to anyone (an adoption that failed). */
  async closeTarget(targetId: string): Promise<void> {
    try {
      await this.cdp.send('Target.closeTarget', { targetId });
    } catch (err) {
      this.log.debug('target close failed', { err: serializeError(err) });
    }
  }

  /** Stops discovery and detaches; idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lost = null;
    this.destroyedListener = null;
    await this.cdp.detach().catch(() => undefined);
  }

  private async setBounds(
    windowId: number,
    bounds: {
      readonly windowState?: 'normal' | 'minimized';
      readonly width?: number;
      readonly height?: number;
    },
  ): Promise<void> {
    try {
      await this.cdp.send('Browser.setWindowBounds', { windowId, bounds });
    } catch (err) {
      this.log.debug('window bounds refused', { err: serializeError(err) });
    }
  }

  private remember(targetId: string, openerId: string | null): void {
    if (this.discovered.has(targetId)) return;
    this.discovered.set(targetId, { openerId, destroyed: false });
    if (this.discovered.size <= DISCOVERED_LIMIT) return;
    for (const [id, target] of this.discovered) {
      if (this.discovered.size <= DISCOVERED_LIMIT) break;
      if (target.destroyed) {
        this.discovered.delete(id);
        this.matched.delete(id);
      }
    }
  }

  private destroyed(targetId: string): void {
    const target = this.discovered.get(targetId);
    if (target === undefined || target.destroyed) return;
    target.destroyed = true;
    if (!this.disposed) this.destroyedListener?.(targetId);
    if (this.matched.has(targetId) || this.disposed) return;
    this.lost?.({ targetId, openerId: target.openerId });
  }
}
