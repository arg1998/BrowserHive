/** @module infra/browsers/template-view — the `SessionView` of a virtual session: its own pages of a shared template host, new tabs placed in its own windows, per-page headers and display options, and a close that touches nothing else (spec 13 §3.3, §3.5, §4). */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  Cookie,
  CookieInput,
  LaunchWarning,
  SessionHost,
  SessionView,
} from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplatePageOptions, TemplateViewOptions } from '../../ports/template-host.ts';
import type { TargetFacts } from './page-attribution.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';

/** How long `new_tab` waits for its `window.open` tab before it opens a window instead. */
export const TAB_OPEN_WAIT_MS = 3_000;
/** Per-page close budget (spec 13 §3.5). */
export const PAGE_CLOSE_MS = 5_000;

/** What a view needs from its template host (the host itself; never handed to a session). */
export interface TemplateViewHost extends SessionHost {
  readonly headless: boolean;
  readonly context: BrowserContext;
  readonly dispatcher: HostPageDispatcher;
  /** Opens a background window claimed for `sessionId` and resolves with its adopted page. */
  openWindow(sessionId: string, minimized: boolean, signal?: AbortSignal): Promise<Page>;
  /** Resolves with the next page committed to `sessionId` whose facts match, or `null` after `ms`. */
  awaitPage(
    sessionId: string,
    match: (facts: TargetFacts) => boolean,
    ms: number,
  ): Promise<Page | null>;
  /** Resizes the window of `page` on a headed host (never moves it). */
  resizeWindow(page: Page, width: number, height: number): Promise<void>;
  onCrash(listener: (reason: string) => void): () => void;
  /** The view closed: the host forgets it. */
  viewClosed(sessionId: string): void;
}

/**
 * One virtual session over a template host. Every page method goes through the host's attribution
 * dispatcher, so the view sees exactly the pages attributed to its session; cookies are the host's
 * one jar (a template is one person); storage-state export and the profile directory do not exist
 * for a virtual session.
 */
export class TemplateSessionView implements SessionView {
  readonly sessionId: string;
  readonly host: SessionHost;
  readonly page: Page;
  /** A maintenance session's view (its pages are not agent pages, spec 13 §6.3). */
  readonly maintenance: boolean;
  private readonly owner: TemplateViewHost;
  private readonly options: TemplateViewOptions;
  private readonly log: Logger;
  private headers: Readonly<Record<string, string>> | undefined;
  private readonly unsubscribe: () => void;
  private closing: Promise<readonly LaunchWarning[]> | undefined;

  constructor(
    host: TemplateViewHost,
    sessionId: string,
    page: Page,
    options: TemplateViewOptions,
    logger: Logger,
  ) {
    this.owner = host;
    this.host = host;
    this.sessionId = sessionId;
    this.page = page;
    this.options = options;
    this.maintenance = options.maintenance === true;
    this.log = logger.child({ module: 'browsers.view', sessionId });
    this.headers = options.pageOptions?.extraHTTPHeaders;
    // Every page of the session gets its per-session options, whoever opened it.
    this.unsubscribe = host.dispatcher.onAttributed(sessionId, (opened) => {
      void this.prepare(opened);
    });
  }

  /** Applies the per-session options to the first page (the pipeline awaits it). */
  async prepareFirstPage(): Promise<void> {
    await this.prepare(this.page);
  }

  pages(): readonly Page[] {
    return this.owner.dispatcher.pagesOf(this.sessionId);
  }

  owns(page: Page): boolean {
    const owner = this.owner.dispatcher.ownerOf(page);
    return owner?.kind === 'session' && owner.sessionId === this.sessionId;
  }

  onPage(listener: (page: Page) => void): () => void {
    return this.owner.dispatcher.onAttributed(this.sessionId, listener);
  }

  /**
   * A tab beside the session's active page when it sits in a normal tabbed window (`window.open`
   * in an isolated world with a user gesture: Patchright drops `--disable-popup-blocking`), else a
   * new background window; never `context.newPage()` (spec 13 §3.3).
   */
  async newPage(beside?: Page | null): Promise<Page> {
    if (this.closing !== undefined) throw closedView(this.sessionId);
    this.options.beforeNewPage?.();
    const tab = beside == null || !this.owns(beside) ? null : await this.openTab(beside);
    const page = tab ?? (await this.owner.openWindow(this.sessionId, this.minimized()));
    await this.prepare(page);
    return page;
  }

  cookies(urls?: readonly string[]): Promise<Cookie[]> {
    const context = this.owner.context;
    return urls !== undefined ? context.cookies(urls) : context.cookies();
  }

  addCookies(cookies: readonly CookieInput[]): Promise<void> {
    return this.owner.context.addCookies(cookies);
  }

