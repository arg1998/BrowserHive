/** @module composition/lock-file — `<data-dir>/browserhive.lock`: one owner per data directory (server or maintenance command), with stale-pid recovery. */
/** File name of the data-dir lock (D-24 layout). */
export declare const LOCK_FILE_NAME = 'browserhive.lock';
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
export declare const processPidProbe: PidProbe;
/** Options of {@link acquireDataDirLock}. */
export interface AcquireLockOptions {
  readonly dataDir: string;
  readonly owner: string;
  readonly now: number;
  readonly pid?: number;
  readonly probe?: PidProbe;
}
/** The lock path for a data directory. */
export declare function lockPathFor(dataDir: string): string;
/**
 * Reads the lock of `dataDir`. Returns `null` when there is no lock or it is stale (its pid is
 * gone or the file is unparseable).
 */
export declare function readLiveLock(dataDir: string, probe?: PidProbe): LockInfo | null;
/**
 * Creates the lock atomically (`O_EXCL`). A lock held by a live process refuses with
 * `DATA_DIR_LOCKED`; a stale one (dead pid, garbage content) is replaced once.
 *
 * @throws `DATA_DIR_LOCKED` when a live process owns the directory; `DATA_DIR_UNWRITABLE` on I/O errors.
 */
export declare function acquireDataDirLock(options: AcquireLockOptions): DataDirLock;
/** Parses a lock file: JSON `{ pid, startedAt, owner }` or a bare pid. `null` when absent/garbage. */
export declare function readLock(path: string): LockInfo | null;
/** The `code` of a Node system error, if any. */
export declare function errnoOf(err: unknown): string | undefined;
//# sourceMappingURL=lock-file.d.ts.map
