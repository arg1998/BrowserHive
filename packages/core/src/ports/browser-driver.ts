/** @module ports/browser-driver — engine-neutral session lifecycle port; Playwright types appear only as `type` imports (spec 01 §5, 11 §2.1). */

import type { Channel, PersistenceMode, StealthDriver } from '@browserhive/contracts/enums';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
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

/**
 * A launched, isolated browser session: one browser process, one context. Implementations MUST
 * NOT share `Browser` or `BrowserContext` instances across sessions.
 */
export interface SessionHandle {
  readonly sessionId: string;
  /** `null` for a persistent context; closing the context tears the browser down. */
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  /** The initial page. */
  readonly page: Page;
  readonly capabilities: EngineCapabilities;
  /** `patchright` or `playwright` — what actually launched. */
  readonly driver: 'patchright' | 'playwright';
  /** The identity applied after launch, or `null` when stealth is off or `applyIdentity` failed. */
  readonly identity: AppliedIdentity | null;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: TracingHandle | null;
  /** Applies the UA/UA-CH override to a page and resolves when it is in effect (new tabs await this). */
  ensureIdentityForPage(page: Page): Promise<void>;
  /** Subscribes to unexpected browser exit / context close. Returns an unsubscribe. */
  onCrash(listener: (reason: string) => void): () => void;
  /** Closes everything within `deadlineMs`; never throws (findings become warnings). */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;
}

/** Strategy for spawning a new isolated browser session (spec 01 §9 engine seam). */
export interface BrowserDriver {
  /** Reports which driver stealth sessions will use, for `server_status`/System page. */
  stealthDriverName(): 'patchright' | 'playwright';
  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<SessionHandle>;
}
