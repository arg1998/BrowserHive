/** @module ports/browser-driver — engine-neutral session lifecycle port: a `BrowserHost` and the `SessionView`s over it; Playwright types appear only as `type` imports (spec 01 §5, 11 §2.1, 13 §3.13). */

import type { Channel, PersistenceMode, StealthDriver } from '@browserhive/contracts/enums';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  LaunchOptions,
  Page,
} from 'playwright';

/** UA-CH brand entry (`{ brand, version }`). */
export interface Brand {
  readonly brand: string;
  readonly version: string;
}

/** The UA Client Hints metadata sent to CDP `Emulation.setUserAgentOverride`. */
export interface UaChMetadata {
  readonly brands: readonly Brand[];
  readonly fullVersionList: readonly Brand[];
  readonly fullVersion: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
  readonly bitness: string;
  readonly wow64: boolean;
}

/** Where a geo seed came from. `proxy` is reserved for the proxy tier (D-13). */
export type GeoSeedSource = 'host' | 'proxy';

/** The locale/timezone story to assert for a session (spec 11 §2.5). Coordinates are never invented. */
export interface GeoSeed {
  readonly locale: string;
  readonly languages: readonly string[];
  readonly countryCode: string | null;
  readonly timezoneId: string;
  readonly geolocation?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy?: number;
  };
  readonly source: GeoSeedSource;
}

/** The geo half of a presented identity. */
export interface AppliedGeo {
  readonly locale: string;
  readonly languages: readonly string[];
  readonly countryCode: string | null;
  readonly timezoneId: string;
  readonly source: GeoSeedSource;
}

/** The display half of a presented identity. */
export interface AppliedDisplay {
  readonly screen: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
}

/** The presented identity, surfaced on session metadata and the dashboard identity card. */
export interface AppliedIdentity {
  readonly userAgent: string;
  readonly brands: readonly Brand[];
  readonly platform: string;
  readonly deviceMemory: number;
  readonly chromeMajor: string;
  readonly geo: AppliedGeo | null;
  readonly display: AppliedDisplay | null;
}

/** Display fingerprint derived from a seed (spec 11 §2.4): screen, window placement and viewport. */
export interface SessionFingerprint {
  readonly seed: string;
  readonly family: 'macos' | 'windows' | 'linux';
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly availTop: number;
    readonly availLeft: number;
  };
  readonly window: {
    readonly outerWidth: number;
    readonly outerHeight: number;
    readonly screenX: number;
    readonly screenY: number;
  };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hardwareConcurrency: number | null;
}

/** What the launcher needs to present a coherent machine; the UA rides CDP after launch. */
export interface LaunchIdentity {
  readonly fingerprint: SessionFingerprint;
  /** `null` asserts no geo (BYO proxy). */
  readonly geo: GeoSeed | null;
  /** `false` for headful sessions or when the caller supplied a viewport. */
  readonly assertDisplay: boolean;
}

/** First-class proxy specification (D-13). Only BYO pass-through is implemented. */
export interface ProxySpec {
  readonly server: string;
  readonly bypass?: string;
  readonly username?: string;
  readonly password?: string;
  /** Operator-facing label recorded as `proxy_label` metadata. */
  readonly label: string;
  /** Who supplied the proxy (D-13): the caller (`byo`) or a managed pool (reserved). */
  readonly source?: 'byo' | 'managed';
}

/** Fully resolved inputs to one launch. The session id is final (`<slug>-<nanoid8>`). */
export interface LaunchSpec {
  readonly sessionId: string;
  readonly channel: Channel;
  readonly incognito: boolean;
  readonly headless: boolean;
  readonly persistenceMode: PersistenceMode;
  /** Managed profile dir; required for `persistent`, ignored otherwise. Never user-supplied. */
  readonly userDataDir?: string;
  /** Storage state file to restore for `storage-state` mode. */
  readonly storageStatePath?: string;
  /** Validated Playwright pass-through; deny-listed args were rejected upstream. */
  readonly launchOptions?: LaunchOptions;
  /** Validated context pass-through; identity options are spread before these so the caller wins. */
  readonly contextOptions?: BrowserContextOptions;
  readonly stealth: boolean;
  /** Which driver to use for stealth sessions; `auto` prefers Patchright, fail-open to Playwright. */
  readonly stealthDriver: StealthDriver;
  readonly identity?: LaunchIdentity;
  readonly proxy: ProxySpec | null;
  /** Session-scoped directory for downloads (`<data-dir>/sessions/<id>/downloads`). */
  readonly downloadsDir: string;
  readonly tracing?: {
    readonly enabled: boolean;
    readonly screenshots: boolean;
    readonly snapshots: boolean;
    /** Session-scoped directory for trace chunk parts (D-13); merged into `stop(path)` at close. */
    readonly partsDir: string;
  };
}

