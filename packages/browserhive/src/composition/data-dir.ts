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

/**
 * Creates the data directory and its subdirectories with mode 0700. A directory created here is
 * chmod-ed explicitly (the umask may widen `mkdir`'s mode); existing directories keep their mode.
 *
 * @throws `DATA_DIR_UNWRITABLE`
 */
export function ensureDataDir(root: string): DataDirLayout {
  const layout = dataDirLayout(root);
  try {
    for (const dir of [root, ...DATA_SUBDIRS.map((name) => join(root, name))]) {
      if (existsSync(dir)) continue;
      mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
      chmodSync(dir, DATA_DIR_MODE);
    }
  } catch (err) {
    throw new AppError(
      'DATA_DIR_UNWRITABLE',
      { path: root },
      { cause: err, publicMessage: `The data directory ${root} is not writable.` },
    );
  }
  return layout;
}
