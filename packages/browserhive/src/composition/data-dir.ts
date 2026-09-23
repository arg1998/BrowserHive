/** @module composition/data-dir — creates the D-24 layout with owner-only permissions. */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@browserhive/core/runtime';

/** Owner-only directory mode (D-24). */
export const DATA_DIR_MODE = 0o700;

/** Subdirectories created at boot (D-24). */
export const DATA_SUBDIRS = ['backups', 'admin', 'sessions', 'auth-states', 'uploads'] as const;

/** Resolved paths of the layout. */
export interface DataDirLayout {
  readonly root: string;
  readonly database: string;
  readonly backups: string;
  readonly admin: string;
  readonly sessions: string;
  readonly authStates: string;
  readonly uploads: string;
}

/** Paths of the D-24 layout under `root`. */
export function dataDirLayout(root: string): DataDirLayout {
  return {
    root,
    database: join(root, 'browserhive.db'),
    backups: join(root, 'backups'),
    admin: join(root, 'admin'),
    sessions: join(root, 'sessions'),
    authStates: join(root, 'auth-states'),
    uploads: join(root, 'uploads'),
  };
}

/** The filesystem calls {@link ensureDataDir} makes (injectable for tests). */
export interface DataDirFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
}

const NODE_FS: DataDirFs = { existsSync, mkdirSync, chmodSync };

/** Options of {@link ensureDataDir}. */
export interface EnsureDataDirOptions {
  /** Called when a created directory could not be narrowed to 0700 (boot continues). */
  readonly onChmodFailed?: (dir: string, err: unknown) => void;
  readonly fs?: DataDirFs;
}

/**
 * Creates the data directory and its subdirectories with mode 0700. A directory created here is
 * chmod-ed explicitly (the umask may widen `mkdir`'s mode); existing directories keep their mode.
 *
 * The chmod is best effort, like the database file's: filesystems that reject mode changes
 * (CIFS/SMB shares, some container bind mounts, Windows) must not stop the server from booting.
 * The failure is reported through `onChmodFailed`, and `browserhive doctor` flags the mode.
 * Failing to create a directory is still fatal.
 *
 * @throws `DATA_DIR_UNWRITABLE`
 */
export function ensureDataDir(root: string, options: EnsureDataDirOptions = {}): DataDirLayout {
  const fs = options.fs ?? NODE_FS;
  const layout = dataDirLayout(root);
  for (const dir of [root, ...DATA_SUBDIRS.map((name) => join(root, name))]) {
    if (fs.existsSync(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
    } catch (err) {
      throw new AppError(
        'DATA_DIR_UNWRITABLE',
        { path: root },
        { cause: err, publicMessage: `The data directory ${root} is not writable.` },
      );
    }
    try {
      fs.chmodSync(dir, DATA_DIR_MODE);
    } catch (err) {
      options.onChmodFailed?.(dir, err);
    }
  }
  return layout;
}
