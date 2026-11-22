/** @module cli/production/file-system — the CLI's filesystem: core's node adapter plus exact byte reads and writes (signed registry layouts, review #97 D80) */
import { readFile, writeFile } from 'node:fs/promises';
import { createNodeFileSystem } from '@browserhive/core/runtime';
import type { CliFileSystem } from '../deps.ts';

/**
 * The production {@link CliFileSystem}.
 *
 * @returns The filesystem.
 */
export function createCliFileSystem(): CliFileSystem {
  const base = createNodeFileSystem();
  return {
    stat: (path) => base.stat(path),
    readdir: (path) => base.readdir(path),
    unlink: (path) => base.unlink(path),
    rm: (path, options) => base.rm(path, options),
    mkdir: (path, options) => base.mkdir(path, options),
    readFile: (path) => base.readFile(path),
    writeFile: (path, data, options) => base.writeFile(path, data, options),
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    writeBytes: async (path, data, options = {}) => {
      await writeFile(path, data, options.mode === undefined ? {} : { mode: options.mode });
    },
  };
}
