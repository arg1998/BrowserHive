/** @module test/composition/sandbox.test — `sandbox=on` refuses to start with guidance for this host (exit-3 code, nothing left running), a working browser boots, `auto` probes nothing at boot; `/system` reports the verdicts. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Channel } from '@browserhive/contracts/enums';
import type { DetectedBrowser, SandboxProbeResult } from '@browserhive/core/server';
import { bootServer } from '../../src/composition/index.ts';
import type { SandboxHost } from '../../src/composition/sandbox.ts';
import { sandboxSetting } from '../../src/composition/sandbox.ts';
import { bootInputFor, tempDir } from './support.ts';

const NO_POLICIES = { location: null, names: [], blocking: [] };

function browser(channel: Channel, installed: boolean): DetectedBrowser {
  return {
    channel,
    label: { chromium: 'Chrome for Testing', chrome: 'Google Chrome', edge: 'Microsoft Edge' }[
      channel
    ],
    source: channel === 'chromium' ? 'bundled' : 'installed',
    installed,
    executablePath: installed ? `/bin/${channel}` : null,
    version: installed ? '153.0.8010.12' : null,
    policies: NO_POLICIES,
  };
}

/** A fake host: which channels are installed and what each probe answers. */
function fakeHost(
  verdicts: Partial<Record<Channel, SandboxProbeResult>>,
  options: { readonly apparmor?: boolean } = {},
): SandboxHost & { readonly probed: Channel[] } {
  const probed: Channel[] = [];
  const installed = (c: Channel) => verdicts[c] !== undefined;
  return {
    probed,
    environment: () => ({
      platform: 'linux',
      distro: 'Ubuntu 24.04.1 LTS',
      root: false,
      container: false,
      apparmorRestrictsUserns: options.apparmor ?? true,
      usernsCloneDisabled: false,
      userNamespacesDisabled: false,
    }),
    probe: async (channel) => {
      probed.push(channel);
      return verdicts[channel] ?? { state: 'not-installed' };
    },
    detect: async () => [
      browser('chromium', installed('chromium')),
      browser('chrome', installed('chrome')),
      browser('edge', installed('edge')),
    ],
    executable: (channel) => (installed(channel) ? `/bin/${channel}` : null),
    apparmorCovers: (path) => path === '/bin/chrome',
  };
}

const unavailable = { state: 'unavailable', reason: 'No usable sandbox!' } as const;
const works = { state: 'works', version: '153.0.8010.12' } as const;

let dir = tempDir('bh-sandbox-');
afterEach(() => {
  dir.cleanup();
  dir = tempDir('bh-sandbox-');
});

async function refusal(host: SandboxHost, overrides = {}): Promise<unknown> {
  const input = { ...bootInputFor(dir.path, { sandbox: 'on', ...overrides }), sandboxHost: host };
  try {
    const server = await bootServer(input);
    await server.stop();
  } catch (err) {
    return err;
  }
  throw new Error('boot unexpectedly succeeded');
}

describe('sandbox=on boot preflight', () => {
  it('refuses to start with SANDBOX_UNAVAILABLE and guidance, checked browsers first', async () => {
    const host = fakeHost({ chromium: unavailable, chrome: works });
    const err = await refusal(host);
    expect(err).toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      publicMessage:
        'The sandbox is required (--sandbox on) but the configured browser cannot run sandboxed.',
      details: {
        channel: 'chromium',
        reason: 'No usable sandbox!',
        required_by: 'config',
        alternatives: ['chrome'],
        executable: '/bin/chromium',
      },
    });
    const guidance = (err as { details: { guidance: string[] } }).details.guidance;
    expect(guidance).toContain(
      '  1. Use the installed Google Chrome. It can run sandboxed on this machine (checked):',
    );
    expect(guidance).toContain('       browserhive --sandbox on --defaultChannel chrome');
    expect(guidance.at(-1)).toBe("Exit code 3. 'browserhive doctor' shows this check at any time.");
    // Only on failure were the other installed browsers probed.
    expect(host.probed).toEqual(['chromium', 'chrome']);
    // Nothing is left running: the data dir lock was released, so the same dir boots again.
    const next = await bootServer(bootInputFor(dir.path));
    await next.stop();
  });

  it('a browser that sandboxes boots after one probe', async () => {
    const host = fakeHost({ chromium: works });
    const input = {
      ...bootInputFor(dir.path, { sandbox: 'on', admin: true }),
      sandboxHost: host,
    };
    const server = await bootServer(input);
    try {
      expect(host.probed).toEqual(['chromium']);
    } finally {
      await server.stop();
    }
  });

  it('the configured browser missing: refuses and says to install it', async () => {
    const err = await refusal(fakeHost({ chromium: works }), { defaultChannel: 'chrome' });
    expect(err).toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      publicMessage:
        'The sandbox is required (--sandbox on) but the configured browser (chrome) is not installed, so it cannot be checked.',
    });
    const guidance = (err as { details: { guidance: string[] } }).details.guidance;
    expect(guidance.join('\n')).toContain('browserhive init --installChrome');
  });

  it('sandbox=auto and off probe nothing at boot', async () => {
    for (const sandbox of ['auto', 'off'] as const) {
      const host = fakeHost({ chromium: unavailable });
      const server = await bootServer({
        ...bootInputFor(dir.path, { sandbox }),
        sandboxHost: host,
      });
      await server.stop();
      expect(host.probed).toEqual([]);
    }
  });
});

describe('sandboxSetting', () => {
  it('quotes the setting the way the operator set it', () => {
    const provenance = (source: string) =>
      ({ sandbox: { source } }) as unknown as Parameters<typeof sandboxSetting>[0];
    expect(sandboxSetting(provenance('cli'), undefined, 'on')).toBe('--sandbox on');
    expect(sandboxSetting(provenance('env'), undefined, 'on')).toBe('BROWSERHIVE_SANDBOX=on');
    expect(sandboxSetting(provenance('file'), '/etc/bh.json', 'on')).toBe(
      '"sandbox": "on" in /etc/bh.json',
    );
    expect(sandboxSetting(provenance('default'), undefined, 'on')).toBe('sandbox=on');
  });
});
