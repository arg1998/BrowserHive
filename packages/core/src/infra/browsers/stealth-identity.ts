/** @module infra/browsers/stealth-identity — host-coherent UA / UA-CH / Accept-Language derivation and the deviceMemory constant (spec 11 §2.3). */

/**
 * The bundled Chromium leaks two brand-level tells even after the full-binary swap:
 *   1. the UA string can carry `HeadlessChrome`, and
 *   2. `navigator.userAgentData` reports brand **Chromium**, never **Google Chrome** (bundled
 *      Chromium is not branded Chrome), which is itself a fingerprint.
 * This module builds a *coherent* Google-Chrome identity from the **real running browser** (its actual
 * Chrome version, via CDP `Browser.getVersion`) and the **real host OS** (via the injected host
 * facts) — it never invents a foreign OS or version. Because egress is the host IP (the proxy phase
 * is deferred), a host-coherent identity is exactly the right target: a random foreign identity over
 * the host IP would be *less* coherent than the honest baseline.
 *
 * ## This module is the sole owner of the presented UA
 *
 * The UA string, the UA-CH metadata, and `Accept-Language` are set together in **one** CDP
 * `Emulation.setUserAgentOverride` call, and nothing else in the codebase may write them. That rule is
 * not stylistic: a "Chrome" UA string paired with "Chromium" `userAgentData` is a *new* incoherence
 * that neither value produces alone, and it is exactly what two independent writers drift into. The
 * fingerprint layer (`fingerprint.ts`) therefore contributes display geometry only, and the
 * `set_extra_http_headers` tool refuses the headers this override owns.
 *
 * Bundling `Accept-Language` in here is what makes the language story coherent for free. Measured
 * against a real browser: Playwright's context `locale` option emits a bare `Accept-Language: en-CA`
 * and an `navigator.languages` of `['en-CA']`, where real Chrome sends `en-CA,en;q=0.9` and reports
 * `['en-CA', 'en']`. Passing the **unweighted** list (`en-CA,en`) to this CDP parameter makes Chrome
 * produce both correctly, natively — no init script, no `extraHTTPHeaders` (which `locale` silently
 * overrides anyway), and nothing for a later tool call to clobber.
 *
 * Known limitations (documented, not hidden): the UA-CH GREASE brand and `platformVersion` are
 * plausible values, not a byte-exact match to whatever the live Chrome build currently emits.
 */

import type {
  AppliedDisplay,
  AppliedIdentity,
  Brand,
  GeoSeed,
  UaChMetadata,
} from '../../ports/browser-driver.ts';
import type { NativeGetterPayload } from './native-getter.ts';

/**
 * `navigator.deviceMemory` fallback for binaries that report none. Spec range is 0.25–8.
 *
 * Applied **only** when the browser reports nothing, which the full-Chromium binary no longer does —
 * it reports the host's real value. Replacing a true value with an invented one would be a downgrade,
 * so this exists purely to close the `undefined` case that the old headless shell produced.
 */
export const PRESENTED_DEVICE_MEMORY = 8;

/** Inputs to {@link deriveCoherentIdentity}: real browser strings + real host descriptors. */
export interface IdentityInput {
  /** `Browser.getVersion().product`, e.g. `"HeadlessChrome/131.0.6778.86"` or `"Chrome/131.0.6778.86"`. */
  readonly product: string;
  /** `Browser.getVersion().userAgent` — the browser's actual UA string. */
  readonly userAgent: string;
  /** Host `platform`: `'darwin' | 'win32' | 'linux' | …`. */
  readonly hostPlatform: string;
  /** Host `arch`: `'arm64' | 'x64' | …`. */
  readonly hostArch: string;
  /** Host `os.release()`; drives `platformVersion` (spec 11 §2.3). The fallback constants apply when absent. */
  readonly hostRelease?: string;
  /** The asserted geo seed, or `null`/absent to leave the browser's own language behaviour alone. */
  readonly geo?: GeoSeed | null;
  /** The asserted display geometry, for metadata only — it is applied via context options. */
  readonly display?: AppliedDisplay | null;
}

/** The exact CDP `Emulation.setUserAgentOverride` parameters. */
export interface UserAgentOverride {
  readonly userAgent: string;
  readonly platform: string;
  readonly userAgentMetadata: UaChMetadata;
  /**
   * Comma-joined language list, **unweighted**. Chrome appends the `q=` values itself; passing a
   * pre-weighted list produces the malformed `en-CA,en;q=0.9;q=0.9` and a `navigator.languages` of
   * `['en-CA', 'en;q=0.9']` (both measured). Omitted when no geo is asserted.
   */
  readonly acceptLanguage?: string;
}

/** The full derivation result: what to display, plus the exact CDP override payload. */
export interface CoherentIdentity {
  readonly applied: AppliedIdentity;
  readonly override: UserAgentOverride;
  readonly deviceMemory: number;
}

/** A stable, plausible GREASE brand. Chrome always emits one; omitting it is itself a tell. */
const GREASE: Brand = { brand: 'Not_A Brand', version: '24' };
const GREASE_FULL: Brand = { brand: 'Not_A Brand', version: '24.0.0.0' };

/**
 * Plausible recent-release `platformVersion` values (macOS 15, Windows 11, Android 14, Linux 6.5), used
 * when derivation from `os.release()` fails so the UA-CH metadata never carries an empty or malformed
 * version (spec 11 §2.3).
 */
export const FALLBACK_PLATFORM_VERSIONS: Readonly<
  Record<'macOS' | 'Windows' | 'Android' | 'Linux', string>
