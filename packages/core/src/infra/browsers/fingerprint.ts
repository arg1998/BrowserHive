/** @module infra/browsers/fingerprint — the per-session, host-coherent display fingerprint: catalogue, outside-in derivation, context options, script payload (spec 11 §2.4). */

/**
 * ## What this fixes (all measured, not projected)
 *
 * With the Phase-0 full-Chromium binary, a session's *hardware* signals are already honest —
 * `window.chrome`, five plugins, `pdfViewerEnabled`, a real Metal WebGL renderer, a real
 * `hardwareConcurrency`. What is **not** honest is the display geometry, because Playwright derives
 * all of it from one `viewport` option. Probing a stealth session shows:
 *
 * ```
 * screen 1280x720 · availHeight 720 · innerHeight 720 · outerHeight 720
 * ```
 *
 * Three separate tells in one line: every session in the fleet shares the same 1280x720 (a
 * correlation key), `screen.availHeight === screen.height` (no OS menu bar or taskbar exists), and
 * `outerHeight === innerHeight` (the browser has no tab strip or toolbar). No real desktop browser
 * reports any of those. This module generates a coherent set instead, where
 * `innerHeight < outerHeight <= availHeight <= height` all hold, drawn per session from a catalogue of
 * displays that actually ship on the **host's own platform**.
 *
 * ## Host-coherent, not foreign
 *
 * The identity varies *within* what the host plausibly is; it never claims to be another machine.
 * That is deliberate, and it is the residue of the deferred proxy phase: egress is the host IP, so a
 * foreign identity is strictly worse than an honest one. Concretely, the fields that a page can
 * **cross-check against the real GPU** are left alone — `hardwareConcurrency` and the WebGL
 * vendor/renderer stay native, because a 4-core machine rendering through "Apple M4 Pro" is a
 * contradiction that no amount of screen-size variation buys back. Only genuinely
 * per-user-arbitrary values are varied: which display the user has, and whether their window is
 * maximised.
 *
 * ## Reproducibility
 *
 * Every value is derived from a seed string via `seededRng`, so persisting the seed is enough to
 * resurrect the identity — which is what lets a restored profile present the same machine it was
 * saved as. A new UA and screen size against the same cookie jar is itself a signal.
 */

import type { BrowserContextOptions } from 'playwright';
import type { GeoSeed, SessionFingerprint } from '../../ports/browser-driver.ts';
import { chance, type Rng, seededRng, uniformInt } from './humanize/rng.ts';
import type { NativeGetterPayload, WindowMetrics } from './native-getter.ts';

/** The three display/furniture families we model. */
export type DisplayFamily = SessionFingerprint['family'];

/** One entry in the per-platform display catalogue. */
interface DisplayProfile {
  /** Logical (CSS-pixel) screen width. */
  readonly width: number;
  /** Logical screen height. */
  readonly height: number;
  /** `devicePixelRatio` this display is normally driven at. */
  readonly scale: number;
}

/**
 * Real, currently-shipping desktop displays, in logical CSS pixels at their usual scale factor.
 *
 * Chosen so that any entry is unremarkable on the platform it is listed under: Retina scale factors
 * only on macOS (every Mac shipped in the last several years is Retina, so `dpr: 1` there would be the
 * anomaly), and the common Windows scaling tiers (100 % / 125 % / 150 %) elsewhere. Playwright's own
 * 1280x720 default is deliberately **absent** — it is the single most recognisable automation
 * viewport there is.
 */
