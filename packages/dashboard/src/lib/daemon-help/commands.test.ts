/** @module lib/daemon-help/commands.test — `daemonHelp` port and loopback rules, `bunx` with and without the last-seen version, the OS order, OS detection, and the commands per state (04 §18.6.3) */
import { describe, expect, it } from 'bun:test';
import {
  type DaemonHelp,
  daemonHelp,
  detectPlatform,
  effectivePort,
  HELP_FOOTER,
  type HelpCommandId,
  type HelpLocation,
  type HelpPlatform,
  helpCommandsFor,
  isLoopbackHostname,
  REMOTE_NOTE,
} from './commands.ts';

function at(url: string): HelpLocation {
  const { protocol, hostname, port, host } = new URL(url);
  return { protocol, hostname, port, host };
}

function help(
  url: string,
  options: { platform?: HelpPlatform | null; lastSeenVersion?: string | null } = {},
): DaemonHelp {
  return daemonHelp({
    location: at(url),
    platform: options.platform ?? null,
    lastSeenVersion: options.lastSeenVersion ?? null,
  });
}

const commands = (h: DaemonHelp) => helpCommandsFor(h, 'not-running').map((c) => c.command);

describe('daemonHelp: port rules', () => {
  it('the default port adds no --port', () => {
    const h = help('http://127.0.0.1:9876/sessions');
    expect(h.port).toBe(9876);
    expect(h.start[0].command).toBe('browserhive --admin');
    expect(h.start[1].command).toBe('bunx browserhive --admin');
  });

  it('another port is passed on loopback', () => {
    const h = help('http://127.0.0.1:8080/');
    expect(h.start[0].command).toBe('browserhive --admin --port 8080');
    expect(h.start[1].command).toBe('bunx browserhive --admin --port 8080');
    expect(h.portHolders.map((c) => c.command)).toEqual([
      "ss -ltnp 'sport = :8080'",
      'lsof -nP -iTCP:8080 -sTCP:LISTEN',
      'Get-NetTCPConnection -LocalPort 8080 -State Listen',
    ]);
  });

  it('an empty port is 80 or 443 by scheme', () => {
    expect(effectivePort({ protocol: 'http:', port: '' })).toBe(80);
    expect(effectivePort({ protocol: 'https:', port: '' })).toBe(443);
    expect(help('http://localhost/').start[0].command).toBe('browserhive --admin --port 80');
    const https = help('https://localhost/');
    expect(https.port).toBe(443);
    expect(https.start[0].command).toBe('browserhive --admin --port 443');
    expect(https.portHolders[0]?.command).toBe("ss -ltnp 'sport = :443'");
  });
});

