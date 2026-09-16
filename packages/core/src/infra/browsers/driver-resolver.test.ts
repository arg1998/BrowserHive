/** @module infra/browsers/driver-resolver.test — Patchright resolution: fail-open, per-instance memo, kill switch, mandatory mode. */

import { describe, expect, it } from 'bun:test';
import type { BrowserType } from 'playwright';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { DriverResolver, loadPatchrightChromium } from './driver-resolver.ts';

/** A stand-in BrowserType; only identity matters to the resolver. */
function fakeBrowserType(name: string): BrowserType {
  const stub: unknown = { name: () => name, launch: async () => undefined };
  return stub as BrowserType;
}

describe('DriverResolver', () => {
  it('prefers Patchright under auto and reports it', () => {
    const patchright = fakeBrowserType('patchright');
    const resolver = new DriverResolver({
      logger: createCollectingLogger(),
      loadPatchright: () => patchright,
      playwrightChromium: fakeBrowserType('playwright'),
    });
    expect(resolver.resolveStealth('auto').driver).toBe('patchright');
    expect(resolver.resolveStealth('auto').browserType).toBe(patchright);
    expect(resolver.stealthDriverName('auto')).toBe('patchright');
    expect(resolver.stealthDriverName('playwright')).toBe('playwright');
  });

  it('fails open to stock Playwright under auto with a warn, and memoises the probe per instance', () => {
    const logger = createCollectingLogger();
    let probes = 0;
    const stock = fakeBrowserType('playwright');
    const resolver = new DriverResolver({
      logger,
      loadPatchright: () => {
        probes++;
        return undefined;
      },
      playwrightChromium: stock,
    });
    const a = resolver.resolveStealth('auto');
    const b = resolver.resolveStealth('auto');
    expect(a.driver).toBe('playwright');
    expect(a.browserType).toBe(stock);
    expect(b.browserType).toBe(a.browserType);
    expect(probes).toBe(1);
    expect(logger.has('patchright unavailable')).toBe(true);
    // A second instance probes again (memo is per instance, not module-level).
    const other = new DriverResolver({
      logger,
      loadPatchright: () => {
        probes++;
        return undefined;
      },
      playwrightChromium: stock,
    });
    other.resolveStealth('auto');
    expect(probes).toBe(2);
  });

  it('never throws when the loader itself throws (fail-open)', () => {
    const resolver = new DriverResolver({
      logger: createCollectingLogger(),
      loadPatchright: () => {
        throw new Error('boom');
      },
      playwrightChromium: fakeBrowserType('playwright'),
    });
    expect(resolver.resolveStealth('auto').driver).toBe('playwright');
  });

  it('playwright mode is the kill switch and skips the probe entirely', () => {
    let probes = 0;
    const resolver = new DriverResolver({
      logger: createCollectingLogger(),
      loadPatchright: () => {
        probes++;
        return fakeBrowserType('patchright');
      },
      playwrightChromium: fakeBrowserType('playwright'),
    });
    expect(resolver.resolveStealth('playwright').driver).toBe('playwright');
    expect(probes).toBe(0);
  });

  it('patchright mode throws BROWSER_NOT_INSTALLED when Patchright is unresolvable', () => {
    const resolver = new DriverResolver({
      logger: createCollectingLogger(),
      loadPatchright: () => undefined,
      playwrightChromium: fakeBrowserType('playwright'),
    });
    try {
      resolver.resolveStealth('patchright');
      throw new Error('expected to throw');
    } catch (err) {
      expect(isAppError(err, 'BROWSER_NOT_INSTALLED')).toBe(true);
      if (isAppError(err, 'BROWSER_NOT_INSTALLED')) {
        expect(err.details.install_command).toBe('browserhive init');
      }
    }
  });

  it('the production loader resolves to a launchable BrowserType or undefined, never throws', () => {
    const loaded = loadPatchrightChromium();
    if (loaded !== undefined) expect(typeof loaded.launch).toBe('function');
  });
});
