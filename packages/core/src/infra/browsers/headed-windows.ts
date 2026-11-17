/** @module infra/browsers/headed-windows — headed windows kept minimized (`headedWindows=minimized`, D-77; spec 13 §3.3): the keeper that minimizes every new page's window and minimizes again a window BrowserHive's own actions restored, while a window the operator restored by hand is left alone; and the browser-level control of an exclusive session's windows (its first window and new tabs created in the background, popups minimized). */

import type { Browser, BrowserContext, CDPSession, Page } from 'patchright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

/** A window's state as Chromium reports it (`Browser.getWindowBounds`). */
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

/** The browser-level window calls the keeper needs. */
export interface WindowControl {
  /** The window id of a page target, or `null` when it cannot be read (closed, not in a window). */
  windowOf(targetId: string): Promise<number | null>;
  /** The window's state, or `null` when the window is gone. */
  stateOf(windowId: number): Promise<WindowState | null>;
  /** Minimizes the window (best effort: a bare X server without a window manager may not). */
  minimizeWindow(windowId: number): Promise<void>;
}

/** How often the keeper reads the state of the windows it keeps, to notice an operator's restore. */
export const RESTORE_POLL_MS = 2_000;

/**
 * A poll this soon after BrowserHive acted (a page target created, a tool call) skips its round:
 * the restore it would see is BrowserHive's own, not the operator's.
 */
export const RESTORE_QUIET_MS = 1_500;

/**
 * Second looks this long after BrowserHive minimized a window or acted, for a window manager that
 * maps or restores late. Short: a window the operator restores later than this is theirs.
 */
export const LATE_RESTORE_MS: readonly number[] = [100, 300];

/**
 * Keeps windows minimized. Chromium restores a minimized window, and gives it the input focus, when
 * BrowserHive presses a pointer in a page (`Input.dispatchMouseEvent` or a touch: every click), when
 * Playwright sizes a window for an emulated viewport, and when a site opens a tab in it; it opens
 * every popup as a normal active window (measured, Chromium 153, Xvfb + openbox). So every new page's
 * window is minimized as soon as the page is seen, and every window a tool call found minimized is
 * minimized again after the call. A window the operator restored by hand (normal before a call, or
 * noticed by a poll every {@link RESTORE_POLL_MS}) is left alone from then on.
 */
export class MinimizedWindows {
  /** Windows this keeper keeps minimized (`kept`) or the operator restored (`operator`). */
  private readonly windows = new Map<number, 'kept' | 'operator'>();
  private readonly control: WindowControl;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly pollMs: number;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private active = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;

  constructor(
    control: WindowControl,
    log: Logger,
    options: { readonly now?: () => number; readonly pollMs?: number } = {},
  ) {
    this.control = control;
    this.log = log;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? RESTORE_POLL_MS;
  }

  /** BrowserHive acted (a page target was created): a restore seen now is not the operator's. */
  targetCreated(): void {
    this.lastActivityAt = this.now();
  }

  /**
   * A page this keeper is responsible for: its window is minimized unless the operator restored
   * that window by hand. Never throws.
   */
  async pageOpened(targetId: string): Promise<void> {
    if (this.disposed) return;
    this.targetCreated();
    try {
      const windowId = await this.control.windowOf(targetId);
      if (windowId === null || this.windows.get(windowId) === 'operator') return;
      this.keep(windowId);
      const state = await this.control.stateOf(windowId);
      if (state === null || state === 'minimized') return;
      await this.control.minimizeWindow(windowId);
      // A window manager that maps a new window after the request shows it again: look twice more.
      this.later([windowId]);
    } catch (err) {
      this.log.debug('window not kept minimized', { err: serializeError(err) });
    }
  }

