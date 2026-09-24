/** @module infra/browsers/browser-detection — finds the bundled Chromium and the installed Google Chrome / Microsoft Edge the way Playwright's own launcher does, with their versions and any managed policies that block automation (plan Phase 1). */

import { createRequire } from 'node:module';
import { join, win32 } from 'node:path';
import type { Channel } from '@browserhive/contracts/enums';
import { z } from 'zod';

/** Where a channel's browser comes from. */
export type BrowserSource = 'bundled' | 'installed';

/** Managed (enterprise) policies read for one browser. */
export interface ManagedPolicies {
  /** Where they were read (`/etc/opt/chrome/policies/managed`, a plist, a registry key), or null when none apply. */
  readonly location: string | null;
  /** Names of the policies that are set. */
  readonly names: readonly string[];
  /** Policies that stop BrowserHive from driving the browser (`RemoteDebuggingAllowed=false`). */
  readonly blocking: readonly string[];
}

/** One channel as found on this host. */
export interface DetectedBrowser {
  readonly channel: Channel;
  /** Product name: `Chrome for Testing`, `Google Chrome` or `Microsoft Edge`. */
  readonly label: string;
  readonly source: BrowserSource;
  readonly installed: boolean;
  /** The binary Playwright launches for this channel, or null when there is none. */
  readonly executablePath: string | null;
  /** Full version (`154.0.8037.57`), or null when unknown. */
  readonly version: string | null;
  readonly policies: ManagedPolicies;
}

/** Result of running a helper command (`chrome --version`, `reg query`, `plutil`). */
export interface CommandOutput {
  readonly code: number | null;
  readonly stdout: string;
}

/** Host access for {@link detectBrowsers}; tests pass fake filesystems and registries. */
export interface BrowserDetectionDeps {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string | null;
  readonly listDir: (path: string) => readonly string[];
  readonly run: (command: string, args: readonly string[]) => Promise<CommandOutput>;
  /** Playwright's executable lookup for a branded channel; defaults to {@link playwrightChannelExecutable}. */
  readonly locate?: (playwrightChannel: 'chrome' | 'msedge') => string | null;
  /** The bundled Chromium: its executable (when present on disk) and pinned version. */
  readonly bundled: { readonly executablePath: string | null; readonly version: string | null };
}

const EMPTY_POLICIES: ManagedPolicies = { location: null, names: [], blocking: [] };

/** Product names per channel. */
export const CHANNEL_LABEL: Readonly<Record<Channel, string>> = {
  chromium: 'Chrome for Testing',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
};

/** Reads `value[key]` of an object (own or inherited), or undefined. */
function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Playwright's own lookup for `chrome` / `msedge` (`registry.findExecutable(name).executablePath()`
 * in the pinned `playwright-core`), so detection and launch can never disagree about which binary a
 * channel means. A unit test pins that this internal entry point still exists, so a Playwright bump
 * that moves it fails loudly instead of silently falling back.
 *
 * @returns The executable path, or null when the browser is not installed (or the lookup is unavailable).
 */
export function playwrightChannelExecutable(playwrightChannel: 'chrome' | 'msedge'): string | null {
  return playwrightExecutable(playwrightChannel);
}

/**
 * `registry.findExecutable(name).executablePath()` of the pinned `playwright-core`, for any
 * Playwright browser name (`chromium`, `chrome`, `msedge`, …). Never throws.
 *
 * @returns The path, or null when that browser is absent or the registry cannot be read.
 */
export function playwrightExecutable(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    // Class instances with prototype methods: checked by hand, since a schema parse would copy
    // them into plain objects and drop the methods.
    const registry = member(
      member(require('playwright-core/lib/coreBundle'), 'registry'),
      'registry',
    );
    const find = member(registry, 'findExecutable');
    if (typeof find !== 'function') return null;
    const entry: unknown = find.call(registry, name);
    const executablePath = member(entry, 'executablePath');
    if (typeof executablePath !== 'function') return null;
    const path: unknown = executablePath.call(entry);
    return typeof path === 'string' && path !== '' ? path : null;
  } catch {
    return null;
  }
}

