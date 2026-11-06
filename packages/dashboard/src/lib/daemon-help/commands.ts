/** @module lib/daemon-help/commands — the copyable help commands for an unreachable daemon (04 §18.6.3), shared by the offline page and the running dashboard's banner. Pure; relative imports only and no DOM global at module top level, so the root test can check every command word against the CLI registry. */
import type { DaemonState } from './probe.ts';

/** The daemon's default port: the start command adds `--port` only for another one. */
export const DEFAULT_DAEMON_PORT = 9876;

/** The operating systems the port-holder lines cover. */
export type HelpPlatform = 'linux' | 'macos' | 'windows';

/** Port-holder line order when the OS is unknown (and the order of the rest after the detected one). */
export const HELP_PLATFORMS: readonly HelpPlatform[] = ['linux', 'macos', 'windows'];

/** The members of `Location` the help reads (`window.location` satisfies it). */
export interface HelpLocation {
  /** `http:` or `https:`. */
  readonly protocol: string;
  /** IPv6 literals in brackets, as `Location` reports them (`[::1]`). */
  readonly hostname: string;
  /** Empty for the scheme's default port. */
  readonly port: string;
  /** `hostname[:port]`, shown to the operator. */
  readonly host: string;
}

/** Input of {@link daemonHelp}. */
export interface DaemonHelpInput {
  readonly location: HelpLocation;
  /** The visitor's OS from {@link detectPlatform}; `null` when unknown. */
  readonly platform: HelpPlatform | null;
  /** `bh.daemon.lastSeen.version`; `null` when absent or unreadable. */
  readonly lastSeenVersion: string | null;
}

/** Identifies a command (stable for tests and UI keys). */
export type HelpCommandId =
  | 'start'
  | 'start-bunx'
  | 'doctor'
  | 'config-show'
  | 'port-linux'
  | 'port-macos'
  | 'port-windows';

/** One copyable command. */
export interface HelpCommand {
  readonly id: HelpCommandId;
  /** What it is for, shown with the block (`Check the setup`). */
  readonly purpose: string;
  /** The OS label of a port-holder line (`Linux`, `macOS`, `Windows (PowerShell)`); `null` otherwise. */
  readonly label: string | null;
  /** The exact text copied. */
  readonly command: string;
}

/** Everything the help shows for one address. */
export interface DaemonHelp {
  /** `location.host`, rendered as text. */
  readonly host: string;
  /** `location.port`, or 80/443 by scheme when that is empty. */
  readonly port: number;
  /** `localhost`, `127.0.0.0/8` or `[::1]`. */
  readonly loopback: boolean;
  /** Shown above the commands for a non-loopback host; `null` for loopback. */
  readonly remoteNote: string | null;
  /** `browserhive --admin …`, then `bunx browserhive@<v> --admin …` (not on `PATH`). */
  readonly start: readonly [HelpCommand, HelpCommand];
  /** `browserhive doctor`. */
  readonly doctor: HelpCommand;
  /** `browserhive config show`. */
  readonly configShow: HelpCommand;
  /** Three labelled lines, the detected OS first; empty for a non-loopback host. */
  readonly portHolders: readonly HelpCommand[];
  /** Shown below the commands. */
  readonly footer: string;
}

/** The note above the commands for a non-loopback host. */
export const REMOTE_NOTE = 'Run these on the machine where BrowserHive runs.';

/** The line below the commands. */
export const HELP_FOOTER =
  'Started by an MCP client, a service manager or a container? Start it the way you usually do.';

const PORT_HOLDER_PURPOSE = 'See what holds the port';

/** A release version, so a tampered `lastSeen` never lands in a copyable command. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True for `localhost`, an address in `127.0.0.0/8` or `[::1]` (case and a trailing dot ignored). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets?.slice(1).every((octet) => Number(octet) <= 255) ?? false;
}

/** `location.port`, or 443 for `https:` and 80 otherwise when it is empty. */
export function effectivePort(location: Pick<HelpLocation, 'protocol' | 'port'>): number {
  if (location.port !== '') return Number(location.port);
  return location.protocol === 'https:' ? 443 : 80;
}

/** What the browser reports about its OS (`navigator.userAgentData?.platform`, `navigator.userAgent`). */
export interface PlatformHints {
  readonly uaPlatform?: string | undefined;
  readonly userAgent?: string | undefined;
}

