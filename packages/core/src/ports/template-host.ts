/** @module ports/template-host — the shared browser of a session template and its launcher (spec 13 §3.1, §3.3, §3.13): one persistent context, a sentinel window, one background window set per virtual session, attribution of every page before any session sees it. */

import type { Channel, StealthDriver } from '@browserhive/contracts/enums';
import type { BrowserHost, Cookie, GeoSeed, ProxySpec, SessionView } from './browser-driver.ts';

/** The pinned identity a host presents (spec 13 §2.2): the seed of its display and its geo story. */
export interface TemplateHostIdentity {
  /** Feeds the display derivation for the template's life. */
  readonly seed: string;
  /** Locale, languages, timezone and (only when the operator gave them) coordinates. */
  readonly geo: GeoSeed;
}

/** Everything a host start needs, built from the template only; templates take no launch options (spec 13 §3.1). */
export interface TemplateHostSpec {
  readonly templateId: string;
  readonly channel: Channel;
  readonly headless: boolean;
  /** `stealth !== 'off'`. */
  readonly stealth: boolean;
  /** Assert the derived display (only when headless, 11 §2.6 rule 5). */
  readonly fingerprint: boolean;
  readonly stealthDriver: StealthDriver;
  /** `<data-dir>/templates/<id>/userdata`. */
  readonly userDataDir: string;
  /** `<data-dir>/templates/<id>/downloads`. */
  readonly downloadsDir: string;
  readonly identity: TemplateHostIdentity;
  /** The pinned proxy, credentials resolved; `null` = the machine's own IP. */
  readonly proxy: ProxySpec | null;
  /** The window size of every virtual session's window (spec 13 §2.2 `identity_observed.window`). */
  readonly window: { readonly width: number; readonly height: number };
  /**
   * BrowserHive's own origins (`http://127.0.0.1:<port>`, the `publicUrl` origin, …): every request
   * to them is aborted on the host (the self-origin guard, spec 13 §3.8).
   */
  readonly selfOrigins: readonly string[];
  /** Extra Chromium switches from the internal testing seam only (spec 13 §14); never agent input. */
  readonly testingArgs: readonly string[];
}

/** Why a host's browser went away, as the host saw it. */
export interface TemplateHostExit {
  readonly reason: string;
  /**
   * The browser exited within 10 s after its sentinel window was closed by hand: the operator quit
   * the browser (spec 13 §3.2), not a crash.
   */
  readonly operatorStop: boolean;
}

/** Options of one virtual session's view. */
export interface TemplateViewOptions {
  /** The first window's state on a headed host (`agent_windows`, spec 13 §2.1); best effort. */
  readonly windowState: 'normal' | 'minimized';
  /**
   * Runs before every page the session opens itself (`new_tab`), never for site-opened pages; it
   * throws the typed refusal (`TEMPLATE_BUSY`) at a page cap (spec 13 §6.3).
   */
  readonly beforeNewPage?: () => void;
  /**
   * The session's page cap (spec 13 §6.3) for pages a site opens in it: a page attributed to the
   * session beyond it is closed, so one session cannot take the shared browser's pages.
   */
  readonly pageLimit?: number;
  /** Called after a site-opened page over `pageLimit` was closed (the session's warning). */
  readonly onPageLimit?: () => void;
  /** Aborts the wait for the first window; the window is then closed. */
  readonly signal?: AbortSignal;
  /** A maintenance session (spec 13 §1.1): its pages are not agent pages and count toward no cap. */
  readonly maintenance?: boolean;
  /**
   * A recording or re-login window (a maintenance session): while one is open every agent window
   * of the host is minimized and new agent windows open minimized (spec 13 §3.3).
   */
  readonly recording?: boolean;
  /** The three per-session context options (spec 13 §4), applied to each of the session's pages. */
  readonly pageOptions?: TemplatePageOptions;
}

/** Per-page settings of one virtual session (spec 13 §4: viewport, extra headers, color scheme). */
export interface TemplatePageOptions {
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly extraHTTPHeaders?: Readonly<Record<string, string>>;
  readonly colorScheme?: 'light' | 'dark' | 'no-preference' | null;
}

/** A parked page as operator surfaces list it (spec 13 §3.4). */
export interface ParkedPageInfo {
  readonly targetId: string;
  readonly url: string;
  readonly openedAt: number;
}

/** A window that shows pages of several sessions (spec 13 §3.4). */
export interface SharedWindowInfo {
  readonly windowId: number;
  readonly sessionIds: readonly string[];
}

/**
 * The shared browser of one template (`kind: 'template'`, `hostId` = the template id). Only the
 * host supervisor holds it; each virtual session holds its {@link SessionView}, whose `host` is the
 * narrow `SessionHost`.
 *
 * @remarks Invariant (spec 13 §3.4, D-50): every page is attributed to at most one session before
 * any session sees it, an attribution never changes, and a parked page (the sentinel, pages the
 * operator or a service worker opened, restored pages, BrowserHive's probe pages) is in no view.
 */
export interface TemplateHost extends BrowserHost {
  readonly kind: 'template';
  /**
   * Opens a virtual session: a new background window at `about:blank`, claimed for `sessionId`
   * before Playwright adopts it (spec 13 §3.3).
   *
   * @throws AppError `TEMPLATE_UNAVAILABLE` (`reason: 'starting'`) when the window is not adopted
   *   within the adoption deadline or was parked first.
   */
  openView(sessionId: string, options: TemplateViewOptions): Promise<SessionView>;
  /** Agent pages: open pages of agent (non-maintenance) sessions. */
  agentPageCount(): number;
  /** Open pages of one session. */
  sessionPageCount(sessionId: string): number;
  /** Open parked pages, the sentinel excluded, oldest first. */
  parkedPages(): readonly ParkedPageInfo[];
  /** Ids of sessions with an open view. */
  viewIds(): readonly string[];
  /** Subscribes to the end of the browser (crash or operator stop); not called for `close()`. */
  onExit(listener: (exit: TemplateHostExit) => void): () => void;
  /**
   * Saved passwords or autofill data were in the profile when this host started (spec 13 §3.1);
   * the profile is scanned before the browser opens it.
   */
  readonly profileSecrets: boolean;
  /** Every cookie of the template's one jar (operator surfaces: learned names, unlisted sign-ins). */
  jar(): Promise<readonly Cookie[]>;
  /**
   * Removes a registrable domain's cookies and site data (spec 13 §2.3 **Remove sign-in**).
   *
   * @returns The number of cookies removed.
   */
  clearSignIn(domain: string): Promise<number>;
  /** Windows that show pages of more than one session (spec 13 §3.4). */
  sharedWindows(): Promise<readonly SharedWindowInfo[]>;
}

/** Starts template hosts (the Playwright driver; spec 13 §3.1). */
export interface TemplateHostLauncher {
  /**
   * Launches the persistent context of a template, prepares its profile preferences, installs the
   * host's interception chain, parks the sentinel and closes restored pages.
   *
   * @throws AppError `SANDBOX_UNAVAILABLE`, `BROWSER_NOT_INSTALLED`, or `INTERNAL_ERROR` with
   *   `ref` `no_display` (Chromium's display errors), `proxy_unreachable` or `browser-launch`.
   */
  launchTemplateHost(spec: TemplateHostSpec, signal?: AbortSignal): Promise<TemplateHost>;
  /**
   * Empties saved passwords and autofill data of a profile no browser has open (spec 13 §3.1,
   * `POST /templates/{id}/host/clear-profile-secrets`). Absent where unsupported (fakes).
   */
  clearProfileSecrets?(userDataDir: string): Promise<void>;
}
