/** @module infra/browsers/bundled-chromium — version of the Chromium build a driver package (Playwright or Patchright) downloads and launches for the `chromium` channel. */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { StealthDriverName } from '@browserhive/contracts/enums';
import { z } from 'zod';

const BrowsersJson = z.object({
  browsers: z.array(z.object({ name: z.string(), browserVersion: z.string().optional() })),
});

/** Resolves a module specifier's `package.json` path from a base file, or `null`. */
export type PackageLocator = (specifier: string, from: string) => string | null;

/** Reads a UTF-8 file, or `null`. */
export type FileReader = (path: string) => string | null;

/** Production {@link PackageLocator}: Node resolution from `from`; never throws. */
export function locatePackage(specifier: string, from: string): string | null {
  try {
    return createRequire(from).resolve(`${specifier}/package.json`);
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The Chromium version pinned by the driver's core package (`browsers.json` of `playwright-core`,
 * or of `patchright-core` resolved through `patchright`). This is the build `chromium` sessions launch,
 * so pair it with an existence check of `executablePath()` before reporting it as installed.
 *
 * @returns E.g. `"140.0.7339.16"`, or `null` when the package or its manifest cannot be read.
 */
export function bundledChromiumVersion(
  driver: StealthDriverName,
  deps: {
    readonly locate?: PackageLocator;
    readonly read?: FileReader;
    readonly from?: string;
  } = {},
): string | null {
  const locate = deps.locate ?? locatePackage;
  const read = deps.read ?? readText;
  const from = deps.from ?? import.meta.url;
  const corePackage =
    driver === 'patchright'
      ? (() => {
          const wrapper = locate('patchright', from);
          return wrapper === null ? null : locate('patchright-core', wrapper);
        })()
      : locate('playwright-core', from);
  if (corePackage === null) return null;
  const text = read(join(dirname(corePackage), 'browsers.json'));
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = BrowsersJson.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.browsers.find((b) => b.name === 'chromium')?.browserVersion ?? null;
}
