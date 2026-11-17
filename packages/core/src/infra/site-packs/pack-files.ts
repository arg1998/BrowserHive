/** @module infra/site-packs/pack-files — small `node:fs` helpers the pack sources, the approved-copy cache and the import writer share: bounded reads, atomic writes and the name checks that keep pack ids and hashes from naming paths outside their folder. */

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Directory mode of everything under `site-packs/` (D-24: private data). */
export const PACK_DIR_MODE = 0o700;
/** File mode of written packs. */
export const PACK_FILE_MODE = 0o600;

/** A pack id usable as a file name: a registrable domain, never a path. */
const SAFE_ID = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** A lowercase hex SHA-256. */
const SHA256 = /^[0-9a-f]{64}$/;

/** True when `id` can name a file (`<id>.json`, `cache/<source>/<id>/`). */
export function isSafePackId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..');
}

/** True for a lowercase hex SHA-256. */
export function isSha256(value: string): boolean {
  return SHA256.test(value);
}

/** True for the errno of a missing path. */
export function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** What a bounded read found. */
export type BoundedRead =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large'; readonly size: number }
  | { readonly kind: 'missing' };

/**
 * Reads at most `max` bytes of `path` (one byte more is read to detect a larger file without
 * loading it whole). Errors other than a missing file propagate.
 */
export async function readBounded(path: string, max: number): Promise<BoundedRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' };
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > max) return { kind: 'too_large', size };
    const buffer = new Uint8Array(max + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) return { kind: 'too_large', size: total };
    }
    return { kind: 'bytes', bytes: buffer.slice(0, total) };
  } finally {
    await handle.close();
  }
}

/** Writes `bytes` to `path` through a temporary sibling and a rename, creating the folder 0700. */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PACK_DIR_MODE });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: PACK_FILE_MODE });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
