/** @module test/lint/e2e-browser-pin — the dashboard e2e runner (`@playwright/test`) and the daemon's driver (Patchright) pin the same Chromium build, so CI's one browser cache serves both (D-65). */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/** The chromium entry of the `browsers.json` next to `pkg`, resolved through `chain`. */
function chromiumOf(from: string, chain: readonly string[]): { revision: string; version: string } {
  let base = from;
  for (const name of chain) base = createRequire(base).resolve(`${name}/package.json`);
  const json: unknown = JSON.parse(readFileSync(join(dirname(base), 'browsers.json'), 'utf8'));
  const browsers = (
    json as { browsers: { name: string; revision: string; browserVersion: string }[] }
  ).browsers;
  const chromium = browsers.find((b) => b.name === 'chromium');
  if (chromium === undefined) throw new Error(`no chromium in ${base}`);
  return { revision: chromium.revision, version: chromium.browserVersion };
}

describe('e2e runner and driver browsers', () => {
  it('pin the same Chromium revision', () => {
    const dashboard = join(ROOT, 'packages/dashboard/package.json');
    const core = join(ROOT, 'packages/core/package.json');
    const runner = chromiumOf(dashboard, ['@playwright/test', 'playwright', 'playwright-core']);
    const driver = chromiumOf(core, ['patchright', 'patchright-core']);
    // If this fails, bump `@playwright/test` and `patchright` together (renovate.json groups them).
    expect(runner).toEqual(driver);
  });
});