describe('daemonHelp: loopback vs remote', () => {
  it.each(['http://localhost:8080/', 'http://127.0.0.5:8080/', 'http://[::1]:8080/'])(
    '%s is loopback: --port and three port-holder lines, no remote note',
    (url) => {
      const h = help(url);
      expect(h.loopback).toBe(true);
      expect(h.remoteNote).toBeNull();
      expect(h.start[0].command).toBe('browserhive --admin --port 8080');
      expect(h.portHolders).toHaveLength(3);
    },
  );

  it.each([
    'https://hive.example.com/',
    'http://192.168.1.20:8080/',
    'http://128.0.0.1:8080/',
    'http://[::2]:8080/',
  ])('%s is remote: no --port, no port-holder lines, the remote note', (url) => {
    const h = help(url);
    expect(h.loopback).toBe(false);
    expect(h.remoteNote).toBe(REMOTE_NOTE);
    expect(h.start[0].command).toBe('browserhive --admin');
    expect(h.start[1].command).toBe('bunx browserhive --admin');
    expect(h.portHolders).toEqual([]);
    expect(commands(h)).toEqual([
      'browserhive --admin',
      'bunx browserhive --admin',
      'browserhive doctor',
      'browserhive config show',
    ]);
  });

  it('isLoopbackHostname covers 127.0.0.0/8 only, any case, a trailing dot', () => {
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
    expect(isLoopbackHostname('localhost.')).toBe(true);
    expect(isLoopbackHostname('127.255.255.254')).toBe(true);
    expect(isLoopbackHostname('127.0.0.256')).toBe(false);
    expect(isLoopbackHostname('127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackHostname('localhost.example.com')).toBe(false);
  });

  it('keeps the host as text and carries the footer', () => {
    const h = help('http://127.0.0.1:9876/');
    expect(h.host).toBe('127.0.0.1:9876');
    expect(h.footer).toBe(HELP_FOOTER);
  });
});

describe('daemonHelp: bunx and the last-seen version', () => {
  it('pins the last-seen version', () => {
    const h = help('http://127.0.0.1:8080/', { lastSeenVersion: '0.2.2' });
    expect(h.start[1].command).toBe('bunx browserhive@0.2.2 --admin --port 8080');
    expect(help('http://127.0.0.1:9876/', { lastSeenVersion: '1.0.0-rc.1' }).start[1].command).toBe(
      'bunx browserhive@1.0.0-rc.1 --admin',
    );
  });

  it('falls back to plain bunx browserhive when unknown or not a version', () => {
    expect(help('http://127.0.0.1:9876/').start[1].command).toBe('bunx browserhive --admin');
    expect(
      help('http://127.0.0.1:9876/', { lastSeenVersion: '1.0.0; rm -rf ~' }).start[1].command,
    ).toBe('bunx browserhive --admin');
  });
});

describe('daemonHelp: the OS order', () => {
  const labels = (platform: HelpPlatform | null) =>
    help('http://127.0.0.1:9876/', { platform }).portHolders.map((c) => c.label);

  it('Linux, macOS, Windows when unknown', () => {
    expect(labels(null)).toEqual(['Linux', 'macOS', 'Windows (PowerShell)']);
  });

  it('the detected OS first, the rest in order', () => {
    expect(labels('linux')).toEqual(['Linux', 'macOS', 'Windows (PowerShell)']);
    expect(labels('macos')).toEqual(['macOS', 'Linux', 'Windows (PowerShell)']);
    expect(labels('windows')).toEqual(['Windows (PowerShell)', 'Linux', 'macOS']);
  });
});

describe('detectPlatform', () => {
  const ua = {
    chromeWindows:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    safariMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
    chromeAndroid:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    iphone:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };

  it('prefers userAgentData.platform', () => {
    expect(detectPlatform({ uaPlatform: 'macOS', userAgent: ua.chromeWindows })).toBe('macos');
    expect(detectPlatform({ uaPlatform: 'Windows' })).toBe('windows');
    expect(detectPlatform({ uaPlatform: 'Linux' })).toBe('linux');
  });

  it('falls back to the UA string when userAgentData is absent, empty or unknown', () => {
    expect(detectPlatform({ userAgent: ua.chromeWindows })).toBe('windows');
    expect(detectPlatform({ uaPlatform: '', userAgent: ua.safariMac })).toBe('macos');
    expect(detectPlatform({ uaPlatform: 'Chrome OS', userAgent: ua.firefoxLinux })).toBe('linux');
  });

  it('is null for phones and when nothing says', () => {
    expect(detectPlatform({ uaPlatform: 'Android', userAgent: ua.chromeAndroid })).toBeNull();
    expect(detectPlatform({ userAgent: ua.iphone })).toBeNull();
    expect(detectPlatform({})).toBeNull();
  });
});

describe('helpCommandsFor (which commands each state shows)', () => {
  const h = help('http://127.0.0.1:8080/', { platform: 'linux', lastSeenVersion: '0.2.2' });
  const ids = (state: Parameters<typeof helpCommandsFor>[1]) =>
    helpCommandsFor(h, state).map((c) => c.id);
  const all: HelpCommandId[] = [
    'start',
    'start-bunx',
    'doctor',
    'config-show',
    'port-linux',
    'port-macos',
    'port-windows',
  ];

  it.each(['not-running', 'not-responding', 'proxy-unreachable', 'loop-guard'] as const)(
    '%s shows every command',
    (state) => {
      expect(ids(state)).toEqual(all);
    },
  );

  it('starting omits the start commands; refused shows only config show', () => {
    expect(ids('starting')).toEqual(all.slice(2));
    expect(ids('refused')).toEqual(['config-show']);
  });

  it.each(['checking', 'ready', 'device-offline', 'foreign'] as const)('%s shows none', (state) => {
    expect(ids(state)).toEqual([]);
  });
});