  /**
   * Runs one of BrowserHive's own actions on the pages of `targets` (a tool call): every window of
   * them that was minimized before is minimized again afterwards when the action restored it (a
   * click does); a kept window found normal before is the operator's from then on.
   */
  async around<T>(targets: () => Promise<readonly string[]>, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return await run();
    this.active++;
    this.targetCreated();
    const minimizedBefore = new Set<number>();
    try {
      for (const targetId of await targets()) {
        const windowId = await this.control.windowOf(targetId);
        if (windowId === null || minimizedBefore.has(windowId)) continue;
        if (this.windows.get(windowId) === 'operator') continue;
        const state = await this.control.stateOf(windowId);
        if (state === 'minimized') {
          minimizedBefore.add(windowId);
          this.keep(windowId);
        } else if (state !== null && this.windows.get(windowId) === 'kept') {
          this.restoredByHand(windowId);
        }
      }
    } catch (err) {
      this.log.debug('window states unread', { err: serializeError(err) });
    }
    try {
      return await run();
    } finally {
      await this.minimizeAgain(minimizedBefore);
      this.active--;
      this.targetCreated();
      if (minimizedBefore.size > 0) this.later(minimizedBefore);
    }
  }

  /** True when the operator restored `windowId` by hand (BrowserHive leaves it alone). */
  restoredByOperator(windowId: number): boolean {
    return this.windows.get(windowId) === 'operator';
  }

  /** Reads every kept window once: gone ones are forgotten, restored ones are the operator's. */
  async poll(): Promise<void> {
    if (this.polling || this.disposed || this.quiet()) return;
    this.polling = true;
    try {
      for (const [windowId, owner] of [...this.windows]) {
        if (owner !== 'kept') continue;
        const state = await this.control.stateOf(windowId);
        // BrowserHive acted meanwhile and may have restored a window: this round says nothing.
        if (this.quiet()) return;
        if (state === null) this.windows.delete(windowId);
        else if (state !== 'minimized') this.restoredByHand(windowId);
      }
    } catch (err) {
      this.log.debug('window states unread', { err: serializeError(err) });
    } finally {
      this.polling = false;
      if (![...this.windows.values()].includes('kept')) this.stopPolling();
    }
  }

