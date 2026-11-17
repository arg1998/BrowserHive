/** @module infra/browsers/driver — the one browser driver: Patchright's Chromium `BrowserType` for every session, template host, sandbox probe and lookup (D-65, spec 11 §2.1). */

import { createRequire } from 'node:module';
import type { BrowserContext, BrowserType } from 'patchright';
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

/**
 * Turns off Patchright's client-side document route on `context`; call it on every context right
 * after it is created, before any init script, tracing or binding (D-65, deferred item D40).
 *
 * Patchright 1.63 delivers init scripts over CDP (`Page.addScriptToEvaluateOnNewDocument`, before
 * the target resumes), which reaches the main frame, popups and out-of-process iframes. Its client
 * additionally installs `context.route('**\/*')` on the first `addInitScript`, `tracing.start`,
 * `exposeBinding`/`exposeFunction` or `clock.install`, and that route only re-fulfills documents
 * (the body is not changed). A fulfilled document loses its IP address space, so Chromium's Local
 * Network Access check blocks every request it makes to loopback or private addresses; the route
 * also turns request interception on, which answers CORS preflights in the driver, disables the
 * HTTP cache and buffers navigation downloads (a broken one is saved truncated). Patchright skips
 * the route when the context's `routeInjecting` flag is already set. Pinned by
 * `test/integration/init-script-delivery.test.ts`; re-check on every Patchright bump.
 *
 * @returns Whether the flag existed before (`false` means the driver no longer has it).
 */
export function suppressInjectRoute(context: BrowserContext): boolean {
  const target: { routeInjecting?: unknown } = context as unknown as { routeInjecting?: unknown };
  const known = typeof target.routeInjecting === 'boolean';
  target.routeInjecting = true;
  return known;
}
