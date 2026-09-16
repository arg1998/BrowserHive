/** @module infra/auth/credentials-file — writes `<data-dir>/admin/credentials.txt` (0600) and shreds it after the first password change. */

import { chmod, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CredentialsFile } from '../../ports/credentials-file.ts';

/** Directory mode for `<data-dir>/admin` (D-24). */
export const ADMIN_DIR_MODE = 0o700;
/** File mode for secret files (D-24). */
export const CREDENTIALS_FILE_MODE = 0o600;
/** File name under `<data-dir>/admin/`. */
export const CREDENTIALS_FILE_NAME = 'credentials.txt';

/** The filesystem calls the adapter needs, injectable for tests. */
export interface CredentialsFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string | Uint8Array, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Size in bytes, or `null` when the file does not exist. */
  size(path: string): Promise<number | null>;
  unlink(path: string): Promise<void>;
}

/** Node adapter of {@link CredentialsFs}. */
export const nodeCredentialsFs: CredentialsFs = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data, options) => writeFile(path, data, options),
  chmod: (path, mode) => chmod(path, mode),
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  },
  unlink: (path) => unlink(path),
};

/** Options for {@link createCredentialsFile}. */
export interface CredentialsFileOptions {
  /** Resolved `dataDir`. */
  readonly dataDir: string;
  readonly fs?: CredentialsFs;
}

/** Builds the {@link CredentialsFile} for a data directory. */
export function createCredentialsFile(options: CredentialsFileOptions): CredentialsFile {
  const fs = options.fs ?? nodeCredentialsFs;
  const path = join(options.dataDir, 'admin', CREDENTIALS_FILE_NAME);
  return {
    path,
    async write(password) {
      await fs.mkdir(dirname(path), { recursive: true, mode: ADMIN_DIR_MODE });
      await fs.writeFile(path, `${password.reveal()}\n`, { mode: CREDENTIALS_FILE_MODE });
      await fs.chmod(path, CREDENTIALS_FILE_MODE);
    },
    async shred() {
      const size = await fs.size(path);
      if (size === null) return;
      await fs.writeFile(path, new Uint8Array(size), { mode: CREDENTIALS_FILE_MODE });
      await fs.unlink(path);
    },
    async exists() {
      return (await fs.size(path)) !== null;
    },
  };
}
