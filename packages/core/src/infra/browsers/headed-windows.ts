/** @module infra/browsers/headed-windows — headed windows kept minimized (`headedWindows=minimized`, D-77; spec 13 §3.3): the keeper that minimizes every new page's window and minimizes again a window BrowserHive's own actions restored, while a window the operator restored by hand is left alone; and the browser-level control of an exclusive session's windows (its first window and new tabs created in the background, popups minimized). */

import type { Browser, BrowserContext, CDPSession, Frame, Page } from 'patchright';
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
 * A window BrowserHive acted on this recently (a tool call on it ended, BrowserHive minimized it, a
 * page target was created) and found restored was restored by BrowserHive or the window manager,
 * not the operator.
 */
export const RESTORE_QUIET_MS = 600;

/**
 * Second looks this long after BrowserHive minimized a window or acted, for a window manager that
 * maps or restores late. Short: a window the operator restores later than this is theirs.
 */
export const LATE_RESTORE_MS: readonly number[] = [100, 300];

/**
 * While a tool call runs, the windows it found minimized are minimized again this often (review
 * #89 F1): a click that navigates, or a humanized click followed by typing, would otherwise keep the
 * window active, with the operator's keys landing in the page, for the whole call.
 */
export const DURING_CALL_MS = 40;

/** What the keeper knows about one window. */
interface KeptWindow {
  /** `kept` minimized by BrowserHive, or restored by the `operator` (left alone from then on). */
  owner: 'kept' | 'operator';
  /** Tool calls on the window now running: a restore meanwhile is BrowserHive's. */
  busy: number;
  /** When BrowserHive last acted on it (a call ended, it minimized it). */
  touchedAt: number;
}

/**
 * Keeps windows minimized. Chrome on Linux activates a browser window, which restores a minimized
 * one and gives it the input focus, when a pointer is pressed in its active tab, also when the press
 * comes over the DevTools protocol (`ContentsWebView::DidGetUserInteraction`; every click); Chromium
 * also restores a minimized window when Playwright sizes it for an emulated viewport and when a
 * site opens a tab in it, and opens every popup as a normal active window (measured, Chromium 153,
 * Xvfb + openbox). So every new page's window is minimized as soon as the page is seen, and while a
 * tool call that can press a pointer runs, the windows it found minimized are minimized again every
 * {@link DURING_CALL_MS} and once more after it.
 *
 * A window that turns normal while BrowserHive is not acting on it (no call on it running, nothing
 * done to it for {@link RESTORE_QUIET_MS}) was restored by the operator, or by the page itself (a
 * JavaScript dialog activates its window), and is left alone from then on.
 */
export class MinimizedWindows {
  private readonly windows = new Map<number, KeptWindow>();
  private readonly control: WindowControl;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly duringMs: number;
  /** A page target was created (a site's tab can restore any window of the browser). */
  private lastTargetAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;

  constructor(
    control: WindowControl,
    log: Logger,
    options: {
      readonly now?: () => number;
      readonly pollMs?: number;
      readonly duringMs?: number;
    } = {},
  ) {
    this.control = control;
    this.log = log;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? RESTORE_POLL_MS;
    this.duringMs = options.duringMs ?? DURING_CALL_MS;
  }

