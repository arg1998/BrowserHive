/** @module composition/lock-file — `<data-dir>/browserhive.lock`: one owner per data directory (server or maintenance command), with stale-pid recovery. */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@browserhive/core/runtime';

/** File name of the data-dir lock (D-24 layout). */
export const LOCK_FILE_NAME = 'browserhive.lock';

/** Parsed lock contents. */
export interface LockInfo {
  readonly pid: number;
  readonly startedAt: number | null;
  /** What holds the lock: `serve` or the maintenance command name. */
  readonly owner: string | null;
}

/** An acquired lock. `release()` is idempotent and only removes a file that still names this pid. */
export interface DataDirLock {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

/** Process probe seam (tests inject dead/alive pids). */
export interface PidProbe {
  /** True when a process with `pid` exists (EPERM counts as alive). */
  isAlive(pid: number): boolean;
}

/** `process.kill(pid, 0)` probe. */
export const processPidProbe: PidProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return errnoOf(err) === 'EPERM';
    }
  },
};

/** Options of {@link acquireDataDirLock}. */
export interface AcquireLockOptions {
  readonly dataDir: string;
  readonly owner: string;
  readonly now: number;
  readonly pid?: number;
  readonly probe?: PidProbe;
}

/** The lock path for a data directory. */
export function lockPathFor(dataDir: string): string {
  return join(dataDir, LOCK_FILE_NAME);
}

/**
 * Reads the lock of `dataDir`. Returns `null` when there is no lock or it is stale (its pid is
 * gone or the file is unparseable).
 */
export function readLiveLock(dataDir: string, probe: PidProbe = processPidProbe): LockInfo | null {
  const info = readLock(lockPathFor(dataDir));
  if (info === null) return null;
  return probe.isAlive(info.pid) ? info : null;
}

/**
 * Creates the lock atomically (`O_EXCL`). A lock held by a live process refuses with
 * `DATA_DIR_LOCKED`; a stale one (dead pid, garbage content) is replaced once.
 *
 * @throws `DATA_DIR_LOCKED` when a live process owns the directory; `DATA_DIR_UNWRITABLE` on I/O errors.
 */
export function acquireDataDirLock(options: AcquireLockOptions): DataDirLock {
  const path = lockPathFor(options.dataDir);
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? processPidProbe;
  const body = `${JSON.stringify({ pid, startedAt: options.now, owner: options.owner })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return lockHandle(path, pid);
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') {
        throw new AppError(
          'DATA_DIR_UNWRITABLE',
          { path: options.dataDir },
          { cause: err, message: `cannot create ${path}` },
        );
      }
      const holder = readLock(path);
      if (holder !== null && probe.isAlive(holder.pid)) {
        throw new AppError(
          'DATA_DIR_LOCKED',
          { path: options.dataDir, pid: holder.pid },
          {
            publicMessage: `The data directory ${options.dataDir} is in use by another BrowserHive process (pid ${holder.pid}).`,
          },
        );
      }
      removeQuietly(path);
    }
  }
  throw new AppError(
    'DATA_DIR_UNWRITABLE',
    { path: options.dataDir },
    { message: `lock ${path} kept reappearing` },
  );
}

function lockHandle(path: string, pid: number): DataDirLock {
  let released = false;
  return {
    path,
    pid,
    release() {
      if (released) return;
      released = true;
      if (readLock(path)?.pid === pid) removeQuietly(path);
    },
  };
}

/** Parses a lock file: JSON `{ pid, startedAt, owner }` or a bare pid. `null` when absent/garbage. */
export function readLock(path: string): LockInfo | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  if (/^\d+$/.test(text)) return { pid: Number(text), startedAt: null, owner: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record: { pid?: unknown; startedAt?: unknown; owner?: unknown } = parsed;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
      return null;
    }
    return {
      pid: record.pid,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      owner: typeof record.owner === 'string' ? record.owner : null,
    };
  } catch {
    return null;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** The `code` of a Node system error, if any. */
export function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code: unknown = err.code;
  return typeof code === 'string' ? code : undefined;
}
