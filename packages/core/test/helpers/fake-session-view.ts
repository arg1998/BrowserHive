/** @module test/helpers/fake-session-view — FakeBrowserContext, FakeTracingHandle, FakeBrowserHost and FakeSessionView: an in-memory exclusive host and its one view, with crash injection (spec 09 §4, 13 §3.13). */

import type { Browser, BrowserContext, Page } from 'playwright';
import { sessionOwner } from '../../src/infra/browsers/page-attribution.ts';
import { HostPageDispatcher } from '../../src/infra/browsers/page-dispatcher.ts';
import { ExclusiveSessionView } from '../../src/infra/browsers/session-view.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import type {
  AppliedIdentity,
  BrowserHost,
  EngineCapabilities,
  LaunchWarning,
  SessionBrowserInfo,
  TracingHandle,
} from '../../src/ports/browser-driver.ts';
import { FakeClock } from './fake-clock.ts';
import { asPage, FakePage } from './fake-page.ts';

type Listener = (payload: unknown) => void;

/** Structural cast companion of `asPage` for the context; documented once here, used only by the host. */
function asContext(fake: FakeBrowserContext): BrowserContext {
  const widened: unknown = fake;
  return widened as BrowserContext;
}

/** A recorded `context.route` registration. */
export interface RecordedRoute {
  readonly pattern: string;
  readonly handler: (route: unknown) => unknown;
}

/** In-memory `BrowserContext`: page registry, `page`/`close` events, recorded routes. */
export class FakeBrowserContext {
  readonly fakePages: FakePage[] = [];
  readonly routes: RecordedRoute[] = [];
  /** When true, `route()` throws (simulates a driver that cannot intercept). */
  routeFails = false;
  closed = false;
  readonly tracing = {
    start: async (): Promise<void> => undefined,
    stop: async (): Promise<void> => undefined,
    startChunk: async (): Promise<void> => undefined,
    stopChunk: async (): Promise<void> => undefined,
  };
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly owner: Browser | null = null) {}

  /** This fake typed as a `BrowserContext`. */
  get context(): BrowserContext {
    return asContext(this);
  }

  /** Registers a page without emitting (the initial page). */
  addPage(url = 'about:blank'): FakePage {
    const page = new FakePage(url, this);
    this.fakePages.push(page);
    return page;
  }

  /** Opens a page and emits `page`, like a site-opened popup or `context.newPage()`. */
  async newPage(): Promise<Page> {
    const page = this.addPage();
    this.emit('page', asPage(page));
    return asPage(page);
  }

  /** Emits `page` for an externally created page (popup adoption tests). */
  openPopup(url = 'about:blank'): FakePage {
    const page = this.addPage(url);
    this.emit('page', asPage(page));
    return page;
  }

  pages(): Page[] {
    return this.fakePages.filter((p) => !p.isClosed()).map((p) => asPage(p));
  }

  async route(pattern: string, handler: (route: unknown) => unknown): Promise<void> {
    if (this.routeFails) throw new Error('route interception unavailable');
    this.routes.push({ pattern, handler });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this);
  }

  browser(): Browser | null {
    return this.owner;
  }

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Delivers `payload` to the listeners of `event`. */
  emit(event: string, payload: unknown): number {
    const set = [...(this.listeners.get(event) ?? [])];
    for (const listener of set) listener(payload);
    return set.length;
  }
}

/** Records tracing control calls; `failStop` makes `stop()` reject. */
export class FakeTracingHandle implements TracingHandle {
  readonly calls: string[] = [];
  readonly stopPaths: string[] = [];
  failStop = false;
  stopped = false;

  async pauseChunk(): Promise<void> {
    this.calls.push('pauseChunk');
  }

  async resumeChunk(): Promise<void> {
    this.calls.push('resumeChunk');
  }

  async stop(path: string): Promise<void> {
    this.calls.push('stop');
    if (this.failStop) throw new Error('trace flush failed');
    this.stopped = true;
    this.stopPaths.push(path);
  }
}

/** Constructor options of {@link FakeSessionView} (and its {@link FakeBrowserHost}). */
export interface FakeSessionViewOptions {
  readonly driver?: 'patchright' | 'playwright';
  readonly identity?: AppliedIdentity | null;
  readonly warnings?: readonly LaunchWarning[];
  /** `true` attaches a fresh {@link FakeTracingHandle}; an instance is used as-is. */
  readonly tracing?: boolean | FakeTracingHandle;
  readonly capabilities?: Partial<EngineCapabilities>;
  /** Warnings `close()` resolves with. */
  readonly closeWarnings?: readonly LaunchWarning[];
  /** `null` mimics a persistent context (no separate browser). */
  readonly browser?: Browser | null;
  /** The launch facts a real driver reports (D-31); absent by default, like other fakes. */
  readonly browserInfo?: SessionBrowserInfo;
  /** What `userDataDir()` answers (a persistent session's profile dir); `null` by default. */
  readonly userDataDir?: string | null;
}

