/** @module infra/fs/node-file-system — `node:fs/promises` adapter of the `FileSystem` port. */

import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { FileStat, FileSystem, MkdirOptions, RemoveOptions } from '../../ports/file-system.ts';

/** Default mode for directories created by the adapter (D-24: private data). */
export const DIR_MODE = 0o700;

/** True for the errno a missing path raises. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Builds the production {@link FileSystem}. Missing paths are absorbed where the port says so.
 *
 * @returns A `FileSystem` over the real filesystem.
 */
export function createNodeFileSystem(): FileSystem {
  return {
    async stat(path: string): Promise<FileStat | null> {
      try {
        const s = await stat(path);
        return {
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async readdir(path: string): Promise<readonly string[]> {
      try {
        return await readdir(path);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
    async unlink(path: string): Promise<void> {
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async rm(path: string, options: RemoveOptions = {}): Promise<void> {
      await rm(path, { force: true, ...(options.recursive === true && { recursive: true }) });
    },
    async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
      await mkdir(path, { recursive: true, mode: options.mode ?? DIR_MODE });
    },
    readFile(path: string): Promise<string> {
      return readFile(path, 'utf8');
    },
    async writeFile(path: string, data: string, options: MkdirOptions = {}): Promise<void> {
      await writeFile(path, data, {
        encoding: 'utf8',
        ...(options.mode !== undefined && { mode: options.mode }),
      });
    },
  };
}
