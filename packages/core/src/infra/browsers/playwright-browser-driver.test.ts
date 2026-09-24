/** @module infra/browsers/playwright-browser-driver.test — launch failures map to typed errors: a browser that cannot start its sandbox is `SANDBOX_UNAVAILABLE` (`retryable: never`), never `INTERNAL_ERROR`/`backoff`. */

import { describe, expect, it } from 'bun:test';
import type { BrowserType, LaunchOptions } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { LaunchSpec } from '../../ports/browser-driver.ts';
import { DriverResolver } from './driver-resolver.ts';
import { PlaywrightBrowserDriver } from './playwright-browser-driver.ts';

/** What Playwright throws on Ubuntu 23.10+ for the bundled browser with `chromiumSandbox: true`. */
const UBUNTU_SANDBOX_ERROR =
  new Error(`browserType.launch: Target page, context or browser has been closed
Browser logs:

Chromium sandboxing failed!
================================
To avoid the sandboxing issue, do either of the following:
  - (preferred): Configure your environment to support sandboxing
  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option
================================
Call log:
  - [pid=1][err] [1:1:0924/120534.669060:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.`);

function fakeChromium(fail: (options: LaunchOptions) => Error | null): {
  readonly type: BrowserType;
  readonly calls: LaunchOptions[];
} {
  const calls: LaunchOptions[] = [];
  const launch = async (options: LaunchOptions = {}) => {
    calls.push(options);
    const failure = fail(options);
    if (failure !== null) throw failure;
    throw new Error('not reached in these tests');
  };
  const type = {
    launch,
    launchPersistentContext: async (_dir: string, options: LaunchOptions = {}) => launch(options),
    executablePath: () => '/cache/chromium-1243/chrome',
  };
  // A structural stand-in: only the members the launcher touches before the failure exist.
  return { type: type as unknown as BrowserType, calls };
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    sessionId: 'shop-aaaaaaaa',
    channel: 'chromium',
    incognito: false,
    headless: true,
    persistenceMode: 'memory',
    stealth: false,
    stealthDriver: 'playwright',
    proxy: null,
    downloadsDir: '/data/sessions/shop-aaaaaaaa/downloads',
    ...overrides,
  };
}

function driverFor(type: BrowserType): PlaywrightBrowserDriver {
  const logger = createCollectingLogger();
  return new PlaywrightBrowserDriver({
    logger,
    clock: new FakeClock(),
    host: { platform: 'linux', arch: 'x64', release: '6.8.0', env: {} },
    stealthDriver: 'playwright',
    driverResolver: new DriverResolver({
      logger,
      playwrightChromium: type,
      loadPatchright: () => undefined,
    }),
    chromium: { exists: () => true, playwrightVersion: '1.63.0' },
  });
}

async function launchError(driver: PlaywrightBrowserDriver, s: LaunchSpec): Promise<unknown> {
  try {
    await driver.launch(s);
  } catch (err) {
    return err;
  }
  throw new Error('launch unexpectedly succeeded');
}

describe('launch failure classification', () => {
  it('launch_options.chromiumSandbox on a host that cannot sandbox → SANDBOX_UNAVAILABLE, retryable never', async () => {
    const chromium = fakeChromium((o) =>
      o.chromiumSandbox === true ? UBUNTU_SANDBOX_ERROR : null,
    );
    const err = await launchError(
      driverFor(chromium.type),
      spec({ launchOptions: { chromiumSandbox: true } }),
    );
    expect(err).toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      retryable: 'never',
      details: {
        channel: 'chromium',
        reason: 'No usable sandbox!',
        required_by: 'launch_options',
      },
    });
    const message = (err as { publicMessage?: string }).publicMessage ?? '';
    expect(message).toStartWith(
      "Channel 'chromium' cannot run with Chromium's sandbox on this host: No usable sandbox!",
    );
    expect(message).toContain('Retrying will not help.');
    expect(message).toContain('launch_options.chromiumSandbox');
    // One attempt: a sandbox the agent asked for is never silently dropped.
    expect(chromium.calls).toHaveLength(1);
  });

  it('other launch failures stay INTERNAL_ERROR', async () => {
    const chromium = fakeChromium(() => new Error('Timeout 180000ms exceeded.'));
    const err = await launchError(driverFor(chromium.type), spec());
    expect(err).toMatchObject({ code: 'INTERNAL_ERROR', details: { ref: 'browser-launch' } });
  });
});
