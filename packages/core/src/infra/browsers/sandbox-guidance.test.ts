/** @module infra/browsers/sandbox-guidance.test — the refusal guidance per OS and per detected browser set (plan §3.4.1): working options first, never the Ubuntu text elsewhere. */

import { describe, expect, it } from 'bun:test';
import type { SandboxEnvironment } from './sandbox.ts';
import {
  type GuidanceAlternative,
  renderSandboxGuidance,
  type SandboxGuidanceInput,
  sandboxGuidance,
  shortSandboxGuidance,
  wrap,
} from './sandbox-guidance.ts';

function env(overrides: Partial<SandboxEnvironment> = {}): SandboxEnvironment {
  return {
    platform: 'linux',
    distro: 'Ubuntu 24.04.1 LTS',
    root: false,
    container: false,
    apparmorRestrictsUserns: false,
    usernsCloneDisabled: false,
    userNamespacesDisabled: false,
    ...overrides,
  };
}

const BUNDLED = {
  channel: 'chromium',
  label: 'Chrome for Testing',
  source: 'bundled',
  version: '153.0.8010.12',
  executablePath: '/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
} as const;

const chromeWorks: GuidanceAlternative = {
  channel: 'chrome',
  label: 'Google Chrome',
  state: 'works',
};
const edgeMissing: GuidanceAlternative = {
  channel: 'edge',
  label: 'Microsoft Edge',
  state: 'not-installed',
};

function input(overrides: Partial<SandboxGuidanceInput> = {}): SandboxGuidanceInput {
  return {
    target: BUNDLED,
    reason: 'No usable sandbox!',
    env: env({ apparmorRestrictsUserns: true }),
    apparmorCovered: false,
    alternatives: [chromeWorks, edgeMissing],
    requiredBy: { kind: 'config', setting: '--sandbox on' },
    ...overrides,
  };
}

