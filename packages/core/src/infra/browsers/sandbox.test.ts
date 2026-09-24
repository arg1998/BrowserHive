/** @module infra/browsers/sandbox.test — sandbox failure recognition and Chrome's reason, host conditions per OS, profile coverage, the AppArmor profile text, and the two-launch probe. */

import { describe, expect, it } from 'bun:test';
import type { Browser, LaunchOptions } from 'playwright';
import {
  apparmorProfile,
  apparmorProfileCovers,
  inspectSandboxEnvironment,
  isSandboxFailure,
  probeSandbox,
  sandboxFailureReason,
} from './sandbox.ts';

/** Playwright's error for Ubuntu 23.10+ with the bundled browser (abridged from a real run). */
const UBUNTU_ERROR = new Error(`launch: Target page, context or browser has been closed
Browser logs:
Chromium sandboxing failed!
================================
To avoid the sandboxing issue, do either of the following:
  - (preferred): Configure your environment to support sandboxing
  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option
================================

Call log:
  - <launching> /home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome --headless
  - [pid=1][err] [1:1:0924/120534.669060:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.
  - [pid=1][err] Received signal 6`);

const ROOT_ERROR = new Error(`launch: Target page, context or browser has been closed
Call log:
  - [pid=7][err] [7:7:0101/000000.000:ERROR:zygote_host_impl_linux.cc(100)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.`);

/** Microsoft Edge on GitHub's Ubuntu 24.04 runner (measured by the sandbox-matrix job). */
const EDGE_ERROR = new Error(`launch: Target page, context or browser has been closed
Browser logs:
[pid=7357][err] [7357:7357:0924/170055.917038:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/microsoft/msedge/msedge-sandbox is owned by root and has mode 4755.`);

const DOCKER_ERROR = new Error(`launch: Target page, context or browser has been closed
Call log:
  - [pid=9][err] Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
  - [pid=9][err] [9:9:0101/000000.000:FATAL:zygote_host_impl_linux.cc(201)] Check failed: . : Operation not permitted (1)`);

describe('sandbox failure recognition', () => {
  it('recognises the Ubuntu, root and Docker failures, not other launch errors', () => {
    expect(isSandboxFailure(UBUNTU_ERROR)).toBe(true);
    expect(isSandboxFailure(ROOT_ERROR)).toBe(true);
    expect(isSandboxFailure(DOCKER_ERROR)).toBe(true);
    expect(isSandboxFailure(EDGE_ERROR)).toBe(true);
    expect(isSandboxFailure(new Error("Executable doesn't exist at /x"))).toBe(false);
    expect(isSandboxFailure(new Error('Timeout 30000ms exceeded'))).toBe(false);
    expect(isSandboxFailure('No usable sandbox')).toBe(false);
  });

  it("extracts Chrome's own sentence, never a guess", () => {
    expect(sandboxFailureReason(UBUNTU_ERROR)).toBe('No usable sandbox!');
    expect(sandboxFailureReason(ROOT_ERROR)).toBe(
      'Running as root without --no-sandbox is not supported.',
    );
    expect(sandboxFailureReason(DOCKER_ERROR)).toBe(
      'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
    );
    expect(
      sandboxFailureReason(
        new Error('x\n  - [err] [1:1:0101/0:FATAL:foo.cc(1)] Something broke. More.'),
      ),
    ).toBe('Something broke.');
    expect(sandboxFailureReason(EDGE_ERROR)).toBe(
      'The SUID sandbox helper binary was found, but is not configured correctly.',
    );
    expect(sandboxFailureReason(new Error('boom\nmore'))).toBe('boom');
  });
});

describe('inspectSandboxEnvironment', () => {
  const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

  it('Ubuntu 24.04 as a normal user: the AppArmor restriction', () => {
    expect(
      inspectSandboxEnvironment({
        platform: 'linux',
        uid: 1000,
        exists: () => false,
        readFile: files({
          '/etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
          '/proc/1/cgroup': '0::/init.scope\n',
        }),
      }),
    ).toEqual({
      platform: 'linux',
      distro: 'Ubuntu 24.04.1 LTS',
      root: false,
      container: false,
      apparmorRestrictsUserns: true,
      usernsCloneDisabled: false,
      userNamespacesDisabled: false,
    });
  });

  it('Docker as root; older Debian with userns disabled', () => {
    const docker = inspectSandboxEnvironment({
      platform: 'linux',
      uid: 0,
      exists: (p) => p === '/.dockerenv',
      readFile: files({}),
    });
    expect(docker).toMatchObject({ root: true, container: true });
    const debian = inspectSandboxEnvironment({
      platform: 'linux',
      uid: 1000,
      exists: () => false,
      readFile: files({
        '/proc/sys/kernel/unprivileged_userns_clone': '0',
        '/proc/sys/user/max_user_namespaces': '0',
        '/proc/1/cgroup': '12:pids:/kubepods/pod1\n',
      }),
    });
    expect(debian).toMatchObject({
      usernsCloneDisabled: true,
      userNamespacesDisabled: true,
      container: true,
    });
  });

  it('macOS and Windows never read Linux files', () => {
    const read: string[] = [];
    for (const platform of ['darwin', 'win32']) {
      const env = inspectSandboxEnvironment({
        platform,
        uid: platform === 'win32' ? null : 501,
        exists: () => true,
        readFile: (p) => {
          read.push(p);
          return '1';
        },
      });
      expect(env).toMatchObject({ distro: null, container: false, apparmorRestrictsUserns: false });
    }
    expect(read).toEqual([]);
  });
});

