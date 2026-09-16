/** @module app/maintenance/test-support — in-memory `FileSystem` and manual interval scheduler for the maintenance suites (test support, not a test). */

import { dirname } from 'node:path';
import type { FileStat, FileSystem, RemoveOptions } from '../../ports/file-system.ts';
import type { IntervalScheduler } from './timer.ts';

/** Map-backed filesystem: files are `path → content`, directories are implied or explicit. */
export class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  /** Paths whose unlink/rm throws (EBUSY-like). */
  readonly failing = new Set<string>();
  readonly calls: string[] = [];

  addFile(path: string, content: string, mtimeMs = 0): void {
    this.files.set(path, content);
    this.mtimes.set(path, mtimeMs);
    for (let d = dirname(path); d !== dirname(d); d = dirname(d)) this.dirs.add(d);
  }

  private readonly mtimes = new Map<string, number>();

  async stat(path: string): Promise<FileStat | null> {
    const content = this.files.get(path);
    if (content !== undefined) {
      return {
        isFile: true,
        isDirectory: false,
        sizeBytes: content.length,
        mtimeMs: this.mtimes.get(path) ?? 0,
      };
    }
    if (this.dirs.has(path)) return { isFile: false, isDirectory: true, sizeBytes: 0, mtimeMs: 0 };
    return null;
  }

  async readdir(path: string): Promise<readonly string[]> {
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (dirname(p) === path && p !== path) names.add(p.slice(path.length + 1));
    }
    return [...names].sort();
  }

  async unlink(path: string): Promise<void> {
    this.calls.push(`unlink ${path}`);
    if (this.failing.has(path)) throw new Error(`EBUSY: ${path}`);
    this.files.delete(path);
  }

  async rm(path: string, options: RemoveOptions = {}): Promise<void> {
    this.calls.push(`rm${options.recursive === true ? ' -r' : ''} ${path}`);
    if (this.failing.has(path)) throw new Error(`EBUSY: ${path}`);
    for (const p of [...this.files.keys()])
      if (p === path || p.startsWith(`${path}/`)) this.files.delete(p);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.addFile(path, data);
  }
}

/** Interval scheduler whose ticks fire only through {@link ManualIntervals.tick}. */
export class ManualIntervals implements IntervalScheduler {
  fns: (() => void)[] = [];
  setInterval(fn: () => void): () => void {
    this.fns.push(fn);
    return () => {
      this.fns = this.fns.filter((f) => f !== fn);
    };
  }
  tick(): void {
    for (const fn of this.fns) fn();
  }
}

/** Lets queued microtasks and promise chains settle. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