> = {
  macOS: '15.0.0',
  Windows: '15.0.0', // Win11 => 15.0.0 in UA-CH
  Android: '14.0.0',
  Linux: '6.5.0',
};

/** Darwin kernel major → macOS marketing major. Unknown majors use the fallback constant. */
const DARWIN_TO_MACOS: Readonly<Record<number, number>> = {
  20: 11,
  21: 12,
  22: 13,
  23: 14,
  24: 15,
  25: 26,
};

/** Map a host `platform` to the UA-CH platform name. */
export function uaChPlatformFor(hostPlatform: string): 'macOS' | 'Windows' | 'Android' | 'Linux' {
  switch (hostPlatform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'android':
      return 'Android';
    default:
      return 'Linux';
  }
}

/**
 * UA-CH `platformVersion` derived from the real `os.release()`: macOS from the Darwin major via a
 * marketing table, Windows from the build number (`>= 22000` ⇒ Win11 ⇒ `15.0.0`, else `10.0.0`),
 * Linux from the kernel `major.minor.0`. Any failure to parse returns the fallback constant.
 */
export function platformVersionFor(hostPlatform: string, release: string | undefined): string {
  const platform = uaChPlatformFor(hostPlatform);
  const fallback = FALLBACK_PLATFORM_VERSIONS[platform];
  if (release === undefined) return fallback;
  const parts = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(release.trim());
  if (parts === null) return fallback;
  const major = Number(parts[1]);
  switch (platform) {
    case 'macOS': {
      const marketing = DARWIN_TO_MACOS[major];
      return marketing === undefined ? fallback : `${marketing}.0.0`;
    }
    case 'Windows': {
      const build = parts[3] === undefined ? Number.NaN : Number(parts[3]);
      if (Number.isNaN(build)) return fallback;
      return build >= 22000 ? '15.0.0' : '10.0.0';
    }
    case 'Linux':
      return `${major}.${parts[2] ?? '0'}.0`;
    case 'Android':
      return fallback;
  }
}

/** Map a host `arch` to UA-CH `architecture` + `bitness`. */
export function archFor(hostArch: string): { architecture: string; bitness: string } {
  switch (hostArch) {
    case 'arm64':
      return { architecture: 'arm', bitness: '64' };
    case 'arm':
      return { architecture: 'arm', bitness: '32' };
    case 'ia32':
      return { architecture: 'x86', bitness: '32' };
    default:
      return { architecture: 'x86', bitness: '64' };
  }
}

/** Pull the Chrome `{ major, full }` version out of a `Browser.getVersion().product` string. */
export function parseChromeVersion(product: string): { major: string; full: string } {
  const slash = /\/(\d+(?:\.\d+){1,3})/.exec(product);
  const full = slash?.[1] ?? '131.0.0.0';
  const major = full.split('.')[0] ?? '131';
  return { major, full };
}

/**
 * Derive a host-coherent Google-Chrome identity from the real browser version + host OS. Pure and
 * synchronous — the caller supplies the CDP/host values so this stays unit-testable without a browser.
 */
export function deriveCoherentIdentity(input: IdentityInput): CoherentIdentity {
  const { major, full } = parseChromeVersion(input.product);
  // Normalise the UA: bundled/headless builds can carry `HeadlessChrome` — present as `Chrome`.
  const userAgent = input.userAgent.replace(/HeadlessChrome/g, 'Chrome');
  const platform = uaChPlatformFor(input.hostPlatform);
  const platformVersion = platformVersionFor(input.hostPlatform, input.hostRelease);
  const arch = archFor(input.hostArch);

  // Brand order mirrors Chrome: GREASE + Chromium + Google Chrome, all sharing the major version.
  // Adding **Google Chrome** is the point — bundled Chromium reports only Chromium + GREASE.
  const brands: readonly Brand[] = [
    GREASE,
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  const fullVersionList: readonly Brand[] = [
    GREASE_FULL,
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
  ];

  const userAgentMetadata: UaChMetadata = {
    brands,
    fullVersionList,
    fullVersion: full,
    platform,
    platformVersion,
    architecture: arch.architecture,
    model: '',
    mobile: input.hostPlatform === 'android',
    bitness: arch.bitness,
    wow64: false,
  };

  const geo = input.geo ?? null;

  return {
    applied: {
      userAgent,
      brands,
      platform,
      deviceMemory: PRESENTED_DEVICE_MEMORY,
      chromeMajor: major,
      geo:
        geo === null
          ? null
          : {
              locale: geo.locale,
              languages: [...geo.languages],
              countryCode: geo.countryCode,
              timezoneId: geo.timezoneId,
              source: geo.source,
            },
      display: input.display ?? null,
    },
    override: {
      userAgent,
      platform,
      userAgentMetadata,
      // Unweighted on purpose — Chrome adds the q-values. See the field's doc comment.
      ...(geo !== null && { acceptLanguage: geo.languages.join(',') }),
    },
    deviceMemory: PRESENTED_DEVICE_MEMORY,
  };
}

/**
 * The deviceMemory half of the init-script payload for `installNativeGetters` (no CDP command can
 * set `navigator.deviceMemory`). Applied only when the browser reports none — see
 * {@link PRESENTED_DEVICE_MEMORY}.
 */
export function deviceMemoryPayload(mem: number = PRESENTED_DEVICE_MEMORY): NativeGetterPayload {
  return { deviceMemoryFallback: mem };
}