describe('sandboxGuidance', () => {
  it('Ubuntu 24.04, bundled Chromium, Chrome installed: exactly the plan §3.4.1 block', () => {
    const i = input();
    expect(renderSandboxGuidance(i, sandboxGuidance(i))).toEqual([
      '',
      '  browser   chromium (bundled Chrome for Testing 153.0.8010.12)',
      '            /home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      "  reason    No usable sandbox! (Chrome's own message)",
      '  cause     Ubuntu 24.04.1 LTS restricts unprivileged user namespaces to programs with an',
      '            AppArmor profile (kernel.apparmor_restrict_unprivileged_userns=1). No profile covers',
      '            this path.',
      '',
      'What you can do, easiest first:',
      '  1. Use the installed Google Chrome. It can run sandboxed on this machine (checked):',
      '       browserhive --sandbox on --defaultChannel chrome',
      '  2. Keep the bundled browser and give it an AppArmor profile (one-time, needs sudo; redo after',
      '     each BrowserHive browser update):',
      '       browserhive doctor --printApparmorProfile | sudo tee /etc/apparmor.d/browserhive-chromium',
      '       sudo apparmor_parser -r /etc/apparmor.d/browserhive-chromium',
      '  3. Sandbox where possible, fall back where not:  --sandbox auto',
      '  4. Run without the sandbox, as before:           --sandbox off',
    ]);
  });

  it('Ubuntu with no working browser at all: says so, offers the Chrome install and AppArmor', () => {
    const g = sandboxGuidance(
      input({
        alternatives: [
          { channel: 'chrome', label: 'Google Chrome', state: 'not-installed' },
          edgeMissing,
        ],
      }),
    );
    expect(g.workingChannels).toEqual([]);
    expect(g.options.map((o) => o.text)).toEqual([
      'Keep the bundled browser and give it an AppArmor profile (one-time, needs sudo; redo after each BrowserHive browser update):',
      "Install Google Chrome (needs administrator rights). Ubuntu ships an AppArmor profile for it, so it usually sandboxes; 'browserhive doctor' confirms:",
      'Sandbox where possible, fall back where not:',
      'Run without the sandbox, as before:',
    ]);
    expect(g.options[1]?.commands).toEqual(['browserhive init --installChrome']);
  });

  it('root in Docker: the root/container advice, never the AppArmor text', () => {
    const g = sandboxGuidance(
      input({
        reason: 'Running as root without --no-sandbox is not supported.',
        env: env({ root: true, container: true, apparmorRestrictsUserns: true }),
      }),
    );
    expect(g.cause).toBe(
      'Chrome refuses to run sandboxed as root (uid 0), and this is a container.',
    );
    const text = g.options.map((o) => o.text).join('\n');
    expect(text).toContain('docker run --user');
    expect(text).toContain('seccomp');
    expect(text).not.toContain('AppArmor');
    expect(text).not.toContain('Install Google Chrome');
  });

  it('userns disabled by sysctl: the sysctl to change', () => {
    const g = sandboxGuidance(
      input({ env: env({ usernsCloneDisabled: true }), alternatives: [edgeMissing] }),
    );
    expect(g.cause).toBe(
      'The kernel disables unprivileged user namespaces (kernel.unprivileged_userns_clone=0).',
    );
    expect(g.options[0]?.commands).toEqual(['sudo sysctl -w kernel.unprivileged_userns_clone=1']);
  });

  it('macOS or Windows failing: Chrome’s message and a request to report it, no Linux advice', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const g = sandboxGuidance(
        input({
          reason: 'Sandbox initialization failed.',
          env: env({ platform, distro: null }),
          apparmorCovered: null,
          alternatives: [],
        }),
      );
      expect(g.cause).toBeNull();
      const text = g.options.map((o) => o.text).join('\n');
      expect(text).toContain("Please report this with the output of 'browserhive doctor --json'");
      expect(text).not.toMatch(/AppArmor|sysctl|root/);
    }
  });

  it('a profile that covers the path: no AppArmor option, and the cause says so', () => {
    const g = sandboxGuidance(input({ apparmorCovered: true }));
    expect(g.cause).toContain('A profile names this path, so something else is blocking it.');
    expect(g.options.some((o) => o.text.includes('AppArmor profile'))).toBe(false);
  });

  it('a branded browser without a profile gets a channel-specific profile command', () => {
    const g = sandboxGuidance(
      input({
        target: {
          channel: 'edge',
          label: 'Microsoft Edge',
          source: 'installed',
          version: '153.0.4234.48',
          executablePath: '/opt/microsoft/msedge/msedge',
        },
        alternatives: [chromeWorks],
      }),
    );
    expect(g.options[1]?.commands).toEqual([
      'browserhive doctor --printApparmorProfile --defaultChannel edge | sudo tee /etc/apparmor.d/browserhive-edge',
      'sudo apparmor_parser -r /etc/apparmor.d/browserhive-edge',
    ]);
  });

  it('an agent’s launch_options request: session-level options and the short form', () => {
    const i = input({ requiredBy: { kind: 'launch_options' } });
    const g = sandboxGuidance(i);
    expect(g.options[0]?.commands).toEqual(["launch_session with channel: 'chrome'"]);
    expect(g.options.at(-1)?.text).toBe('Launch without launch_options.chromiumSandbox.');
    expect(shortSandboxGuidance(i, g)).toEqual([
      "Use channel 'chrome', which runs sandboxed on this host.",
      'Or launch without launch_options.chromiumSandbox.',
    ]);
    const none = input({ alternatives: [], requiredBy: { kind: 'config', setting: 'sandbox=on' } });
    expect(shortSandboxGuidance(none, sandboxGuidance(none))).toEqual([
      "Ask the operator to run 'browserhive doctor' for the options on this host.",
    ]);
  });
});

describe('wrap', () => {
  it('wraps on word boundaries', () => {
    expect(wrap('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd']);
    expect(wrap('', 5)).toEqual([]);
  });
});
