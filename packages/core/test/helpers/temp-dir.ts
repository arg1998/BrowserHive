/** @module test/helpers/temp-dir — per-test temporary directories that are always removed (spec 09 §5). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs `fn` with a fresh directory and removes it afterwards, even on failure. */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
  prefix = 'bh-test-',
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