/** A full four-part Chromium version out of any text (`Google Chrome 154.0.8037.57`). */
export function parseBrowserVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

function compareDotted(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The installed version of a branded browser. Windows builds do not print `--version` (they are GUI
 * programs), so there the newest version-named directory next to the executable is used, which is
 * how Chrome and Edge lay out their installs; elsewhere `<binary> --version`.
 */
async function installedVersion(
  executablePath: string,
  deps: BrowserDetectionDeps,
): Promise<string | null> {
  if (deps.platform === 'win32') {
    const versions = deps
      .listDir(win32.dirname(executablePath))
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort(compareDotted);
    return versions.at(-1) ?? null;
  }
  try {
    const out = await deps.run(executablePath, ['--version']);
    return out.code === 0 ? parseBrowserVersion(out.stdout) : null;
  } catch {
    return null;
  }
}

/** Policies that stop Playwright from driving the browser at all, by name and the blocking value. */
const BLOCKING: Readonly<Record<string, (value: unknown) => boolean>> = {
  // Playwright drives the browser over the DevTools protocol (`--remote-debugging-pipe`).
  RemoteDebuggingAllowed: (value) => value === false || value === 0 || value === '0x0',
};

function policiesFrom(
  location: string,
  entries: Readonly<Record<string, unknown>>,
): ManagedPolicies {
  const names = Object.keys(entries).sort();
  const blocking = names
    .filter((name) => BLOCKING[name]?.(entries[name]) === true)
    .map((name) => `${name}=false`);
  return names.length === 0 ? EMPTY_POLICIES : { location, names, blocking };
}

function mergePolicies(list: readonly ManagedPolicies[]): ManagedPolicies {
  const present = list.filter((p) => p.location !== null);
  if (present.length === 0) return EMPTY_POLICIES;
  return {
    location: present.map((p) => p.location).join(', '),
    names: [...new Set(present.flatMap((p) => p.names))].sort(),
    blocking: [...new Set(present.flatMap((p) => p.blocking))].sort(),
  };
}

const JsonObject = z.record(z.string(), z.unknown());

/** Linux: every `*.json` in the browser's managed-policy directory. */
function linuxPolicies(dir: string, deps: BrowserDetectionDeps): ManagedPolicies {
  const entries: Record<string, unknown> = {};
  let found = false;
  for (const name of deps.listDir(dir)) {
    if (!name.endsWith('.json')) continue;
    const text = deps.readFile(join(dir, name));
    if (text === null) continue;
    try {
      const parsed = JsonObject.safeParse(JSON.parse(text));
      if (!parsed.success) continue;
      Object.assign(entries, parsed.data);
      found = true;
    } catch {
      // An unreadable policy file is ignored here; the browser reports it itself.
    }
  }
  return found ? policiesFrom(dir, entries) : EMPTY_POLICIES;
}

/** macOS: the managed preference plists (machine-wide and per user), read through `plutil`. */
async function macPolicies(domain: string, deps: BrowserDetectionDeps): Promise<ManagedPolicies> {
  const user = deps.env['USER'];
  const candidates = [
    `/Library/Managed Preferences/${domain}.plist`,
    ...(user === undefined ? [] : [`/Library/Managed Preferences/${user}/${domain}.plist`]),
  ];
  const found: ManagedPolicies[] = [];
  for (const path of candidates) {
    if (!deps.exists(path)) continue;
    try {
      const out = await deps.run('plutil', ['-convert', 'json', '-o', '-', path]);
      if (out.code !== 0) continue;
      const parsed = JsonObject.safeParse(JSON.parse(out.stdout));
      if (parsed.success) found.push(policiesFrom(path, parsed.data));
    } catch {
      // `plutil` missing or unparsable output: nothing to report.
    }
  }
  return mergePolicies(found);
}

/** Parses `reg query` output: `    Name    REG_DWORD    0x0`. */
export function parseRegQuery(stdout: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_\w+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, name, type, raw] = match;
    if (name === undefined || type === undefined) continue;
    const value = (raw ?? '').trim();
    entries[name] = type === 'REG_DWORD' ? Number.parseInt(value, 16) : value;
  }
  return entries;
}