  /** A page target was created: a restore seen now is not the operator's. */
  targetCreated(): void {
    this.lastTargetAt = this.now();
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
      if (windowId === null || this.windows.get(windowId)?.owner === 'operator') return;
      const kept = this.keep(windowId);
      const state = await this.control.stateOf(windowId);
      if (state === null || state === 'minimized') return;
      await this.control.minimizeWindow(windowId);
      kept.touchedAt = this.now();
      // A window manager that maps a new window after the request shows it again: look twice more.
      this.later([windowId]);
    } catch (err) {
      this.log.debug('window not kept minimized', { err: serializeError(err) });
    }
  }

  /**
   * Runs one of BrowserHive's own actions that can restore a window (a click, a resize) on the pages
   * of `targets`: the windows of them that are minimized, or that BrowserHive itself restored a
   * moment ago (another call running on it, review #89 F2), are minimized again every
   * {@link DURING_CALL_MS} while it runs and once more after it. A kept window found normal while
   * BrowserHive was not acting on it is the operator's from then on.
   */
  async around<T>(targets: () => Promise<readonly string[]>, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return await run();
    const ours = new Set<number>();
    try {
      for (const targetId of await targets()) {
        const windowId = await this.control.windowOf(targetId);
        if (windowId === null || ours.has(windowId)) continue;
        const known = this.windows.get(windowId);
        if (known?.owner === 'operator') continue;
        const state = await this.control.stateOf(windowId);
        if (state === null) continue;
        if (state === 'minimized') {
          ours.add(windowId);
        } else if (known !== undefined) {
          if (this.actingOn(known)) ours.add(windowId);
          else this.restoredByHand(windowId, known);
        }
      }
    } catch (err) {
      this.log.debug('window states unread', { err: serializeError(err) });
    }
    for (const windowId of ours) this.keep(windowId).busy++;
    let ticking = false;
    const during =
      ours.size === 0
        ? null
        : setInterval(() => {
            if (ticking) return;
            ticking = true;
            void this.minimizeAgain(ours).finally(() => {
              ticking = false;
            });
          }, this.duringMs);
    if (during !== null && typeof during === 'object' && 'unref' in during) during.unref();
    try {
      return await run();
    } finally {
      if (during !== null) clearInterval(during);
      await this.minimizeAgain(ours);
      const at = this.now();
      for (const windowId of ours) {
        const kept = this.windows.get(windowId);
        if (kept === undefined) continue;
        kept.busy = Math.max(0, kept.busy - 1);
        kept.touchedAt = at;
      }
      if (ours.size > 0) this.later(ours);
    }
  }

  /**
   * A kept page committed its first real document. With an emulated viewport Chromium can restore
   * the window around that first navigation (Playwright sizes it then; seen on CI right after a
   * plain `goto`), outside any tool call: the window is BrowserHive's still, so it is minimized
   * again now and at the late looks, unless the operator restored it. Never throws.
   */
  async firstCommit(targetId: string): Promise<void> {
    if (this.disposed) return;
    try {
      const windowId = await this.control.windowOf(targetId);
      if (windowId === null) return;
      const kept = this.windows.get(windowId);
      if (kept === undefined || kept.owner === 'operator') return;
      kept.touchedAt = this.now();
      await this.minimizeAgain(new Set([windowId]));
      this.later([windowId]);
    } catch (err) {
      this.log.debug('window not kept minimized', { err: serializeError(err) });
    }
  }

  /** True when the operator restored `windowId` by hand (BrowserHive leaves it alone). */
  restoredByOperator(windowId: number): boolean {
    return this.windows.get(windowId)?.owner === 'operator';
  }

  /** Reads every kept window BrowserHive is not acting on: gone ones are forgotten, restored ones are the operator's. */
  async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      for (const [windowId, kept] of [...this.windows]) {
        if (kept.owner !== 'kept' || this.actingOn(kept)) continue;
        const state = await this.control.stateOf(windowId);
        // BrowserHive acted on it meanwhile and may have restored it: this read says nothing.
        if (this.actingOn(kept)) continue;
        if (state === null) this.windows.delete(windowId);
        else if (state !== 'minimized') this.restoredByHand(windowId, kept);
      }
    } catch (err) {
      this.log.debug('window states unread', { err: serializeError(err) });
    } finally {
      this.polling = false;
      if (![...this.windows.values()].some((w) => w.owner === 'kept')) this.stopPolling();
    }
  }

  /** Stops polling; idempotent. */
  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.windows.clear();
  }

  /** BrowserHive is acting on the window, or acted on it (or created a page) a moment ago. */
  private actingOn(kept: KeptWindow): boolean {
    const now = this.now();
    return (
      kept.busy > 0 ||
      now - kept.touchedAt < RESTORE_QUIET_MS ||
      now - this.lastTargetAt < RESTORE_QUIET_MS
    );
  }

  private async minimizeAgain(windows: ReadonlySet<number>): Promise<void> {
    if (this.disposed) return;
    try {
      for (const windowId of windows) {
        const kept = this.windows.get(windowId);
        if (kept?.owner !== 'kept') continue;
        const state = await this.control.stateOf(windowId);
        if (state === null || state === 'minimized') continue;
        await this.control.minimizeWindow(windowId);
        kept.touchedAt = this.now();
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
      const timer = setTimeout(() => void this.minimizeAgain(ids), ms);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    }
  }

  private restoredByHand(windowId: number, kept: KeptWindow): void {
    kept.owner = 'operator';
    this.log.info('window restored by hand', { windowId });
  }

  private keep(windowId: number): KeptWindow {
    let kept = this.windows.get(windowId);
    if (kept === undefined) {
      kept = { owner: 'kept', busy: 0, touchedAt: this.now() };
      this.windows.set(windowId, kept);
    }
    if (this.timer === null && !this.disposed) {
      this.timer = setInterval(() => void this.poll(), this.pollMs);
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    }
    return kept;
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
 * there a window is created normal in the background and minimized once adopted. Without one
 * (`viewport: null`, every headed stealth session) a window is created minimized. A new tab is
 * always a new window: a background tab of a minimized window reports `outerWidth/outerHeight`
 * equal to its inner size (measured, review #89 F6), which no front tab of a real window does.
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
   * A new page that never shows: a new background window, minimized (see the class comment). Its
   * page is the front tab of its window, so its outer size is a real window's.
   */
  async newTab(context: BrowserContext): Promise<Page> {
    const contextId = await this.contextId(context);
    if (contextId === null) {
      const page = await context.newPage();
      await this.minimizePage(context, page);
      return page;
    }
    return await this.openWindow(context, contextId);
  }

  /** Minimizes the window of `page` (a persistent session's first window, a popup). */
  async minimizePage(context: BrowserContext, page: Page): Promise<void> {
    try {
      const targetId = await this.targetIdOf(context, page);
      await this.keeper.pageOpened(targetId);
      this.watchFirstCommit(page, targetId);
    } catch (err) {
      this.log.debug('window not minimized', { err: serializeError(err) });
    }
  }

  /** On `page`'s first committed document (not `about:blank`), its window is kept minimized. */
  private watchFirstCommit(page: Page, targetId: string): void {
    const onNavigated = (frame: Frame): void => {
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
      page.off('framenavigated', onNavigated);
      void this.keeper.firstCommit(targetId);
    };
    page.on('framenavigated', onNavigated);
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
      this.watchFirstCommit(page, targetId);
      return page;
    } catch (err) {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      throw err;
    }
  }

  private async create(params: {
    readonly browserContextId: string;
    readonly newWindow: boolean;
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
