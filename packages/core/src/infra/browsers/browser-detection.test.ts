/** @module infra/browsers/browser-detection.test — detection per OS with fake filesystems, `--version` output and registries; Playwright's own lookup is pinned. */

import { describe, expect, it } from 'bun:test';
import { chromium } from 'playwright';
import {
  type BrowserDetectionDeps,
  type CommandOutput,
  channelExecutable,
  detectBrowsers,
  parseBrowserVersion,
  parseRegQuery,
  playwrightExecutable,
} from './browser-detection.ts';

interface FakeHost {
  readonly platform: string;
  readonly files?: Record<string, string>;
  readonly dirs?: Record<string, readonly string[]>;
  readonly located?: Partial<Record<'chrome' | 'msedge', string>>;
  readonly commands?: Record<string, CommandOutput>;
  readonly env?: Record<string, string>;
}

function fakeDeps(host: FakeHost): BrowserDetectionDeps & { readonly ran: string[] } {
  const ran: string[] = [];
  const files = host.files ?? {};
  return {
    ran,
    platform: host.platform,
    env: host.env ?? {},
    exists: (path) =>
      path in files ||
      Object.values(host.located ?? {}).includes(path) ||
      path in (host.dirs ?? {}),
    readFile: (path) => files[path] ?? null,
    listDir: (path) => host.dirs?.[path] ?? [],
    run: async (command, args) => {
      const key = [command, ...args].join(' ');
      ran.push(key);
      return host.commands?.[key] ?? { code: 1, stdout: '' };
    },
    locate: (name) => host.located?.[name] ?? null,
    bundled: { executablePath: '/cache/chromium-1243/chrome', version: '153.0.8010.12' },
  };
}

describe('detectBrowsers', () => {
  it('Linux: Chrome from Playwright’s lookup, version from --version, policies from /etc/opt', async () => {
    const deps = fakeDeps({
      platform: 'linux',
      located: { chrome: '/opt/google/chrome/chrome' },
      commands: {
        '/opt/google/chrome/chrome --version': {
          code: 0,
          stdout: 'Google Chrome 154.0.8037.57 \n',
        },
      },
      dirs: { '/etc/opt/chrome/policies/managed': ['corp.json', 'notes.txt'] },
      files: {
        '/etc/opt/chrome/policies/managed/corp.json': JSON.stringify({
          RemoteDebuggingAllowed: false,
          HomepageLocation: 'https://intranet',
        }),
      },
    });
    const [bundled, chrome, edge] = await detectBrowsers(deps);
    expect(bundled).toMatchObject({
      channel: 'chromium',
      label: 'Chrome for Testing',
      source: 'bundled',
      installed: true,
      version: '153.0.8010.12',
    });
    expect(chrome).toEqual({
      channel: 'chrome',
      label: 'Google Chrome',
      source: 'installed',
      installed: true,
      executablePath: '/opt/google/chrome/chrome',
      version: '154.0.8037.57',
      policies: {
        location: '/etc/opt/chrome/policies/managed',
        names: ['HomepageLocation', 'RemoteDebuggingAllowed'],
        blocking: ['RemoteDebuggingAllowed=false'],
      },
    });
    expect(edge).toMatchObject({ channel: 'edge', installed: false, executablePath: null });
    // Nothing is run for a browser that is not installed.
    expect(deps.ran).toEqual(['/opt/google/chrome/chrome --version']);
  });

  it('Windows: version from the version-named directory, policies from reg query (HKLM and HKCU)', async () => {
    const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const deps = fakeDeps({
      platform: 'win32',
      located: { chrome: exe },
      dirs: {
        'C:\\Program Files\\Google\\Chrome\\Application': [
          '153.0.8010.99',
          '154.0.8037.57',
          'chrome.exe',
          'SetupMetrics',
        ],
      },
      commands: {
        'reg query HKLM\\SOFTWARE\\Policies\\Google\\Chrome': {
          code: 0,
          stdout:
            '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\r\n    RemoteDebuggingAllowed    REG_DWORD    0x0\r\n    HomepageLocation    REG_SZ    https://intranet\r\n',
        },
      },
    });
    const [, chrome] = await detectBrowsers(deps);
    expect(chrome?.version).toBe('154.0.8037.57');
    expect(chrome?.policies).toEqual({
      location: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
      names: ['HomepageLocation', 'RemoteDebuggingAllowed'],
      blocking: ['RemoteDebuggingAllowed=false'],
    });
    expect(deps.ran).toContain('reg query HKCU\\SOFTWARE\\Policies\\Google\\Chrome');
    expect(deps.ran.some((c) => c.includes('--version'))).toBe(false);
  });

  it('macOS: managed preferences are read through plutil, machine-wide and per user', async () => {
    const plist = '/Library/Managed Preferences/me/com.microsoft.Edge.plist';
    const deps = fakeDeps({
      platform: 'darwin',
      env: { USER: 'me' },
      located: { msedge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      files: { [plist]: 'binary plist' },
      commands: {
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --version': {
          code: 0,
          stdout: 'Microsoft Edge 152.0.4191.66',
        },
        [`plutil -convert json -o - ${plist}`]: {
          code: 0,
          stdout: '{"ExtensionInstallForcelist":["abc"]}',
        },
      },
    });
    const [, , edge] = await detectBrowsers(deps);
    expect(edge).toMatchObject({
      installed: true,
      version: '152.0.4191.66',
      policies: { location: plist, names: ['ExtensionInstallForcelist'], blocking: [] },
    });
  });

  it('a path Playwright names but that is gone counts as not installed', async () => {
    const deps = fakeDeps({ platform: 'linux' });
    const [, chrome] = await detectBrowsers({
      ...deps,
      locate: () => '/opt/google/chrome/chrome',
      exists: () => false,
    });
    expect(chrome?.installed).toBe(false);
  });
});

describe('helpers', () => {
  it('parseBrowserVersion finds a four-part version', () => {
    expect(parseBrowserVersion('Google Chrome 154.0.8037.57 unknown')).toBe('154.0.8037.57');
    expect(parseBrowserVersion('Chromium 153')).toBeNull();
  });

  it('parseRegQuery reads DWORDs as numbers and strings verbatim', () => {
    expect(
      parseRegQuery('HKEY\r\n    A    REG_DWORD    0x1\r\n    B    REG_SZ    x y\r\n'),
    ).toEqual({ A: 1, B: 'x y' });
  });

  it('channelExecutable maps channels to the bundled path and Playwright’s lookup', () => {
    const locate = (name: 'chrome' | 'msedge') => `/${name}`;
    expect(channelExecutable('chromium', () => '/bundled', locate)).toBe('/bundled');
    expect(channelExecutable('chrome', () => null, locate)).toBe('/chrome');
    expect(channelExecutable('edge', () => null, locate)).toBe('/msedge');
  });

  it('Playwright’s internal executable lookup still exists in the pinned playwright-core', () => {
    // If a Playwright bump moves `registry.findExecutable`, detection would silently find nothing;
    // this pins the entry point against the bundled browser, which the stock API also reports.
    expect(playwrightExecutable('chromium')).toBe(chromium.executablePath());
  });
});