function platformOfUaData(platform: string): HelpPlatform | null {
  const p = platform.toLowerCase();
  if (p === 'windows') return 'windows';
  if (p === 'macos') return 'macos';
  if (p === 'linux') return 'linux';
  return null;
}

function platformOfUserAgent(userAgent: string): HelpPlatform | null {
  if (/\b(iPhone|iPad|iPod|Android|CrOS)\b/.test(userAgent)) return null;
  if (/\bWindows\b/.test(userAgent)) return 'windows';
  if (/\bMacintosh\b|\bMac OS X\b/.test(userAgent)) return 'macos';
  if (/\bLinux\b|\bX11\b/.test(userAgent)) return 'linux';
  return null;
}

/**
 * The visitor's OS: `navigator.userAgentData?.platform` first, then the UA string; `null` when
 * neither names Linux, macOS or Windows (phones and tablets included: the daemon runs elsewhere).
 */
export function detectPlatform(hints: PlatformHints): HelpPlatform | null {
  const fromUaData =
    hints.uaPlatform === undefined || hints.uaPlatform === ''
      ? null
      : platformOfUaData(hints.uaPlatform);
  if (fromUaData !== null) return fromUaData;
  return hints.userAgent === undefined ? null : platformOfUserAgent(hints.userAgent);
}

function portHolder(platform: HelpPlatform, port: number): HelpCommand {
  switch (platform) {
    case 'linux':
      return {
        id: 'port-linux',
        purpose: PORT_HOLDER_PURPOSE,
        label: 'Linux',
        command: `ss -ltnp 'sport = :${port}'`,
      };
    case 'macos':
      return {
        id: 'port-macos',
        purpose: PORT_HOLDER_PURPOSE,
        label: 'macOS',
        command: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      };
    case 'windows':
      return {
        id: 'port-windows',
        purpose: PORT_HOLDER_PURPOSE,
        label: 'Windows (PowerShell)',
        command: `Get-NetTCPConnection -LocalPort ${port} -State Listen`,
      };
  }
}

/** The help for one address (04 §18.6.3, pure). */
export function daemonHelp(input: DaemonHelpInput): DaemonHelp {
  const { location } = input;
  const port = effectivePort(location);
  const loopback = isLoopbackHostname(location.hostname);
  const flags = loopback && port !== DEFAULT_DAEMON_PORT ? `--admin --port ${port}` : '--admin';
  const version =
    input.lastSeenVersion !== null && VERSION_RE.test(input.lastSeenVersion)
      ? input.lastSeenVersion
      : null;
  const order =
    input.platform === null
      ? HELP_PLATFORMS
      : [input.platform, ...HELP_PLATFORMS.filter((p) => p !== input.platform)];
  return {
    host: location.host,
    port,
    loopback,
    remoteNote: loopback ? null : REMOTE_NOTE,
    start: [
      {
        id: 'start',
        purpose: 'Start with the dashboard',
        label: null,
        command: `browserhive ${flags}`,
      },
      {
        id: 'start-bunx',
        purpose: 'Not on PATH',
        label: null,
        command: `bunx ${version === null ? 'browserhive' : `browserhive@${version}`} ${flags}`,
      },
    ],
    doctor: {
      id: 'doctor',
      purpose: 'Check the setup',
      label: null,
      command: 'browserhive doctor',
    },
    configShow: {
      id: 'config-show',
      purpose: 'See the settings in effect (port, host, data dir)',
      label: null,
      command: 'browserhive config show',
    },
    portHolders: loopback ? order.map((platform) => portHolder(platform, port)) : [],
    footer: HELP_FOOTER,
  };
}

/** The states that show help, plus the offline page's reload loop guard (04 §18.6.4). */
export type HelpState = DaemonState | 'loop-guard';

/**
 * The commands shown for a state (04 §18.6.3): all of them for `not-running`, `not-responding`,
 * `proxy-unreachable` and the loop guard; all but the start commands for `starting`; only
 * `config show` for `refused`; none otherwise.
 */
export function helpCommandsFor(help: DaemonHelp, state: HelpState): readonly HelpCommand[] {
  const all = [...help.start, help.doctor, help.configShow, ...help.portHolders];
  switch (state) {
    case 'not-running':
    case 'not-responding':
    case 'proxy-unreachable':
    case 'loop-guard':
      return all;
    case 'starting':
      return [help.doctor, help.configShow, ...help.portHolders];
    case 'refused':
      return [help.configShow];
    default:
      return [];
  }
}