export const DISPLAYS: Readonly<Record<DisplayFamily, readonly DisplayProfile[]>> = {
  macos: [
    { width: 1440, height: 900, scale: 2 }, // MacBook Air 13 / Pro 13
    { width: 1470, height: 956, scale: 2 }, // MacBook Air 15
    { width: 1512, height: 982, scale: 2 }, // MacBook Pro 14
    { width: 1728, height: 1117, scale: 2 }, // MacBook Pro 16
    { width: 1920, height: 1080, scale: 2 }, // 4K external, "looks like 1080p"
    { width: 2560, height: 1440, scale: 2 }, // Studio Display / 5K
  ],
  windows: [
    { width: 1920, height: 1080, scale: 1 }, // 1080p at 100 %
    { width: 1536, height: 864, scale: 1.25 }, // 1080p at 125 % — the most common laptop setup
    { width: 1366, height: 768, scale: 1 }, // older 768p laptop
    { width: 1707, height: 960, scale: 1.5 }, // 1440p at 150 %
    { width: 2560, height: 1440, scale: 1 }, // 1440p at 100 %
  ],
  linux: [
    { width: 1920, height: 1080, scale: 1 },
    { width: 1366, height: 768, scale: 1 },
    { width: 2560, height: 1440, scale: 1 },
  ],
};

/**
 * Platform-specific window furniture, in logical pixels.
 *
 * `systemBarHeight` is what the OS reserves from `screen.availHeight` (the macOS menu bar, the
 * Windows taskbar, a typical Linux panel). `browserChromeHeight` is `outerHeight - innerHeight` — the
 * tab strip plus toolbar of a default Chrome window.
 */
export const FURNITURE: Readonly<
  Record<
    DisplayFamily,
    {
      readonly systemBarHeight: number;
      readonly systemBarAtTop: boolean;
      readonly browserChromeHeight: number;
    }
  >
> = {
  // The macOS menu bar sits at the top, so it moves `availTop` as well as shrinking `availHeight`.
  macos: { systemBarHeight: 25, systemBarAtTop: true, browserChromeHeight: 87 },
  // The Windows 11 taskbar is at the bottom: `availHeight` shrinks, `availTop` stays 0.
  windows: { systemBarHeight: 48, systemBarAtTop: false, browserChromeHeight: 96 },
  linux: { systemBarHeight: 27, systemBarAtTop: true, browserChromeHeight: 96 },
};

/** Host `platform` mapped onto the three display/furniture families we model. */
export function displayFamilyFor(hostPlatform: string): DisplayFamily {
  if (hostPlatform === 'darwin') return 'macos';
  if (hostPlatform === 'win32') return 'windows';
  return 'linux';
}

/** Inputs to {@link deriveFingerprint}. */
export interface FingerprintInput {
  /** Stable per-identity seed. Production passes the session id, or the seed restored from a profile. */
  readonly seed: string;
  /** Host `platform`. Selects the display catalogue and window furniture. */
  readonly hostPlatform: string;
}

/**
 * Derive the session's display fingerprint.
 *
 * Order matters, because each step constrains the next: pick a real display, subtract the OS bar to
 * get the available area, then size the window inside *that*, then subtract the browser's own chrome
 * to get the viewport. Working outside-in is what guarantees the inequality chain
 * `innerHeight < outerHeight <= availHeight <= height` holds by construction rather than by luck.
 */
export function deriveFingerprint(input: FingerprintInput): SessionFingerprint {
  const rng = seededRng(input.seed);
  const family = displayFamilyFor(input.hostPlatform);
  const displays = DISPLAYS[family];
  const furniture = FURNITURE[family];

  const display = displays[uniformInt(rng, 0, displays.length - 1)] ?? {
    width: 1920,
    height: 1080,
    scale: 1,
  };

  const availTop = furniture.systemBarAtTop ? furniture.systemBarHeight : 0;
  const availHeight = display.height - furniture.systemBarHeight;
  const availWidth = display.width;

  // Most people run their browser maximised; a minority leave a window inset from the screen edges.
  // Modelling both is what stops window geometry from becoming a fleet-wide constant of its own.
  const maximised = chance(rng, 0.7);
  const { outerWidth, outerHeight, screenX, screenY } = maximised
    ? { outerWidth: availWidth, outerHeight: availHeight, screenX: 0, screenY: availTop }
    : windowInset(rng, availWidth, availHeight, availTop);

  return {
    seed: input.seed,
    family,
    screen: {
      width: display.width,
      height: display.height,
      availWidth,
      availHeight,
      availTop,
      availLeft: 0,
    },
    window: { outerWidth, outerHeight, screenX, screenY },
    // The viewport is the window minus the browser's own chrome; width is unaffected by it.
    viewport: {
      width: outerWidth,
      height: Math.max(400, outerHeight - furniture.browserChromeHeight),
    },
    deviceScaleFactor: display.scale,
    // Left native on purpose: cross-checkable against the real GPU (see the module doc).
    hardwareConcurrency: null,
  };
}