  /** Stops polling; idempotent. */
  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.windows.clear();
  }

  /** BrowserHive is acting, or acted a moment ago. */
  private quiet(): boolean {
    return this.active > 0 || this.now() - this.lastActivityAt < RESTORE_QUIET_MS;
  }

  private async minimizeAgain(windows: ReadonlySet<number>): Promise<void> {
    if (this.disposed) return;
    try {
      for (const windowId of windows) {
        if (this.windows.get(windowId) !== 'kept') continue;
        const state = await this.control.stateOf(windowId);
        if (state !== null && state !== 'minimized') await this.control.minimizeWindow(windowId);
      }
    } catch (err) {
      this.log.debug('window not minimized again', { err: serializeError(err) });
    }
  }

  /** Minimizes `windows` again after each of {@link LATE_RESTORE_MS}, if still kept. */
  private later(windows: Iterable<number>): void {
    if (this.disposed) return;
    const ids = new Set(windows);
    for (const ms of LATE_RESTORE_MS) {
      const timer = setTimeout(() => {
        this.targetCreated();
        void this.minimizeAgain(ids);
      }, ms);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    }
  }

  private restoredByHand(windowId: number): void {
    this.windows.set(windowId, 'operator');
    this.log.info('window restored by hand', { windowId });
  }

  private keep(windowId: number): void {
    if (!this.windows.has(windowId)) this.windows.set(windowId, 'kept');
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** How long a page created through `Target.createTarget` may take to be adopted by the driver. */
export const ADOPTION_MS = 10_000;

/**
 * The windows of one exclusive headed session whose windows stay minimized (`headedWindows`
 * `minimized`): a browser-level DevTools session that creates the session's windows in the
 * background (they never take the focus), minimizes every page's window as soon as the driver
 * adopted the page (popups, tabs a site opens) and wraps the session's tool calls (see
 * {@link MinimizedWindows.around}). Never raises a window.
 *
 * With an emulated viewport (the context has a `viewport`), Playwright sizes each new page's window
 * to it with `Browser.setWindowBounds`, which restores a minimized window and gives it the focus; so
 * there a window is created normal in the background and minimized once adopted, and a new tab is a
 * new window. Without one (`viewport: null`, every headed stealth session) a window is created
 * minimized and a new tab opens in the background of the session's minimized window.
 */
export class ExclusiveWindows implements WindowControl {
  readonly keeper: MinimizedWindows;
  private readonly cdp: CDPSession;
  private readonly log: Logger;
  private readonly emulatedViewport: boolean;
  private readonly targetIds = new WeakMap<Page, string>();
  private browserContextId: string | null = null;

  private constructor(cdp: CDPSession, log: Logger, emulatedViewport: boolean) {
    this.cdp = cdp;
    this.log = log;
    this.emulatedViewport = emulatedViewport;
    this.keeper = new MinimizedWindows(this, log);
  }

  /**
   * Opens the browser session. `emulatedViewport`: the context has a `viewport` (Playwright sizes
   * windows to it).
   */
  static async open(
    browser: Browser,
    log: Logger,
    emulatedViewport: boolean,
  ): Promise<ExclusiveWindows> {
    const cdp = await browser.newBrowserCDPSession();
    const windows = new ExclusiveWindows(cdp, log, emulatedViewport);
    // A target created is BrowserHive's activity (a popup, a tab): the poll stays quiet.
    cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'page') windows.keeper.targetCreated();
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    return windows;
  }

  /** Minimizes every page the context adopts from now on, once the driver set it up. */
  watch(context: BrowserContext): void {
    context.on('page', (page) => void this.minimizePage(context, page));
  }

  /**
   * The session's first page, in a new background window (at `about:blank`, navigated afterwards,
   * so the context's init scripts apply), minimized. Falls back to `context.newPage()` (minimized
   * right after) when the context cannot be named or Chromium refuses the window.
   */
  async firstPage(context: BrowserContext): Promise<Page> {
    const contextId = await this.contextId();
    if (contextId !== null) {
      try {
        return await this.openWindow(context, contextId);
      } catch (err) {
        this.log.debug('first window not created', { err: serializeError(err) });
      }
    }
    const page = await context.newPage();
    await this.minimizePage(context, page);
    return page;
  }

  /**
   * A new page that never shows: a tab in the background of the session's minimized window, or
   * with an emulated viewport a new window minimized once adopted (see the class comment).
   */
  async newTab(context: BrowserContext): Promise<Page> {
    const contextId = await this.contextId(context);
    if (contextId === null) {
      const page = await context.newPage();
      await this.minimizePage(context, page);
      return page;
    }
    if (this.emulatedViewport) return await this.openWindow(context, contextId);
    const targetId = await this.create({ browserContextId: contextId });
    const page = await adoptedPage(context, targetId, ADOPTION_MS);
    this.targetIds.set(page, targetId);
    await this.keeper.pageOpened(targetId);
    return page;
  }

  /** Minimizes the window of `page` (a persistent session's first window, a popup). */
  async minimizePage(context: BrowserContext, page: Page): Promise<void> {
    try {
      await this.keeper.pageOpened(await this.targetIdOf(context, page));
    } catch (err) {
      this.log.debug('window not minimized', { err: serializeError(err) });
    }
  }

  /** Runs a tool call on the session's pages (see {@link MinimizedWindows.around}). */
  around<T>(context: BrowserContext, run: () => Promise<T>): Promise<T> {
    const targets = async () => {
      const ids: string[] = [];
      for (const page of context.pages()) {
        const id = await this.targetIdOf(context, page).catch(() => null);
        if (id !== null) ids.push(id);
      }
      return ids;
    };
    return this.keeper.around(targets, run);
  }

  async windowOf(targetId: string): Promise<number | null> {
    try {
      return (await this.cdp.send('Browser.getWindowForTarget', { targetId })).windowId;
    } catch {
      return null;
    }
  }

  async stateOf(windowId: number): Promise<WindowState | null> {
    try {
      const { bounds } = await this.cdp.send('Browser.getWindowBounds', { windowId });
      return bounds.windowState ?? 'normal';
    } catch {
      return null;
    }
  }

  async minimizeWindow(windowId: number): Promise<void> {
    try {
      await this.cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
    } catch (err) {
      this.log.debug('window bounds refused', { err: serializeError(err) });
    }
  }

  /** Stops watching and detaches; idempotent. */
  async dispose(): Promise<void> {
    this.keeper.dispose();
    await this.cdp.detach().catch(() => undefined);
  }

  /**
   * A new background window: created minimized without an emulated viewport; with one, created
   * normal (Playwright sizes it while adopting the page) and minimized once adopted, so the resize
   * never restores a minimized window.
   */
  private async openWindow(context: BrowserContext, browserContextId: string): Promise<Page> {
    const targetId = await this.create({
      browserContextId,
      newWindow: true,
      ...(!this.emulatedViewport && { windowState: 'minimized' as const }),
    });
    try {
      const page = await adoptedPage(context, targetId, ADOPTION_MS);
      this.targetIds.set(page, targetId);
      await this.keeper.pageOpened(targetId);
      return page;
    } catch (err) {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      throw err;
    }
  }

  private async create(params: {
    readonly browserContextId: string;
    readonly newWindow?: boolean;
    readonly windowState?: 'minimized';
  }): Promise<string> {
    const { targetId } = await this.cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
      ...params,
    });
    return targetId;
  }

  /** The target id of `page` (cached; read from its own DevTools session once). */
  private async targetIdOf(context: BrowserContext, page: Page): Promise<string> {
    const known = this.targetIds.get(page);
    if (known !== undefined) return known;
    const id = await targetIdOf(context, page);
    this.targetIds.set(page, id);
    return id;
  }

  /**
   * The browser context id of the session's one context: from a page of it when there is one,
   * else the only context `Target.getBrowserContexts` lists (a fresh exclusive browser has exactly
   * one); `null` when that is not certain.
   */
  private async contextId(context?: BrowserContext): Promise<string | null> {
    if (this.browserContextId !== null) return this.browserContextId;
    try {
      const anchor = context?.pages()[0];
      if (context !== undefined && anchor !== undefined) {
        const cdp = await context.newCDPSession(anchor);
        try {
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          this.browserContextId = targetInfo.browserContextId ?? null;
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      } else {
        const { browserContextIds } = await this.cdp.send('Target.getBrowserContexts');
        this.browserContextId =
          browserContextIds.length === 1 ? (browserContextIds[0] ?? null) : null;
      }
    } catch (err) {
      this.log.debug('browser context unnamed', { err: serializeError(err) });
    }
    return this.browserContextId;
  }
}

/** The target id of `page` (its own DevTools session). */
async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  try {
    return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Resolves with the page of `targetId` once the driver adopted it (about 10 ms after
 * `Target.createTarget` answers); rejects after `ms`.
 */
export function adoptedPage(context: BrowserContext, targetId: string, ms: number): Promise<Page> {
  return new Promise<Page>((resolve, reject) => {
    let done = false;
    const checked = new WeakSet<Page>();
    const finish = (page: Page | null, err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      context.off('page', check);
      if (page !== null) resolve(page);
      else reject(err);
    };
    const check = (page: Page) => {
      if (checked.has(page)) return;
      checked.add(page);
      targetIdOf(context, page).then(
        (id) => {
          if (id === targetId) finish(page);
        },
        () => undefined,
      );
    };
    const timer = setTimeout(
      () =>
        finish(
          null,
          new AppError(
            'INTERNAL_ERROR',
            { ref: 'window-adoption' },
            { message: 'a new window was not adopted in time' },
          ),
        ),
      ms,
    );
    context.on('page', check);
    for (const page of context.pages()) check(page);
  });
}
