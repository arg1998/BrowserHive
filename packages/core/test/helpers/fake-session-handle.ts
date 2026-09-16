/** @module test/helpers/fake-session-handle — FakeBrowserContext, FakeTracingHandle and FakeSessionHandle: an in-memory `SessionHandle` with crash injection (spec 09 §4). */

import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  AppliedIdentity,
  EngineCapabilities,
  LaunchWarning,
  SessionHandle,
  TracingHandle,
} from '../../src/ports/browser-driver.ts';
import { asPage, FakePage } from './fake-page.ts';

type Listener = (payload: unknown) => void;

/** Structural cast companion of `asPage` for the context; documented once here, used only by the handle. */
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

/** Constructor options of {@link FakeSessionHandle}. */
export interface FakeSessionHandleOptions {
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

/** In-memory `SessionHandle` over a {@link FakeBrowserContext}. */
export class FakeSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly browser: Browser | null;
  readonly fakeContext: FakeBrowserContext;
  readonly context: BrowserContext;
  readonly firstPage: FakePage;
  readonly page: Page;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: FakeTracingHandle | null;
  /** Pages `ensureIdentityForPage` was called with. */
  readonly identityPages: Page[] = [];
  readonly closes: RecordedClose[] = [];
  closeWarnings: readonly LaunchWarning[];
  closed = false;
  private readonly crashListeners = new Set<(reason: string) => void>();

  constructor(sessionId: string, options: FakeSessionHandleOptions = {}) {
    this.sessionId = sessionId;
    this.browser = options.browser ?? null;
    this.fakeContext = new FakeBrowserContext(this.browser);
    this.context = this.fakeContext.context;
    this.firstPage = this.fakeContext.addPage();
    this.page = asPage(this.firstPage);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.driver = options.driver ?? 'playwright';
    this.identity = options.identity ?? null;
    this.warnings = options.warnings ?? [];
    this.tracing =
      options.tracing === undefined || options.tracing === false
        ? null
        : options.tracing === true
          ? new FakeTracingHandle()
          : options.tracing;
    this.closeWarnings = options.closeWarnings ?? [];
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