/** Geometry for a non-maximised window: inset from the available area by a plausible margin. */
function windowInset(
  rng: Rng,
  availWidth: number,
  availHeight: number,
  availTop: number,
): WindowMetrics {
  // Keep the inset modest — a window occupying a third of the screen is unusual for a browser.
  const marginX = uniformInt(rng, 40, Math.max(40, Math.round(availWidth * 0.12)));
  const marginY = uniformInt(rng, 20, Math.max(20, Math.round(availHeight * 0.1)));
  const outerWidth = availWidth - marginX;
  const outerHeight = availHeight - marginY;
  return {
    outerWidth,
    outerHeight,
    screenX: uniformInt(rng, 0, marginX),
    screenY: availTop + uniformInt(rng, 0, marginY),
  };
}

/**
 * Playwright `BrowserContextOptions` this identity contributes, to be merged **before** context
 * creation (Playwright cannot change `viewport`, `locale`, or `timezoneId` afterwards).
 *
 * Deliberately absent:
 *   - **`userAgent`.** The UA and its UA-CH metadata must be set together or not at all, and only
 *     CDP `Emulation.setUserAgentOverride` can do that. Two owners of the UA is how a "Chrome" string
 *     with "Chromium" brands happens, so the CDP path owns it exclusively. See `stealth-identity.ts`.
 *   - **`extraHTTPHeaders` for `Accept-Language`.** Measured: Playwright's `locale` wins over
 *     `extraHTTPHeaders` for that header, so setting it there is a silent no-op. The CDP override's
 *     `acceptLanguage` parameter is the mechanism that actually works — and using it also avoids
 *     colliding with the `set_extra_http_headers` tool, which replaces the whole header set.
 *   - **`colorScheme`.** Left at the browser default; pinning `dark` (as the apify injector does)
 *     is a minority setting and therefore a signal of its own.
 *
 * `geolocation` is only emitted when the seed actually knows coordinates — the host resolver never
 * does, and inventing them would manufacture the incoherence the geo seed exists to prevent.
 */
export function contextOptionsFor(
  fingerprint: SessionFingerprint,
  geo: GeoSeed | null,
  assertDisplay = true,
): BrowserContextOptions {
  return {
    ...(assertDisplay
      ? {
          viewport: { ...fingerprint.viewport },
          deviceScaleFactor: fingerprint.deviceScaleFactor,
        }
      : // `viewport: null` means "track the real window", which is what a headful session needs.
        // *Omitting* the key does not do that: Playwright substitutes its 1280x720 default and then
        // resizes the window to match — handing every headful session in the fleet the single most
        // recognisable automation viewport there is. `deviceScaleFactor` must be omitted alongside
        // it (Playwright rejects the pair).
        { viewport: null }),
    ...(geo === null
      ? {}
      : {
          locale: geo.locale,
          timezoneId: geo.timezoneId,
          ...(geo.geolocation !== undefined && { geolocation: { ...geo.geolocation } }),
        }),
  };
}

/** Build the display half of the init-script payload for `installNativeGetters`. */
export function scriptPayloadFor(fingerprint: SessionFingerprint): NativeGetterPayload {
  return { screen: { ...fingerprint.screen }, window: { ...fingerprint.window } };
}
