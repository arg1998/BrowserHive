/** @module infra/browsers/driver — the one browser driver: Patchright's Chromium `BrowserType` for every session, template host, sandbox probe and lookup (D-65, spec 11 §2.1). */

import { createRequire } from 'node:module';
import type { BrowserType } from 'patchright';
import { chromium } from 'patchright';
import { z } from 'zod';

/**
 * [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) is an API-compatible fork of
 * `playwright-core` whose patches hide the automation control plane (no `Runtime.enable`, no
 * `Console.enable`, no `--enable-automation`). It is BrowserHive's only driver (D-65): sessions with
 * `stealth=off` run on it too, without BrowserHive's own stealth on top. It is always launched
 * through its own `BrowserType`, never `connectOverCDP` (its launch-time patches would be lost).
 */
export const DRIVER_NAME = 'patchright' as const;

/** The driver's Chromium `BrowserType`. */
export function driverChromium(): BrowserType {
  return chromium;
}

const PackageVersion = z.object({ version: z.string() });

/**
 * The installed Patchright version, read from its `package.json` (guarded).
 *
 * @returns E.g. `"1.63.0"`, or `null` when it cannot be read.
 */
export function driverVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return PackageVersion.parse(require('patchright/package.json')).version;
  } catch {
    return null;
  }
}