/** Engine capabilities queried by tools and live view instead of assuming Chromium (spec 11 §2.1). */
export interface EngineCapabilities {
  readonly cdpScreencast: boolean;
  readonly pdf: boolean;
  readonly trace: boolean;
  readonly closedShadowRoot: boolean;
  readonly perContextProxy: boolean;
  /** Patchright's isolated-world `evaluate` needs the `isolatedContext: false` argument. */
  readonly isolatedEvaluate: boolean;
}

/** Facts about the running browser that are not part of the presented identity. */
export interface SessionBrowserInfo {
  readonly version: string | null;
  readonly sandboxed: boolean;
}

/** Non-fatal launch finding surfaced as a `SessionWarning`. */
export interface LaunchWarning {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Trace chunking control used by the vault fill (D-13) and session close. */
export interface TracingHandle {
  /** Stops the current chunk without writing; the credential typed afterwards never lands in trace.zip. */
  pauseChunk(): Promise<void>;
  /** Starts a fresh chunk after a pause. */
  resumeChunk(): Promise<void>;
  /** Finalizes tracing into `path`. Idempotent. */
  stop(path: string): Promise<void>;
}

/** A cookie as the browser reports it (Playwright's `Cookie`). */
export type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

/** A cookie to add: `url`, or `domain` plus `path`, alongside name and value (Playwright validates it). */
export type CookieInput = Parameters<BrowserContext['addCookies']>[0][number];

/** Anything that can write a Playwright storage state to a path (a `BrowserContext`). */
export interface StorageStateSource {
  /** `indexedDB` is required so a caller can never silently drop it again (Playwright's default is off). */
  storageState(options: { path: string; indexedDB: boolean }): Promise<unknown>;
}

/**
 * What a session may know about the browser that serves it: facts and page-scoped helpers, never
 * the browser, its context or its lifecycle (spec 13 §3.13). This is the type of
 * `SessionView.host`, so tools, the live view and the vault cannot reach the shared context, the
 * other sessions' pages or `close()` of a template host through a value.
 */
export interface SessionHost {
  /** The session id for an exclusive host, the template id for a template host. */
  readonly hostId: string;
  readonly kind: 'exclusive' | 'template';
  readonly capabilities: EngineCapabilities;
  /** `patchright` or `playwright` — what actually launched. */
  readonly driver: 'patchright' | 'playwright';
  /** The identity applied after launch, or `null` when stealth is off or `applyIdentity` failed. */
  readonly identity: AppliedIdentity | null;
  /** The engine's real version (null when no `Browser` can be read; Chromium persistent contexts expose one) and whether it runs sandboxed. Absent in fakes. */
  readonly browserInfo?: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  /** Per-context tracing; always `null` for a template host (spec 13 §5.4). */
  readonly tracing: TracingHandle | null;
  /** Applies the UA/UA-CH override to a page and resolves when it is in effect (new tabs await this). */
  ensureIdentityForPage(page: Page): Promise<void>;
  /**
   * The OS pid of the browser's main process (the root of its process tree), read once and cached;
   * `null` when it cannot be read. Only the browser-memory metric asks (spec 10 §7), keyed by
   * `hostId`. Absent in fakes.
   */
  browserPid?(): Promise<number | null>;
}

/**
 * One running browser and its context (spec 13 §3.13). An exclusive session gets a host of its own
 * (`kind: 'exclusive'`, `hostId` = the session id); a template host (`kind: 'template'`, PR T1a) is
 * shared by the virtual sessions of one template. Only the driver, the creation pipeline (policy
 * install) and infra hold a `BrowserHost`; a session sees it as a {@link SessionHost}.
 *
 * @remarks An exclusive host MUST NOT be shared between sessions; a template host is shared only by
 * the virtual sessions of its template, and its views MUST satisfy the attribution invariant of
 * spec 13 §3.4. `interface/` modules cannot name `BrowserContext` (dependency-cruiser rule
 * `interface-no-playwright`) nor reach it through a session (`SessionView.host` is a
 * `SessionHost`; the grep rules forbid `.context(` there).
 */
export interface BrowserHost extends SessionHost {
  /** `null` for a persistent context; closing the context tears the browser down. */
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  /** Subscribes to unexpected browser exit / context close. Returns an unsubscribe. */
  onCrash(listener: (reason: string) => void): () => void;
  /** Closes the browser and its context within `deadlineMs`; never throws (findings become warnings). */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;
}

/**
 * What one session may touch: its own pages only (spec 13 §3.13). Tools, the live view and the
 * vault ask the view, never the host's context.
 *
 * @remarks A page is in `pages()` and reaches `onPage` listeners only once the host's attribution
 * dispatcher has attributed it to this session (spec 13 §3.4); an attribution never changes.
 */
export interface SessionView {
  readonly sessionId: string;
  /** Facts about the browser serving this session; never its context or lifecycle. */
  readonly host: SessionHost;
  /** The first page. */
  readonly page: Page;
  /** The open pages attributed to this session, in attribution order. */
  pages(): readonly Page[];
  /** True while `page` is open and attributed to this session. */
  owns(page: Page): boolean;
  /** Pages attributed to this session after it opened (site-opened popups, new tabs). Returns an unsubscribe. */
  onPage(listener: (page: Page) => void): () => void;
  /**
   * Opens a page attributed to this session (exclusive: `context.newPage()`; virtual: spec 13 §3.3,
   * a tab next to `beside` when that page is the session's and sits in a normal tabbed window, else
   * a new background window).
   *
   * @throws AppError `TEMPLATE_BUSY` at a page cap of a template host (spec 13 §6.3).
   */
  newPage(beside?: Page | null): Promise<Page>;
  /** Cookies visible to this session, optionally limited to `urls`. */
  cookies(urls?: readonly string[]): Promise<Cookie[]>;
  /** Adds cookies; the driver validates them and rejects with its own message. */
  addCookies(cookies: readonly CookieInput[]): Promise<void>;
  /** Replaces the extra request headers (exclusive: context-wide; virtual: per page, replayed on new pages). */
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  /**
   * After `set_viewport` on `page`: a virtual session on a headed template also resizes the page's
   * window (size only, clamped to the template's window, never moved; spec 13 §3.3). Absent for
   * exclusive sessions.
   */
  fitWindow?(page: Page, width: number, height: number): Promise<void>;
  /**
   * What `save_storage_state` reads: the session's context, or for a virtual session the template's
   * (one jar), which only an unsealed `state_export` reaches (spec 13 §5.4); `null` when none exists.
   */
  storageStateSource(): StorageStateSource | null;
  /** The managed profile directory of a persistent session; `null` otherwise and for virtual sessions. */
  userDataDir(): string | null;
  /**
   * A DevTools session on one of this session's pages (the live view's screencast and input).
   *
   * @throws `INTERNAL_ERROR` (`ref: 'page-not-owned'`) when `page` was never attributed to this session.
   */
  newCDPSession(page: Page): Promise<CDPSession>;
  /** Subscribes to the host's crash fan-out plus this session's own crash. Returns an unsubscribe. */
  onCrash(listener: (reason: string) => void): () => void;
  /** Closes the session within `deadlineMs`; never throws (exclusive: closes the host; virtual: spec 13 §3.5). */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;
}

/** An exclusive host and its one view, as `BrowserDriver.launch` returns them. */
export interface LaunchedSession {
  /** What the session keeps (`Session.view`). */
  readonly view: SessionView;
  /** The full host, for the creation pipeline's policy install; `view.host` is the same object. */
  readonly host: BrowserHost;
}

/** Strategy for spawning a new isolated browser session (spec 01 §9 engine seam). */
export interface BrowserDriver {
  /** Reports which driver stealth sessions will use, for `server_status`/System page. */
  stealthDriverName(): 'patchright' | 'playwright';
  /** Launches an exclusive host; the session keeps only the view, the pipeline uses the host once. */
  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<LaunchedSession>;
}
