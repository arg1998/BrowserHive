/** @module infra/browsers/host-argv.test — a template host's command line with no window (D-78): for representative templates (proxy or not, headless or headed, stealth off/standard/max, chromium and chrome, sandboxed or not) it is exactly the argv the driver would have launched before (its `defaultArgs` minus `ignoreDefaultArgs`) with `about:blank` swapped for `--no-startup-window`; the fail-closed checks refuse a missing proxy switch, a sandbox mismatch and a missing required switch; and the driver still skips its first-page wait only for `ignoreDefaultArgs: true`. */

import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import type { Channel } from '@browserhive/contracts/enums';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { ProxySpec } from '../../ports/browser-driver.ts';
import type { TemplateHostSpec } from '../../ports/template-host.ts';
import { contextOptionsFor, deriveFingerprint } from './fingerprint.ts';
import {
  assertHostArgv,
  driverDefaultArgs,
  hostArgv,
  NO_STARTUP_WINDOW,
  normalizeProxyServer,
  REQUIRED_HOST_SWITCHES,
  serverLaunchOptions,
} from './host-argv.ts';
import { hostLaunchOptions } from './template-launch.ts';

const DIR = '/tmp/bh-argv-test/userdata';

type Stealth = 'off' | 'standard' | 'max';

interface Case {
  readonly channel: Channel;
  readonly headless: boolean;
  readonly stealth: Stealth;
  readonly proxy: ProxySpec | null;
  readonly sandboxed: boolean;
}

const PROXY: ProxySpec = {
  server: 'http://proxy.test:3128',
  bypass: 'internal.test',
  username: 'u',
  // Built at run time: no credential-shaped literal in the source.
  password: ['p', 'w'].join(''),
  label: 'pinned',
};

function spec(c: Case): TemplateHostSpec {
  return {
    templateId: 'tp-argv',
    channel: c.channel,
    headless: c.headless,
    stealth: c.stealth !== 'off',
    fingerprint: c.stealth === 'max',
    userDataDir: DIR,
    downloadsDir: '/tmp/bh-argv-test/downloads',
    identity: {
      seed: 'seed',
      geo: {
        locale: 'en-US',
        languages: ['en-US'],
        countryCode: null,
        timezoneId: 'Europe/Berlin',
        source: 'host',
      },
    },
    proxy: c.proxy,
    window: { width: 1280, height: 800 },
    selfOrigins: [],
    testingArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'],
    ...(c.stealth === 'max' && {
      hostFlags: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }),
  };
}

function optionsOf(c: Case) {
  const s = spec(c);
  const fingerprint = deriveFingerprint({ seed: s.identity.seed, hostPlatform: 'linux' });
  return hostLaunchOptions(
    s,
    contextOptionsFor(fingerprint, s.identity.geo, s.headless && s.fingerprint),
    c.sandboxed,
  );
}

/** What the driver launched before D-78: `_prepareToLaunch`'s `ignoreDefaultArgs` (array) branch. */
async function previousArgv(c: Case): Promise<string[]> {
  const options = optionsOf(c);
  const build = driverDefaultArgs();
  if (build === null) throw new Error('no driver argv builder');
  const ignored = Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : [];
  const all = (await build(serverLaunchOptions(options), true, DIR)) as string[];
  return all.filter((arg) => !ignored.includes(arg));
}

const CASES: Case[] = [];
for (const channel of ['chromium', 'chrome'] as const) {
  for (const headless of [true, false]) {
    for (const stealth of ['off', 'standard', 'max'] as const) {
      for (const proxy of [null, PROXY]) {
        CASES.push({ channel, headless, stealth, proxy, sandboxed: channel === 'chrome' });
      }
    }
  }
}
CASES.push({
  channel: 'chromium',
  headless: false,
  stealth: 'standard',
  proxy: PROXY,
  sandboxed: true,
});
CASES.push({ channel: 'chrome', headless: true, stealth: 'off', proxy: null, sandboxed: false });

function label(c: Case): string {
  return `${c.channel} ${c.headless ? 'headless' : 'headed'} stealth ${c.stealth} ${c.proxy === null ? 'no proxy' : 'proxy'} ${c.sandboxed ? 'sandboxed' : 'no sandbox'}`;
}

