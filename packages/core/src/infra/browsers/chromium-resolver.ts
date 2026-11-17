/** @module infra/browsers/chromium-resolver — Chromium executable discovery and the typed `BROWSER_NOT_INSTALLED` error naming `browserhive init` (spec 11 §8, D-18). */

import { existsSync } from 'node:fs';
import type { BrowserType } from 'patchright';
import { AppError } from '../../kernel/errors/app-error.ts';
import { driverVersion } from './driver.ts';
import type { HostFacts } from './host-facts.ts';
import { MISSING_BINARY_RE } from './missing-binary.ts';

/** Dependencies of the resolver; `exists` and `driverVersion` default to production values. */
export interface ChromiumResolverDeps {
  /** Injected env: `PLAYWRIGHT_BROWSERS_PATH` (Patchright reads the same variable) is reported in the error details when set. */
  readonly env: HostFacts['env'];
  readonly exists?: (path: string) => boolean;
  /** The Patchright version named in the install command. */
  readonly driverVersion?: string;
}

/**
 * The exact command the operator must run. `browserhive init` is the documented entry point
 * (D-18: never a `postinstall` download); the underlying `patchright install chromium@<ver>` is
 * named so a host without the CLI can still act on the message.
 */
export function installCommandFor(channel: string, patchrightVersion: string): string {
  if (channel === 'chromium') {
    return `browserhive init  (runs: npx patchright@${patchrightVersion} install chromium)`;
  }
  if (channel === 'chrome') {
    // Google's own installer, run through Patchright's CLI; `init` asks before it does anything.
    return 'browserhive init --installChrome  (runs: npx patchright install chrome, needs administrator rights)';
  }
  return 'install the Microsoft Edge browser on this host';
}

/** Builds the typed error for a missing browser. */
export function browserNotInstalled(
  channel: string,
  deps: ChromiumResolverDeps,
  cause?: unknown,
): AppError<'BROWSER_NOT_INSTALLED'> {
  const installCommand = installCommandFor(
    channel,
    deps.driverVersion ?? driverVersion() ?? 'unknown',
  );
  const browsersPath = deps.env['PLAYWRIGHT_BROWSERS_PATH'];
  const details = { channel, install_command: installCommand };
  return new AppError('BROWSER_NOT_INSTALLED', details, {
    publicMessage: `No browser is installed for channel '${channel}'. Run '${installCommand}' on the host.`,
    message: `No browser is installed for channel '${channel}'${
      browsersPath !== undefined ? ` (PLAYWRIGHT_BROWSERS_PATH=${browsersPath})` : ''
    }. Run '${installCommand}' on the host.`,
    ...(cause !== undefined && { cause }),
  });
}

/**
 * Pre-flight check for the bundled `chromium` channel: the driver computes the expected binary
 * location (honouring `PLAYWRIGHT_BROWSERS_PATH`) without touching the disk, so a missing binary is
 * caught here with a precise message instead of surfacing as a raw launch failure. Branded channels
 * (`chrome`/`edge`) and an explicit `executablePath` are not pre-checked; their launch failure is
 * classified by {@link browserNotInstalledFromLaunchError}.
 *
 * @throws `BROWSER_NOT_INSTALLED`.
 */
export function assertChromiumInstalled(
  browserType: BrowserType,
  channel: string,
  deps: ChromiumResolverDeps,
): void {
  if (channel !== 'chromium') return;
  let path: string;
  try {
    path = browserType.executablePath();
  } catch (err) {
    throw browserNotInstalled(channel, deps, err);
  }
  const exists = deps.exists ?? existsSync;
  if (path.length === 0 || !exists(path)) throw browserNotInstalled(channel, deps);
}

/** Map a raw launch failure onto `BROWSER_NOT_INSTALLED` when the driver reports a missing binary. */
export function browserNotInstalledFromLaunchError(
  err: unknown,
  channel: string,
  deps: ChromiumResolverDeps,
): AppError<'BROWSER_NOT_INSTALLED'> | null {
  if (!(err instanceof Error) || !MISSING_BINARY_RE.test(err.message)) return null;
  return browserNotInstalled(channel, deps, err);
}
