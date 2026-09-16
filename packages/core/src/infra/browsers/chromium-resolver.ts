/** @module infra/browsers/chromium-resolver — Chromium executable discovery and the typed `BROWSER_NOT_INSTALLED` error naming `browserhive init` (spec 11 §8, D-18). */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BrowserType } from 'playwright';
import { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { HostFacts } from './host-facts.ts';

/** Dependencies of the resolver; `exists` and `playwrightVersion` default to production values. */
export interface ChromiumResolverDeps {
  /** Injected env: `PLAYWRIGHT_BROWSERS_PATH` is reported in the error details when set. */
  readonly env: HostFacts['env'];
  readonly exists?: (path: string) => boolean;
  readonly playwrightVersion?: string;
}

const PackageVersion = z.object({ version: z.string() });

/** The pinned Playwright version, read from its `package.json` (guarded; `unknown` on failure). */
export function pinnedPlaywrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return PackageVersion.parse(require('playwright/package.json')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * The exact command the operator must run. `browserhive init` is the documented entry point
 * (D-18: never a `postinstall` download); the underlying `playwright install chromium@<ver>` is
 * named so a host without the CLI can still act on the message.
 */
export function installCommandFor(channel: string, playwrightVersion: string): string {
  if (channel === 'chromium') {
    return `browserhive init  (runs: npx playwright install chromium@${playwrightVersion})`;
  }
  return `install the ${channel === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} browser on this host`;
}

/** Builds the typed error for a missing browser. */
export function browserNotInstalled(
  channel: string,
  deps: ChromiumResolverDeps,
  cause?: unknown,
): AppError<'BROWSER_NOT_INSTALLED'> {
  const installCommand = installCommandFor(
    channel,
    deps.playwrightVersion ?? pinnedPlaywrightVersion(),
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
 * Pre-flight check for the bundled `chromium` channel: Playwright computes the expected binary
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

/** Playwright's launch-time prose for a missing binary or branded distribution. */
const MISSING_BINARY_RE =
  /Executable doesn't exist at|Chromium distribution '[\w-]+' is not found|Looks like Playwright Test or Playwright was just installed or updated|Failed to launch: .*ENOENT/;

/** Map a raw launch failure onto `BROWSER_NOT_INSTALLED` when Playwright reports a missing binary. */
export function browserNotInstalledFromLaunchError(
  err: unknown,
  channel: string,
  deps: ChromiumResolverDeps,
): AppError<'BROWSER_NOT_INSTALLED'> | null {
  if (!(err instanceof Error) || !MISSING_BINARY_RE.test(err.message)) return null;
  return browserNotInstalled(channel, deps, err);
}