  /** Per page (spec 13 §4): the session's open pages now, and every page it gets later. */
  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.headers = { ...headers };
    await Promise.all(this.pages().map((page) => page.setExtraHTTPHeaders(headers)));
  }

  storageStateSource(): null {
    return null;
  }

  userDataDir(): null {
    return null;
  }

  newCDPSession(page: Page): Promise<CDPSession> {
    if (!this.owner.dispatcher.everOwnedBy(page, this.sessionId)) {
      return Promise.reject(
        new AppError(
          'INTERNAL_ERROR',
          { ref: 'page-not-owned' },
          { message: `page is not attributed to session ${this.sessionId}` },
        ),
      );
    }
    return this.owner.context.newCDPSession(page);
  }

  onCrash(listener: (reason: string) => void): () => void {
    return this.owner.onCrash(listener);
  }

  /**
   * Closes the session's pages (and so its windows) and nothing else (spec 13 §3.5): the session is
   * released first, so a page that arrives for it afterwards is closed by the host; its tombstones
   * stay. Never throws.
   */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]> {
    this.closing ??= this.teardown(deadlineMs, signal);
    return this.closing;
  }

  private async teardown(
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<readonly LaunchWarning[]> {
    this.unsubscribe();
    const dispatcher = this.owner.dispatcher;
    dispatcher.releaseSession(this.sessionId);
    const pages = dispatcher.pagesOf(this.sessionId);
    const perPage = Math.min(PAGE_CLOSE_MS, deadlineMs);
    const stillOpen: Page[] = [];
    await Promise.all(
      pages.map(async (page) => {
        if (signal?.aborted === true) return;
        const closed = page.close({ runBeforeUnload: false }).then(
          () => true,
          () => true,
        );
        const done = await Promise.race([closed, delay(perPage).then(() => false)]);
        if (!done) stillOpen.push(page);
      }),
    );
    this.owner.viewClosed(this.sessionId);
    // Still attributed to this (released) session: no other session can ever reach them.
    if (stillOpen.length > 0) this.log.warn('pages left open', { count: stillOpen.length });
    return [];
  }

  private minimized(): boolean {
    return !this.owner.headless && this.options.windowState === 'minimized';
  }

  /** `window.open` beside `active`, or `null` when that is not possible here. */
  private async openTab(active: Page): Promise<Page | null> {
    const openerId = this.owner.dispatcher.targetIdOf(active);
    if (openerId === undefined) return null;
    let cdp: CDPSession | undefined;
    try {
      cdp = await this.owner.context.newCDPSession(active);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'browserhive-new-tab',
      });
      const contextId = world.executionContextId;
      const toolbar = await cdp.send('Runtime.evaluate', {
        expression: 'window.toolbar.visible',
        contextId,
        returnByValue: true,
      });
      // A popup window reports `false`: its tab would land in a normal window chosen by Chromium.
      if (toolbar.result.value !== true) return null;
      const opened = this.owner.awaitPage(
        this.sessionId,
        (facts) => facts.openerId === openerId,
        TAB_OPEN_WAIT_MS,
      );
      await cdp.send('Runtime.evaluate', {
        expression: "void window.open('about:blank', '_blank', 'noopener')",
        contextId,
        userGesture: true,
      });
      return await opened;
    } catch (err) {
      // A chrome-error:// or PDF page, a closed page: a window is opened instead.
      this.log.debug('tab open failed', { err: serializeError(err) });
      return null;
    } finally {
      await cdp?.detach().catch(() => undefined);
    }
  }

  /** Applies the per-session page options; a failure is logged (the page may be gone). */
  private async prepare(page: Page): Promise<void> {
    const options: TemplatePageOptions = this.options.pageOptions ?? {};
    try {
      if (this.headers !== undefined) await page.setExtraHTTPHeaders({ ...this.headers });
      if (options.colorScheme !== undefined) {
        await page.emulateMedia({ colorScheme: options.colorScheme });
      }
      const viewport = options.viewport;
      if (viewport !== undefined && viewport !== null) {
        await page.setViewportSize(viewport);
        // Headed: the window follows, or the page is letterboxed inside it (spec 13 §3.3).
        if (!this.owner.headless)
          await this.owner.resizeWindow(page, viewport.width, viewport.height);
      }
    } catch (err) {
      this.log.debug('page options not applied', { err: serializeError(err) });
    }
  }
}

function closedView(sessionId: string): AppError<'SESSION_NOT_LIVE'> {
  return new AppError(
    'SESSION_NOT_LIVE',
    { session_id: sessionId },
    { publicMessage: `Session '${sessionId}' is not live.` },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A close budget must never keep the process alive.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}
