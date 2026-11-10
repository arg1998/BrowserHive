/** @module infra/host/stale-template-browsers — at daemon start, before any template host starts: terminate Chromium processes left by a killed daemon on a template profile (they hold `SingletonLock`), and remove locks whose process is gone (spec 13 §3.1 "Stale processes"). */

import { execFile } from 'node:child_process';
import { readdir, readlink, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** One process: its pid and full command line. */
export interface ProcessCommand {
  readonly pid: number;
  readonly command: string;
}

/** What the sweep needs from the platform (test seam). */
export interface StaleSweepDeps {
  /** Every process with its command line; `[]` when the table cannot be read. */
  readonly listProcesses: () => Promise<readonly ProcessCommand[]>;
  /** Sends SIGKILL; a failure (already gone, not ours) is ignored. */
  readonly kill: (pid: number) => void;
  /** True while `pid` exists. */
  readonly alive: (pid: number) => boolean;
  readonly host: string;
}

/**
 * Pids whose command line names a `--user-data-dir` inside `templatesDir` (pure). The directory
 * is compared as a path prefix with a separator, so `templates-old/` never matches `templates/`.
 */
export function staleTemplatePids(
  processes: readonly ProcessCommand[],
  templatesDir: string,
  self: number,
): number[] {
  const root = resolve(templatesDir) + sep;
  const pids: number[] = [];
  for (const { pid, command } of processes) {
    if (pid === self) continue;
    const match = /--user-data-dir=("[^"]+"|\S+)/.exec(command);
    const dir = match?.[1]?.replace(/^"|"$/g, '');
    if (dir !== undefined && (resolve(dir) + sep).startsWith(root)) pids.push(pid);
  }
  return pids;
}

/**
 * Terminates stale template browsers and removes dead `SingletonLock`s (`<host>-<pid>` symlinks).
 * Returns the pids it terminated. Never throws.
 */
export async function sweepStaleTemplateBrowsers(
  templatesDir: string,
  deps: StaleSweepDeps = platformSweepDeps(),
): Promise<readonly number[]> {
  const pids = staleTemplatePids(
    await deps.listProcesses().catch(() => []),
    templatesDir,
    process.pid,
  );
  for (const pid of pids) deps.kill(pid);
  let ids: string[] = [];
  try {
    ids = await readdir(templatesDir);
  } catch {
    return pids;
  }
  for (const id of ids) {
    const lock = join(templatesDir, id, 'userdata', 'SingletonLock');
    let target: string;
    try {
      target = await readlink(lock);
    } catch {
      continue;
    }
    const dash = target.lastIndexOf('-');
    const owner = target.slice(0, dash);
    const pid = Number(target.slice(dash + 1));
    // Another machine's lock (a shared data dir) is not ours to judge.
    if (owner !== deps.host || !Number.isInteger(pid)) continue;
    if (deps.alive(pid) && !pids.includes(pid)) continue;
    await rm(lock, { force: true }).catch(() => undefined);
  }
  return pids;
}

/** The sweep on this machine: `ps` on Linux and macOS, `Win32_Process` on Windows. */
export function platformSweepDeps(platform: NodeJS.Platform = process.platform): StaleSweepDeps {
  return {
    listProcesses: () => (platform === 'win32' ? windowsProcesses() : psProcesses()),
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, or not ours.
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    host: hostname(),
  };
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile(file, [...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err === null ? resolveOut(stdout) : reject(err),
    );
  });
}

async function psProcesses(): Promise<readonly ProcessCommand[]> {
  const out = await run('ps', ['-axww', '-o', 'pid=,command=']);
  const rows: ProcessCommand[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      rows.push({ pid: Number(match[1]), command: match[2] });
    }
  }
  return rows;
}

async function windowsProcesses(): Promise<readonly ProcessCommand[]> {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const rows: ProcessCommand[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [pid, command] = line.split('\t');
    if (pid !== undefined && command !== undefined && /^\d+$/.test(pid.trim())) {
      rows.push({ pid: Number(pid.trim()), command });
    }
  }
  return rows;
}
