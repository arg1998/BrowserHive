/** @module infra/browsers/chromium-resolver.test — binary pre-check and BROWSER_NOT_INSTALLED naming browserhive init. */

import { describe, expect, it } from 'bun:test';
import type { BrowserType } from 'playwright';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  assertChromiumInstalled,
  browserNotInstalledFromLaunchError,
  installCommandFor,
  pinnedPlaywrightVersion,
} from './chromium-resolver.ts';

function browserTypeAt(path: string): BrowserType {
  const stub: unknown = { executablePath: () => path };
  return stub as BrowserType;
}

describe('installCommandFor', () => {
  it('names browserhive init and the exact playwright install command for chromium', () => {
    expect(installCommandFor('chromium', '1.63.0')).toBe(
      'browserhive init  (runs: npx playwright install chromium@1.63.0)',
    );
    expect(installCommandFor('chrome', '1.63.0')).toContain('Google Chrome');
    expect(installCommandFor('edge', '1.63.0')).toContain('Microsoft Edge');
  });

  it('reads the pinned Playwright version', () => {
    expect(pinnedPlaywrightVersion()).toMatch(/^\d+\.\d+\.\d+/);
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
        playwrightVersion: '1.63.0',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(isAppError(err, 'BROWSER_NOT_INSTALLED')).toBe(true);
      if (isAppError(err, 'BROWSER_NOT_INSTALLED')) {
        expect(err.details.channel).toBe('chromium');
        expect(err.details.install_command).toContain('playwright install chromium@1.63.0');
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
  it("maps Playwright's missing-distribution prose and ignores other failures", () => {
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
