/** @module infra/browsers/driver-resolver — Patchright-or-Playwright BrowserType selection for stealth sessions: guarded require, per-instance memo, fail-open (spec 11 §2.1). */

import { createRequire } from 'node:module';
import type { StealthDriver, StealthDriverName } from '@browserhive/contracts/enums';
import type { BrowserType } from 'playwright';
import { chromium as playwrightChromium } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

/**
 * Stealth sessions launch through [Patchright](https://github.com/kaliiiiiiiiii-vinyzu/patchright) —
 * an API-compatible fork of `playwright-core` that patches the client/driver so the automation
 * control plane (notably the `Runtime.enable` CDP leak) stays invisible under real tool use.
 * Patchright is an **optional dependency**, and resolution stays **fail-open**: when the package (or
 * its browser binary) is absent, we degrade gracefully to stock Playwright rather than failing
 * session launch. Non-stealth sessions always use stock Playwright.
 *
 * Design constraints:
 *   - **Fail-open, side-effect-free at import.** A partial install must never break module
 *     evaluation — the guarded `require` is caught and we fall back to stock `chromium`. This is what
 *     keeps the launcher testable with no Patchright binary installed.
 *   - **Patches Chromium only.** Patchright does not support Firefox/WebKit, so this resolver only ever
 *     substitutes the `chromium` BrowserType.
 *   - **Types come from `playwright`.** Patchright is a rename of the identical `playwright-core`
 *     surface, so the Playwright `BrowserType` correctly describes the returned object either way — and
 *     importing types from the optional package would create a hard dependency on it.
 *   - Patchright is always launched through its own `BrowserType`, never `connectOverCDP`
 *     (launch-time patches would be forfeited).
 *
 * `stealthDriver=playwright` (config key; env `BROWSERHIVE_STEALTH_DRIVER`)
 * forces stock Playwright even for stealth sessions; `patchright` makes the driver mandatory.
 */

/** A resolved driver: the BrowserType to launch through and its name for metadata. */
export interface ResolvedDriver {
  readonly browserType: BrowserType;
  readonly driver: StealthDriverName;
}

/** Loads Patchright's Chromium BrowserType, or returns `undefined` when it cannot be resolved. */
export type PatchrightLoader = () => BrowserType | undefined;

/** Guarded `require('patchright')` — the production {@link PatchrightLoader}. Never throws. */
export function loadPatchrightChromium(): BrowserType | undefined {
  try {
    // Guarded require so the absence of the optional dep is a caught failure, not a load-time crash.
    const require = createRequire(import.meta.url);
    const loaded: unknown = require('patchright');
    if (typeof loaded !== 'object' || loaded === null) return undefined;
    const candidate: { chromium?: unknown } = loaded;
    if (typeof candidate.chromium !== 'object' || candidate.chromium === null) return undefined;
    // Patchright exposes the identical `BrowserType` surface; `launch` present is the sanity check.
    const chromium: { launch?: unknown } = candidate.chromium;
    return typeof chromium.launch === 'function' ? (candidate.chromium as BrowserType) : undefined;
  } catch {
    // Package not installed, or its browser binary was never provisioned — fall through to stock.
    return undefined;
  }
}

/** Dependencies of {@link DriverResolver}; everything but the logger has a production default. */
export interface DriverResolverDeps {
  readonly logger: Logger;
  readonly loadPatchright?: PatchrightLoader;
  readonly playwrightChromium?: BrowserType;
}

/**
 * Resolves the Chromium {@link BrowserType} used for **stealth** sessions. Memoised **per instance**
 * (not module-level, so tests and a future multi-driver composition never share state); the first
 * probe decides the driver for that instance's lifetime.
 */
export class DriverResolver {
  private readonly logger: Logger;
  private readonly loadPatchright: PatchrightLoader;
  private readonly stockChromium: BrowserType;
  private probe: { readonly patchright: BrowserType | undefined } | undefined;

  constructor(deps: DriverResolverDeps) {
    this.logger = deps.logger.child({ module: 'browsers.driver' });
    this.loadPatchright = deps.loadPatchright ?? loadPatchrightChromium;
    this.stockChromium = deps.playwrightChromium ?? playwrightChromium;
  }

  /** Stock Playwright Chromium, used by every non-stealth session. */
  stock(): BrowserType {
    return this.stockChromium;
  }

  /**
   * The driver a stealth session launches through under `mode`.
   *
   * @throws `BROWSER_NOT_INSTALLED` when `mode === 'patchright'` and Patchright cannot be resolved.
   */
  resolveStealth(mode: StealthDriver): ResolvedDriver {
    if (mode === 'playwright') return { browserType: this.stockChromium, driver: 'playwright' };
    const patchright = this.probePatchright();
    if (patchright !== undefined) return { browserType: patchright, driver: 'patchright' };
    if (mode === 'patchright') {
      const details = { channel: 'patchright', install_command: 'browserhive init' };
      throw new AppError('BROWSER_NOT_INSTALLED', details, {
        publicMessage:
          "stealthDriver=patchright but the 'patchright' package could not be resolved. Run 'browserhive init' on the host, or set stealthDriver=auto.",
      });
    }
    return { browserType: this.stockChromium, driver: 'playwright' };
  }

  /** The driver name {@link resolveStealth} would report under `mode`, for `server_status`. */
  stealthDriverName(mode: StealthDriver): StealthDriverName {
    if (mode === 'playwright') return 'playwright';
    return this.probePatchright() !== undefined ? 'patchright' : 'playwright';
  }

  private probePatchright(): BrowserType | undefined {
    if (this.probe !== undefined) return this.probe.patchright;
    let patchright: BrowserType | undefined;
    try {
      patchright = this.loadPatchright();
    } catch (err) {
      patchright = undefined;
      this.logger.warn('patchright probe threw', { err: serializeError(err) });
    }
    if (patchright === undefined) {
      this.logger.warn('patchright unavailable', { fallback: 'playwright' });
    }
    this.probe = { patchright };
    return patchright;
  }
}
