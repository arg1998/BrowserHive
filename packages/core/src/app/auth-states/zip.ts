/** @module app/auth-states/zip — directory ⇄ zip for full-profile snapshots: fflate `zipSync` (sync only), regular files only, zip-slip guard on extract (D-24). */

import { dirname, join, relative, sep } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { AppError } from '../../kernel/errors/app-error.ts';
import { resolveZipEntry } from '../../kernel/paths.ts';

/** One directory entry as the zip helpers see it. */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** The filesystem slice the zip helpers need (production: `node:fs/promises`). */
export interface ZipFs {
  readdir(dir: string): Promise<readonly DirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Recursive mkdir (`mkdir -p`). */
  mkdir(dir: string): Promise<void>;
}

/** Compression level for profile zips (`6`: profiles compress well; a balance of speed and size). */
export const ZIP_LEVEL = 6;

/**
 * Recursively collects regular files under `root` as POSIX-style relative path → absolute path.
 * Symlinks, sockets and FIFOs are skipped: a live Chromium profile contains `SingletonSocket` and
 * `SingletonLock` which cannot — and must not — be archived; a fresh profile recreates them.
 */
async function collectRegularFiles(root: string, fs: ZipFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir)) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory) await walk(abs);
      else if (entry.isFile) out.set(relative(root, abs).split(sep).join('/'), abs);
    }
  }
  await walk(root);
  return out;
}

/**
 * Lock-marker files of a live profile: LevelDB's `LOCK` (Local Storage, IndexedDB, …) and the
 * profile's own `lockfile`. Empty, recreated by every launch, and on Windows held open exclusively
 * by the running browser, so a live snapshot cannot read them.
 */
export const PROFILE_LOCK_FILES: ReadonlySet<string> = new Set(['LOCK', 'lockfile']);

/** Codes of a file another process holds open exclusively (Windows sharing violations). */
const LOCKED_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** True when a read failure means "leave this file out" rather than "the snapshot failed". */
function skippable(rel: string, error: unknown): boolean {
  const code = codeOf(error);
  // A live browser deletes temp and journal files all the time: listed, then gone before the read.
  if (code === 'ENOENT') return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return code !== undefined && LOCKED_CODES.has(code) && PROFILE_LOCK_FILES.has(base);
}

/**
 * Zips every regular file under `root` into one archive buffer. Synchronous fflate by design:
 * its async `zip`/`unzip` spawn a Web Worker whose message handshake is broken under Bun.
 *
 * A live profile is a moving target, so two read failures leave the file out instead of failing:
 * a file that vanished after the listing, and a lock marker ({@link PROFILE_LOCK_FILES}) the running
 * browser holds exclusively. A locked data file is `PROFILE_FILE_LOCKED` and anything else is
 * rethrown: a snapshot never silently misses data.
 *
 * @throws `PROFILE_FILE_LOCKED` `{ file }` for a data file the running browser holds exclusively.
 */
export async function zipDirectory(root: string, fs: ZipFs): Promise<Uint8Array> {
  const files = await collectRegularFiles(root, fs);
  const payload: Record<string, Uint8Array> = {};
  for (const [rel, abs] of files) {
    try {
      payload[rel] = await fs.readFile(abs);
    } catch (error) {
      if (skippable(rel, error)) continue;
      if (LOCKED_CODES.has(codeOf(error) ?? '')) {
        // A data file the running browser holds exclusively (Windows: cookies, history). Leaving it
        // out would be a silently incomplete snapshot; say which file and what to use instead.
        throw new AppError('PROFILE_FILE_LOCKED', { file: rel }, { cause: error });
      }
      throw error;
    }
  }
  return zipSync(payload, { level: ZIP_LEVEL });
}

/**
 * Extracts `archive` into `destDir`, creating parents as needed. Every entry is confined to
 * `destDir` through the kernel zip-slip guard.
 *
 * @throws `PATH_NOT_ALLOWED` for an entry that would escape `destDir`.
 */
export async function unzipToDirectory(
  archive: Uint8Array,
  destDir: string,
  fs: ZipFs,
): Promise<void> {
  const files = unzipSync(archive);
  for (const [rel, bytes] of Object.entries(files)) {
    // fflate yields directory entries as keys ending in '/'; files recreate the tree.
    if (rel.endsWith('/')) continue;
    const abs = resolveZipEntry(destDir, rel);
    await fs.mkdir(dirname(abs));
    await fs.writeFile(abs, bytes);
  }
}