/** Recorded `close()` invocation. */
export interface RecordedClose {
  readonly deadlineMs: number;
  readonly aborted: boolean;
}

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  cdpScreencast: true,
  pdf: true,
  trace: true,
  closedShadowRoot: false,
  perContextProxy: true,
  isolatedEvaluate: false,
};

/**
 * In-memory exclusive `BrowserHost` over a {@link FakeBrowserContext}. Its pages go through the real
 * {@link HostPageDispatcher} with the session as fallback owner, exactly as the Playwright host does.
 */
export class FakeBrowserHost implements BrowserHost {
  readonly hostId: string;
  readonly kind = 'exclusive' as const;
  readonly browser: Browser | null;
  readonly fakeContext: FakeBrowserContext;
  readonly context: BrowserContext;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly browserInfo?: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: FakeTracingHandle | null;
  readonly dispatcher: HostPageDispatcher;
  /** The context's first page. */
  readonly firstPage: FakePage;
  /** Pages `ensureIdentityForPage` was called with. */
  readonly identityPages: Page[] = [];
  readonly closes: RecordedClose[] = [];
  closeWarnings: readonly LaunchWarning[];
  closed = false;
  private readonly crashListeners = new Set<(reason: string) => void>();

  constructor(sessionId: string, options: FakeSessionViewOptions = {}) {
    this.hostId = sessionId;
    this.browser = options.browser ?? null;
    this.fakeContext = new FakeBrowserContext(this.browser);
    this.context = this.fakeContext.context;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.driver = options.driver ?? 'playwright';
    this.identity = options.identity ?? null;
    if (options.browserInfo !== undefined) this.browserInfo = options.browserInfo;
    this.warnings = options.warnings ?? [];
    this.tracing =
      options.tracing === undefined || options.tracing === false
        ? null
        : options.tracing === true
          ? new FakeTracingHandle()
          : options.tracing;
    this.closeWarnings = options.closeWarnings ?? [];
    this.dispatcher = new HostPageDispatcher({
      fallback: sessionOwner(sessionId),
      clock: new FakeClock(),
      logger: createCollectingLogger(),
    });
    // The first page, adopted before any listener exists (as `PlaywrightBrowserHost` adopts
    // `context.pages()` at construction).
    this.firstPage = this.fakeContext.addPage();
    this.dispatcher.adopt(asPage(this.firstPage));
    this.fakeContext.on('page', (page) => this.dispatcher.adopt(asPageEvent(page)));
  }

  async ensureIdentityForPage(page: Page): Promise<void> {
    this.identityPages.push(page);
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  /** Fires every crash listener (simulates an out-of-band browser exit). */
  crash(reason = 'browser disconnected'): void {
    for (const listener of [...this.crashListeners]) listener(reason);
  }

  async close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]> {
    this.closes.push({ deadlineMs, aborted: signal?.aborted ?? false });
    this.closed = true;
    await this.fakeContext.close();
    return this.closeWarnings;
  }
}

/** The payload of a fake `page` event is a page made by {@link FakeBrowserContext}. */
function asPageEvent(payload: unknown): Page {
  return payload as Page;
}

/**
 * The real {@link ExclusiveSessionView} over its own {@link FakeBrowserHost}, so ownership checks
 * (`owns`, `newCDPSession`) and delegation are the production code. The test conveniences the
 * former `FakeSessionHandle` had (`fakeContext`, `firstPage`, `tracing`, `closes`, `closed`,
 * `identityPages`, `crash()`) forward to the host so suites read the same.
 */
export class FakeSessionView extends ExclusiveSessionView<FakeBrowserHost> {
  constructor(sessionId: string, options: FakeSessionViewOptions = {}) {
    const host = new FakeBrowserHost(sessionId, options);
    super(host, asPage(host.firstPage), options.userDataDir ?? null);
  }

  /** The host's fake context. */
  get fakeContext(): FakeBrowserContext {
    return this.host.fakeContext;
  }

  /** The context's first page as a fake. */
  get firstPage(): FakePage {
    return this.host.firstPage;
  }

  /** The host's tracing handle. */
  get tracing(): FakeTracingHandle | null {
    return this.host.tracing;
  }

  /** The host's recorded closes. */
  get closes(): readonly RecordedClose[] {
    return this.host.closes;
  }

  /** True once the host closed. */
  get closed(): boolean {
    return this.host.closed;
  }

  /** Pages the host applied the identity to. */
  get identityPages(): readonly Page[] {
    return this.host.identityPages;
  }

  /** Fires the host's crash listeners. */
  crash(reason?: string): void {
    this.host.crash(reason);
  }
}
