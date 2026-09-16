/** @module app/auth-states/zip — directory ⇄ zip for full-profile snapshots: fflate `zipSync` (sync only), regular files only, zip-slip guard on extract (D-24). */

import { dirname, join, relative, sep } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
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
 * Zips every regular file under `root` into one archive buffer. Synchronous fflate by design:
 * its async `zip`/`unzip` spawn a Web Worker whose message handshake is broken under Bun.
 */
export async function zipDirectory(root: string, fs: ZipFs): Promise<Uint8Array> {
  const files = await collectRegularFiles(root, fs);
  const payload: Record<string, Uint8Array> = {};
  for (const [rel, abs] of files) payload[rel] = await fs.readFile(abs);
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