/** Windows: the machine and user policy keys, read through `reg query`. */
async function windowsPolicies(key: string, deps: BrowserDetectionDeps): Promise<ManagedPolicies> {
  const found: ManagedPolicies[] = [];
  for (const hive of ['HKLM', 'HKCU']) {
    const path = `${hive}\\${key}`;
    try {
      const out = await deps.run('reg', ['query', path]);
      if (out.code !== 0) continue;
      found.push(policiesFrom(path, parseRegQuery(out.stdout)));
    } catch {
      // `reg` unavailable: nothing to report.
    }
  }
  return mergePolicies(found);
}

const POLICY_LOCATIONS: Readonly<
  Record<'chrome' | 'edge', { linux: string; darwin: string; win32: string }>
> = {
  chrome: {
    linux: '/etc/opt/chrome/policies/managed',
    darwin: 'com.google.Chrome',
    win32: 'SOFTWARE\\Policies\\Google\\Chrome',
  },
  edge: {
    linux: '/etc/opt/edge/policies/managed',
    darwin: 'com.microsoft.Edge',
    win32: 'SOFTWARE\\Policies\\Microsoft\\Edge',
  },
};

/** Managed policies for a branded channel on this OS. */
export async function managedPolicies(
  channel: 'chrome' | 'edge',
  deps: BrowserDetectionDeps,
): Promise<ManagedPolicies> {
  const where = POLICY_LOCATIONS[channel];
  switch (deps.platform) {
    case 'linux':
      return linuxPolicies(where.linux, deps);
    case 'darwin':
      return macPolicies(where.darwin, deps);
    case 'win32':
      return windowsPolicies(where.win32, deps);
    default:
      return EMPTY_POLICIES;
  }
}

async function detectBranded(
  channel: 'chrome' | 'edge',
  deps: BrowserDetectionDeps,
): Promise<DetectedBrowser> {
  const locate = deps.locate ?? playwrightChannelExecutable;
  const found = locate(channel === 'edge' ? 'msedge' : 'chrome');
  const executablePath = found !== null && deps.exists(found) ? found : null;
  const [version, policies] = await Promise.all([
    executablePath === null ? Promise.resolve(null) : installedVersion(executablePath, deps),
    executablePath === null ? Promise.resolve(EMPTY_POLICIES) : managedPolicies(channel, deps),
  ]);
  return {
    channel,
    label: CHANNEL_LABEL[channel],
    source: 'installed',
    installed: executablePath !== null,
    executablePath,
    version,
    policies,
  };
}

/**
 * Every channel as found on this host: the bundled Chromium (always first) and the installed Google
 * Chrome and Microsoft Edge.
 *
 * @returns One entry per channel, in `chromium`, `chrome`, `edge` order.
 */
export async function detectBrowsers(deps: BrowserDetectionDeps): Promise<DetectedBrowser[]> {
  const bundled: DetectedBrowser = {
    channel: 'chromium',
    label: CHANNEL_LABEL.chromium,
    source: 'bundled',
    installed: deps.bundled.executablePath !== null,
    executablePath: deps.bundled.executablePath,
    version: deps.bundled.version,
    policies: EMPTY_POLICIES,
  };
  const [chrome, edge] = await Promise.all([
    detectBranded('chrome', deps),
    detectBranded('edge', deps),
  ]);
  return [bundled, chrome, edge];
}

/**
 * The executable a channel launches on this host, from the same lookups as {@link detectBrowsers}
 * but without running anything (used as the sandbox cache key).
 *
 * @returns The path, or null when the channel's browser is not installed.
 */
export function channelExecutable(
  channel: Channel,
  bundledPath: () => string | null,
  locate: (playwrightChannel: 'chrome' | 'msedge') => string | null = playwrightChannelExecutable,
): string | null {
  switch (channel) {
    case 'chromium':
      return bundledPath();
    case 'chrome':
      return locate('chrome');
    case 'edge':
      return locate('msedge');
  }
}
