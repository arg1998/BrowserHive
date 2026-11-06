/** @module lib/install/support — what **Install app** does in this browser (04 §18.8.2): the first matching row of the table wins. Pure; relative imports only (no React, no `@/`), so the reading of the environment stays testable with UA fixtures. */

/** One row of 04 §18.8.2. */
export type InstallKind =
  | 'standalone'
  | 'insecure'
  | 'prompt'
  | 'ios'
  | 'chromium-android'
  | 'chromium'
  | 'firefox-windows'
  | 'firefox-linux'
  | 'firefox-unsupported'
  | 'safari-macos'
  | 'unknown';

/** Which Chromium browser, for its own steps (§18.8.3). */
export type ChromiumBrand = 'chrome' | 'edge' | 'other';

/** What the browser reports. */
export interface InstallInput {
  /** A `beforeinstallprompt` event is held and unused. */
  readonly hasPrompt: boolean;
  /** This page runs as an installed app (see {@link isStandalone}). */
  readonly standalone: boolean;
  /** `window.isSecureContext`. */
  readonly secure: boolean;
  readonly userAgent: string;
  /** `navigator.userAgentData?.brands` names (empty when the browser has no UA-CH). */
  readonly uaBrands: readonly string[];
  /** `navigator.userAgentData?.platform` (`null` when absent). */
  readonly uaPlatform: string | null;
  /** `navigator.maxTouchPoints`. */
  readonly maxTouchPoints: number;
}

/** The row, plus the Chromium brand when the row is `chromium`. */
export interface InstallSupport {
  readonly kind: InstallKind;
  readonly brand: ChromiumBrand | null;
}

type Os = 'windows' | 'macos' | 'linux' | 'android' | 'chromeos' | 'other';

/** The display modes of an installed app (04 §18.8.2). */
export const STANDALONE_QUERY =
  '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)';

/** `true` inside an installed app: any app display mode, or iOS's `navigator.standalone`. */
export function isStandalone(env: {
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly navigatorStandalone?: unknown;
}): boolean {
  if (env.navigatorStandalone === true) return true;
  return env.matchMedia?.(STANDALONE_QUERY).matches === true;
}

function osOf(input: InstallInput): Os {
  const platform = (input.uaPlatform ?? '').toLowerCase();
  if (platform === 'windows') return 'windows';
  if (platform === 'macos') return 'macos';
  if (platform === 'android') return 'android';
  if (platform === 'chrome os' || platform === 'chromeos') return 'chromeos';
  if (platform === 'linux') return 'linux';
  const ua = input.userAgent;
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'other';
}

/** iPhone, iPad or iPod; or iPadOS, which reports a Mac UA but has a touch screen. */
function isIos(input: InstallInput): boolean {
  if (/iPhone|iPad|iPod/.test(input.userAgent)) return true;
  return /Macintosh/.test(input.userAgent) && input.maxTouchPoints > 1;
}

function isChromium(input: InstallInput): boolean {
  return input.uaBrands.includes('Chromium') || /Chrome\/|Edg\//.test(input.userAgent);
}

/** Which Chromium brand: Edge and Chrome have their own steps; Brave, Opera, Vivaldi… share one. */
export function chromiumBrand(input: Pick<InstallInput, 'userAgent' | 'uaBrands'>): ChromiumBrand {
  const { userAgent: ua, uaBrands: brands } = input;
  if (brands.includes('Microsoft Edge') || /\bEdg(A|iOS)?\//.test(ua)) return 'edge';
  const others = ['Brave', 'Opera', 'Opera GX', 'Vivaldi', 'Yandex', 'Samsung Internet'];
  if (
    brands.some((b) => others.includes(b)) ||
    /\b(OPR|Vivaldi|YaBrowser|SamsungBrowser)\//.test(ua)
  )
    return 'other';
  if (brands.includes('Google Chrome')) return 'chrome';
  // With UA-CH, a Chromium browser that does not say Google Chrome is another brand.
  if (brands.includes('Chromium')) return 'other';
  return /Chrome\//.test(ua) ? 'chrome' : 'other';
}

function isSafari(input: InstallInput): boolean {
  const ua = input.userAgent;
  return (
    /Safari\//.test(ua) &&
    /Version\//.test(ua) &&
    !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(ua)
  );
}

/** The first matching row of 04 §18.8.2. */
export function installSupport(input: InstallInput): InstallSupport {
  const kind = installKind(input);
  return { kind, brand: kind === 'chromium' ? chromiumBrand(input) : null };
}

function installKind(input: InstallInput): InstallKind {
  if (input.standalone) return 'standalone';
  if (!input.secure) return 'insecure';
  if (input.hasPrompt) return 'prompt';
  if (isIos(input)) return 'ios';
  const os = osOf(input);
  if (isChromium(input)) return os === 'android' ? 'chromium-android' : 'chromium';
  if (/Firefox\//.test(input.userAgent)) {
    if (os === 'windows') return 'firefox-windows';
    if (os === 'linux') return 'firefox-linux';
    // Firefox for Android installs sites from its menu: the generic row says how.
    if (os === 'android') return 'unknown';
    return 'firefox-unsupported';
  }
  if (isSafari(input) && os === 'macos') return 'safari-macos';
  return 'unknown';
}

/** The parts of `window` the dashboard reads. */
export interface InstallWindow {
  readonly isSecureContext: boolean;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly navigator: {
    readonly userAgent: string;
    readonly maxTouchPoints?: number;
    readonly standalone?: unknown;
    readonly userAgentData?:
      | {
          readonly brands?: readonly { readonly brand: string }[];
          readonly platform?: string;
        }
      | undefined;
  };
}

/** Reads {@link InstallInput} from the browser (call it when needed; nothing runs at import). */
export function readInstallInput(win: InstallWindow, hasPrompt: boolean): InstallInput {
  const nav = win.navigator;
  return {
    hasPrompt,
    standalone: isStandalone({
      matchMedia: win.matchMedia?.bind(win),
      navigatorStandalone: nav.standalone,
    }),
    secure: win.isSecureContext,
    userAgent: nav.userAgent,
    uaBrands: (nav.userAgentData?.brands ?? []).map((b) => b.brand),
    uaPlatform: nav.userAgentData?.platform ?? null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
  };
}