describe('AppArmor', () => {
  const profiles = {
    platform: 'linux',
    listDir: () => ['chrome', 'msedge'],
    readFile: (path: string) =>
      path.endsWith('/chrome')
        ? 'profile chrome /opt/google/chrome/chrome flags=(unconfined) {\n  userns,\n}\n'
        : 'profile msedge /opt/microsoft/msedge/msedge flags=(unconfined) {}\n',
  };

  it('knows which paths a shipped profile covers', () => {
    expect(apparmorProfileCovers('/opt/google/chrome/chrome', profiles)).toBe(true);
    expect(
      apparmorProfileCovers('/home/u/.cache/ms-playwright/chromium-1243/chrome', profiles),
    ).toBe(false);
    expect(apparmorProfileCovers('/x', { ...profiles, platform: 'darwin' })).toBeNull();
    expect(apparmorProfileCovers('/x', { ...profiles, listDir: () => [] })).toBeNull();
  });

  it('prints a profile shaped like Ubuntu’s own Chrome profile', () => {
    const text = apparmorProfile(
      '/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    );
    expect(text).toContain('abi <abi/4.0>,\ninclude <tunables/global>\n');
    expect(text).toContain(
      'profile browserhive-chromium /home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome flags=(unconfined) {\n  userns,\n',
    );
    expect(text).toContain('include if exists <local/browserhive-chromium>');
    expect(text.endsWith('}\n')).toBe(true);
    expect(apparmorProfile('/opt/with space/chrome', 'p')).toContain(
      'profile p "/opt/with space/chrome" flags',
    );
  });
});

describe('probeSandbox', () => {
  function fakeBrowserType(outcomes: {
    readonly sandboxed: Error | null;
    readonly unsandboxed: Error | null;
  }) {
    const calls: LaunchOptions[] = [];
    return {
      calls,
      launch: async (options?: LaunchOptions): Promise<Browser> => {
        calls.push(options ?? {});
        const failure =
          options?.chromiumSandbox === true ? outcomes.sandboxed : outcomes.unsandboxed;
        if (failure !== null) throw failure;
        return {
          version: () => '154.0.8037.57',
          close: async () => undefined,
        } as unknown as Browser;
      },
    };
  }

  it('works: one headless launch with the sandbox forced on', async () => {
    const type = fakeBrowserType({ sandboxed: null, unsandboxed: null });
    expect(await probeSandbox(type, { playwrightChannel: 'chrome' })).toEqual({
      state: 'works',
      version: '154.0.8037.57',
    });
    expect(type.calls).toEqual([
      { headless: true, timeout: 30_000, channel: 'chrome', chromiumSandbox: true },
    ]);
  });

  it('unavailable only when the unsandboxed launch then works', async () => {
    const type = fakeBrowserType({ sandboxed: UBUNTU_ERROR, unsandboxed: null });
    expect(await probeSandbox(type, { playwrightChannel: 'chromium' })).toEqual({
      state: 'unavailable',
      reason: 'No usable sandbox!',
    });
    expect(type.calls.map((c) => c.chromiumSandbox)).toEqual([true, false]);
  });

  it('broken when the browser fails either way; not-installed for a missing binary', async () => {
    const broken = fakeBrowserType({
      sandboxed: new Error('crash one'),
      unsandboxed: new Error('crash two'),
    });
    expect(await probeSandbox(broken, { playwrightChannel: 'chromium' })).toEqual({
      state: 'broken',
      reason: 'crash two',
    });
    const missing = fakeBrowserType({
      sandboxed: new Error(
        "Chromium distribution 'msedge' is not found at /opt/microsoft/msedge/msedge",
      ),
      unsandboxed: null,
    });
    expect(await probeSandbox(missing, { playwrightChannel: 'msedge' })).toEqual({
      state: 'not-installed',
    });
    expect(missing.calls).toHaveLength(1);
  });

  it('an explicit binary replaces the channel', async () => {
    const type = fakeBrowserType({ sandboxed: null, unsandboxed: null });
    await probeSandbox(
      type,
      { playwrightChannel: 'chromium', executablePath: '/bin/chrome' },
      5_000,
    );
    expect(type.calls[0]).toEqual({
      headless: true,
      timeout: 5_000,
      executablePath: '/bin/chrome',
      chromiumSandbox: true,
    });
  });
});
