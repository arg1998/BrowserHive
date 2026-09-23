/** @module composition/host — the ONE place process facts are read: `buildHostEnvironment` (the `ports/host-environment.ts` shape) and the browser adapter's `HostFacts` slice. */

import { readFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { posix } from 'node:path';
import type { HostEnvironment } from '@browserhive/core/runtime';
import { LOG_MODULES } from '@browserhive/core/runtime';

export { LOG_MODULES };

/** Process facts `buildHostEnvironment` reads; every field defaults to the running process. */
export interface ProcessFacts {
  /** Environment variables (default `process.env`); `{}` isolates a programmatic server. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly arch?: string;
  /** `os.release()` (kernel / Darwin / Windows build). */
  readonly release?: string;
  readonly homeDir?: string;
  readonly tmpDir?: string;
  /**
   * Memory this process may use, in bytes: host RAM capped by any cgroup limit
   * ({@link effectiveMemoryBytes}). `createServer({ hostMemory })` overrides it for tests.
   */
  readonly totalMemoryBytes?: number;
  readonly cpuCount?: number;
  readonly isTty?: { readonly stdout: boolean; readonly stderr: boolean };
}

/** The browser adapter's slice of the host (`infra/browsers/host-facts.ts`). */
export type HostFacts = Pick<HostEnvironment, 'platform' | 'arch' | 'release' | 'env'>;

/**
 * Builds the injected {@link HostEnvironment}. Below the composition root nothing reads
 * `process.env` or `node:os`; this builder is the only place that does.
 * The env record is a frozen copy, so later mutations of `process.env` never leak in.
 */
export function buildHostEnvironment(proc: ProcessFacts = {}): HostEnvironment {
  const env = proc.env ?? processEnv();
  return Object.freeze({
    platform: proc.platform ?? platform(),
    arch: proc.arch ?? arch(),
    release: proc.release ?? release(),
    homeDir: proc.homeDir ?? homedir(),
    tmpDir: proc.tmpDir ?? tmpdir(),
    totalMemoryBytes: proc.totalMemoryBytes ?? effectiveMemoryBytes(totalmem()),
    cpuCount: proc.cpuCount ?? Math.max(1, cpus().length),
    isTty: Object.freeze({
      stdout: proc.isTty?.stdout ?? process.stdout.isTTY === true,
      stderr: proc.isTty?.stderr ?? process.stderr.isTTY === true,
    }),
    env: Object.freeze({ ...env }),
  });
}

/** The running process's environment (the default env layer of the CLI and `createServer`). */
export function processEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** Maps the host record onto the `HostFacts` the Playwright driver and the geo seed resolver read. */
export function hostFactsOf(host: HostEnvironment): HostFacts {
  return { platform: host.platform, arch: host.arch, release: host.release, env: host.env };
}

/** Reads a text file, `undefined` when it does not exist or cannot be read. */
export type ReadText = (path: string) => string | undefined;

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const CGROUP_ROOT = '/sys/fs/cgroup';

/** A cgroup limit file's value in bytes, or `undefined` for `max`, absent or unparsable. */
function limitOf(text: string | undefined): number | undefined {
  const value = Number(text?.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Every memory limit on `start` and its ancestors up to `root`: a limit set on a parent slice caps
 * every cgroup below it, so the effective cap is the smallest one on the way up.
 */
function limitsUpFrom(root: string, start: string, file: string, read: ReadText): number[] {
  const limits: number[] = [];
  let dir = posix.join(root, start);
  for (;;) {
    const limit = limitOf(read(posix.join(dir, file)));
    if (limit !== undefined) limits.push(limit);
    if (dir === root || !dir.startsWith(`${root}/`)) return limits;
    dir = posix.dirname(dir);
  }
}

/**
 * The memory this process may actually use: host RAM, capped by the memory limit of the process's
 * cgroup or any ancestor (v2 `memory.max`, v1 `memory.limit_in_bytes`). Without the cap a container
 * or a systemd `MemoryMax=` slice would derive `maxSessions` from RAM it can never get (spec 08
 * §6). Linux only; every other platform, and any unreadable cgroup file, yields host RAM.
 */
export function effectiveMemoryBytes(
  hostBytes: number,
  read: ReadText = readTextOrUndefined,
  os: string = platform(),
): number {
  if (os !== 'linux') return hostBytes;
  const limits: number[] = [];
  for (const line of (read('/proc/self/cgroup') ?? '').split('\n')) {
    const [, controllers, path] = /^\d+:([^:]*):(\/.*)$/.exec(line.trim()) ?? [];
    if (path === undefined) continue;
    if (controllers === '') {
      limits.push(...limitsUpFrom(CGROUP_ROOT, path, 'memory.max', read));
    } else if (controllers?.split(',').includes('memory')) {
      const root = posix.join(CGROUP_ROOT, 'memory');
      limits.push(...limitsUpFrom(root, path, 'memory.limit_in_bytes', read));
    }
  }
  return Math.min(hostBytes, ...limits);
}