describe('host argv (D-78)', () => {
  for (const c of CASES) {
    it(`equals the previous launch's argv with --no-startup-window for its first page: ${label(c)}`, async () => {
      const previous = await previousArgv(c);
      const argv = await hostArgv(optionsOf(c), DIR, { proxy: c.proxy, sandboxed: c.sandboxed });
      expect(previous.at(-1)).toBe('about:blank');
      expect(argv).toEqual([...previous.slice(0, -1), NO_STARTUP_WINDOW]);
      // Nothing BrowserHive relies on silently dropped.
      for (const required of REQUIRED_HOST_SWITCHES) expect(argv).toContain(required);
      expect(argv.includes('--no-sandbox')).toBe(!c.sandboxed);
      expect(argv.includes('--enable-automation')).toBe(false);
      expect(argv.includes('--headless')).toBe(c.headless);
      if (c.proxy !== null) {
        expect(argv).toContain('--proxy-server=http://proxy.test:3128');
        expect(argv.some((a) => a.startsWith('--proxy-bypass-list='))).toBe(true);
      } else {
        expect(argv.some((a) => a.startsWith('--proxy'))).toBe(false);
      }
      if (c.stealth !== 'off') {
        expect(argv).toContain('--disable-blink-features=AutomationControlled');
      }
      if (c.stealth === 'max') {
        expect(argv).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      }
      expect(argv).toContain(`--user-data-dir=${DIR}`);
      expect(argv).toContain('--disable-sync');
    });
  }

  it('refuses a second resolver rule with a SOCKS proxy (it would replace the DNS rule)', async () => {
    const socks: ProxySpec = { server: 'socks5://proxy.test:1080', label: 'socks' };
    const c: Case = {
      channel: 'chromium',
      headless: true,
      stealth: 'standard',
      proxy: socks,
      sandboxed: false,
    };
    // The spec's testing seam adds its own rule: refused with SOCKS.
    await expect(hostArgv(optionsOf(c), DIR, { proxy: socks, sandboxed: false })).rejects.toThrow(
      /host-resolver-rules/,
    );
  });

  it('normalizes the proxy server as the driver does', () => {
    expect(normalizeProxyServer('http://proxy.test:3128/')).toBe('http://proxy.test:3128');
    expect(normalizeProxyServer('proxy.test:3128')).toBe('http://proxy.test:3128');
    expect(normalizeProxyServer('socks5://10.0.0.1:1080')).toBe('socks5://10.0.0.1:1080');
  });

  it('refuses an argv without the template proxy, with the wrong sandbox switch, or missing a required switch', async () => {
    const c: Case = {
      channel: 'chromium',
      headless: true,
      stealth: 'standard',
      proxy: PROXY,
      sandboxed: false,
    };
    const good = await hostArgv(optionsOf(c), DIR, { proxy: PROXY, sandboxed: false });
    const refusal = (
      argv: readonly string[],
      facts: { readonly proxy: ProxySpec | null; readonly sandboxed: boolean } = {
        proxy: PROXY,
        sandboxed: false,
      },
    ) => {
      try {
        assertHostArgv(argv, DIR, facts);
        return null;
      } catch (err) {
        return isAppError(err)
          ? { ref: (err.details as { ref?: string }).ref, message: err.message }
          : err;
      }
    };
    expect(refusal(good)).toBeNull();
    expect(refusal(good.filter((a) => !a.startsWith('--proxy-server')))).toMatchObject({
      ref: 'launch_args',
      message: expect.stringContaining('proxy switch is missing'),
    });
    expect(refusal(good, { proxy: null, sandboxed: false })).toMatchObject({ ref: 'launch_args' });
    expect(refusal(good, { proxy: PROXY, sandboxed: true })).toMatchObject({ ref: 'launch_args' });
    expect(refusal(good.filter((a) => a !== '--no-sandbox'))).toMatchObject({ ref: 'launch_args' });
    for (const required of REQUIRED_HOST_SWITCHES) {
      expect(refusal(good.filter((a) => a !== required))).toMatchObject({
        ref: 'launch_args',
        message: expect.stringContaining(required),
      });
    }
    expect(refusal([...good, 'about:blank'])).toMatchObject({ ref: 'launch_args' });
    // Switches that override the proxy or open another DevTools door (review #91 L2).
    for (const extra of [
      '--no-proxy-server',
      '--proxy-server=direct://',
      '--proxy-pac-url=http://pac.test/p.pac',
      '--proxy-auto-detect',
      '--remote-debugging-port=0',
      '--remote-debugging-address=0.0.0.0',
      '--proxy-bypass-list=*',
      `--user-data-dir=${DIR}`,
      '--remote-debugging-pipe',
    ]) {
      expect(refusal([...good, extra])).toMatchObject({ ref: 'launch_args' });
    }
    expect(
      refusal(
        good.filter((a) => a !== '--remote-debugging-pipe').concat('--remote-debugging-port=0'),
        { proxy: PROXY, sandboxed: false },
      ),
    ).toMatchObject({ ref: 'launch_args' });
    expect(refusal(good.filter((a) => !a.startsWith('--user-data-dir')))).toMatchObject({
      ref: 'launch_args',
    });
  });

  it('the installed driver skips its first-page wait only when it owns no default argument (update D-78 on a mismatch)', () => {
    const require = createRequire(import.meta.url);
    const core = require('patchright-core/lib/coreBundle') as {
      server: { createPlaywright(o: object): { chromium: object } };
    };
    const chromium = core.server.createPlaywright({ sdkLanguage: 'javascript' }).chromium;
    let proto: object | null = Object.getPrototypeOf(chromium);
    let inner: unknown;
    while (proto !== null && inner === undefined) {
      inner = Object.getOwnPropertyDescriptor(proto, '_innerLaunch')?.value;
      proto = Object.getPrototypeOf(proto);
    }
    expect(typeof inner).toBe('function');
    const source = Function.prototype.toString.call(inner);
    expect(source).toMatch(
      /persistent && !options\.ignoreAllDefaultArgs\)\s*await browser\._defaultContext\.loadDefaultContext/,
    );
  });
});
