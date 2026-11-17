/** @module infra/browsers/chromium-resolver.test — binary pre-check and BROWSER_NOT_INSTALLED naming browserhive init. */

import { describe, expect, it } from 'bun:test';
import type { BrowserType } from 'patchright';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  assertChromiumInstalled,
  browserNotInstalledFromLaunchError,
  installCommandFor,
} from './chromium-resolver.ts';
import { driverVersion } from './driver.ts';

function browserTypeAt(path: string): BrowserType {
  const stub: unknown = { executablePath: () => path };
  return stub as BrowserType;
}

describe('installCommandFor', () => {
  it('names browserhive init and the exact patchright install command for chromium', () => {
    expect(installCommandFor('chromium', '1.63.0')).toBe(
      'browserhive init  (runs: npx patchright@1.63.0 install chromium)',
    );
    expect(installCommandFor('chrome', '1.63.0')).toBe(
      'browserhive init --installChrome  (runs: npx patchright install chrome, needs administrator rights)',
    );
    expect(installCommandFor('edge', '1.63.0')).toContain('Microsoft Edge');
  });

  it('reads the pinned Patchright version', () => {
    expect(driverVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('assertChromiumInstalled', () => {
  it('passes when the computed executable exists', () => {
    expect(() =>
      assertChromiumInstalled(browserTypeAt('/browsers/chrome'), 'chromium', {
        env: {},
        exists: () => true,
      }),
    ).not.toThrow();
  });

  it('throws BROWSER_NOT_INSTALLED naming the command and the injected PLAYWRIGHT_BROWSERS_PATH', () => {
    try {
      assertChromiumInstalled(browserTypeAt('/custom/chrome'), 'chromium', {
        env: { PLAYWRIGHT_BROWSERS_PATH: '/custom' },
        exists: () => false,
        driverVersion: '1.63.0',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(isAppError(err, 'BROWSER_NOT_INSTALLED')).toBe(true);
      if (isAppError(err, 'BROWSER_NOT_INSTALLED')) {
        expect(err.details.channel).toBe('chromium');
        expect(err.details.install_command).toContain('patchright@1.63.0 install chromium');
        expect(err.publicMessage).toContain("Run 'browserhive init");
        expect(err.message).toContain('PLAYWRIGHT_BROWSERS_PATH=/custom');
      }
    }
  });

  it('does not pre-check branded channels', () => {
    expect(() =>
      assertChromiumInstalled(browserTypeAt(''), 'chrome', { env: {}, exists: () => false }),
    ).not.toThrow();
  });
});

describe('browserNotInstalledFromLaunchError', () => {
  it("maps the driver's missing-distribution prose and ignores other failures", () => {
    const err = new Error(
      "browserType.launch: Chromium distribution 'chrome' is not found at /opt",
    );
    const mapped = browserNotInstalledFromLaunchError(err, 'chrome', { env: {} });
    expect(mapped?.code).toBe('BROWSER_NOT_INSTALLED');
    expect(mapped?.cause).toBe(err);
    expect(
      browserNotInstalledFromLaunchError(new Error('ECONNRESET'), 'chrome', { env: {} }),
    ).toBeNull();
  });
});
