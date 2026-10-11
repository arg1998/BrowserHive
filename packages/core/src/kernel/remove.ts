/** @module kernel/remove — recursive removal that waits out transient Windows file locks (a just-exited Chromium, a just-closed SQLite handle). */

import { rm as fsRm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Error codes a recursive remove can hit while another process is still releasing a handle. On
 * Windows a file stays locked until every handle closes, and Chromium's child processes (GPU,
 * network, crashpad) and SQLite's `-wal`/`-shm` files let go a moment after their owner returns.
 * `fs.rm`'s own `maxRetries` would cover this, but Bun ignores it and fails on the first `EBUSY`.
 */
export const TRANSIENT_REMOVE_CODES: ReadonlySet<string> = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'ENOTEMPTY',
  'EMFILE',
  'ENFILE',
]);

/** Options of {@link removeTree}. */
export interface RemoveTreeOptions {
  /** Attempts after the first. Default 10. */
  readonly retries?: number;
  /** Delay before retry `n` is `n × retryDelayMs`. Default 50 (about 2.75 s in all). */
  readonly retryDelayMs?: number;
  /** Test seam: the remove call. Default `fs.rm(path, { recursive: true, force: true })`. */
  readonly rm?: (path: string) => Promise<void>;
  /** Test seam: the wait between attempts. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * `rm -rf` that retries the transient lock errors with a linear backoff, then rethrows the last
 * one. A missing path is not an error. Other errors are thrown at once.
 */
export async function removeTree(path: string, options: RemoveTreeOptions = {}): Promise<void> {
  const retries = options.retries ?? 10;
  const delay = options.retryDelayMs ?? 50;
  const remove = options.rm ?? ((p: string) => fsRm(p, { recursive: true, force: true }));
  const wait = options.sleep ?? ((ms: number) => sleep(ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(path);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (attempt >= retries || code === undefined || !TRANSIENT_REMOVE_CODES.has(code)) {
        throw error;
      }
      await wait((attempt + 1) * delay);
    }
  }
}
