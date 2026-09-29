/** @module infra/host/process-tree — resident memory of process trees (a browser and every descendant), read from `/proc` on Linux and `ps` on macOS (spec 10 §7 `browserhive.browser.rss_bytes`). */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

/** One process of the host's table. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
}

/** Reads the RSS of whole process trees. */
export interface ProcessTreeReader {
  /**
   * Sums the RSS of each root and all its descendants. Roots that no longer exist are absent from
   * the result. Never rejects: an unreadable table yields an empty map.
   */
  rssOfTrees(roots: readonly number[]): Promise<ReadonlyMap<number, number>>;
}

/** Sums each root's tree over a process table (pure). */
export function sumProcessTrees(
  table: readonly ProcessEntry[],
  roots: readonly number[],
): Map<number, number> {
  const children = new Map<number, ProcessEntry[]>();
  const byPid = new Map<number, ProcessEntry>();
  for (const entry of table) {
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const sums = new Map<number, number>();
  for (const root of roots) {
    const top = byPid.get(root);
    if (top === undefined) continue;
    let total = 0;
    const seen = new Set<number>();
    const stack: ProcessEntry[] = [top];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next.pid)) continue;
      seen.add(next.pid);
      total += next.rssBytes;
      for (const child of children.get(next.pid) ?? []) stack.push(child);
    }
    sums.set(root, total);
  }
  return sums;
}

/** Parses `/proc/<pid>/status` into the parent pid and `VmRSS` (kernel threads have none: 0). */
export function parseProcStatus(pid: number, text: string): ProcessEntry | null {
  const ppid = /^PPid:\s+(\d+)/m.exec(text)?.[1];
  if (ppid === undefined) return null;
  const rssKb = /^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1];
  return { pid, ppid: Number(ppid), rssBytes: rssKb === undefined ? 0 : Number(rssKb) * 1024 };
}

/** Parses `ps -A -o pid=,ppid=,rss=` output (RSS in KiB). */
export function parsePsTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const [pid, ppid, rss] = line.trim().split(/\s+/);
    if (pid === undefined || ppid === undefined || rss === undefined) continue;
    const entry = { pid: Number(pid), ppid: Number(ppid), rssBytes: Number(rss) * 1024 };
    if (
      Number.isFinite(entry.pid) &&
      Number.isFinite(entry.ppid) &&
      Number.isFinite(entry.rssBytes)
    )
      entries.push(entry);
  }
  return entries;
}

async function linuxTable(): Promise<ProcessEntry[]> {
  const names = await readdir('/proc');
  const reads = names
    .filter((name) => /^\d+$/.test(name))
    .map(async (name) => {
      try {
        return parseProcStatus(Number(name), await readFile(`/proc/${name}/status`, 'utf8'));
      } catch {
        // The process exited between the listing and the read.
        return null;
      }
    });
  return (await Promise.all(reads)).filter((e): e is ProcessEntry => e !== null);
}

function psTable(): Promise<ProcessEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,rss='],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err === null ? parsePsTable(stdout) : []),
    );
  });
}

/**
 * The reader for `platform`: `/proc` on Linux, `ps` on macOS, `null` elsewhere (Windows has no
 * cheap equivalent; the metric then has no data points, as spec 10 §7 says).
 */
export function createProcessTreeReader(
  platform: NodeJS.Platform = process.platform,
): ProcessTreeReader | null {
  const table = platform === 'linux' ? linuxTable : platform === 'darwin' ? psTable : null;
  if (table === null) return null;
  return {
    async rssOfTrees(roots) {
      if (roots.length === 0) return new Map();
      try {
        return sumProcessTrees(await table(), roots);
      } catch {
        return new Map();
      }
    },
  };
}
