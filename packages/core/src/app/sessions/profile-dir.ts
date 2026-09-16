/** @module app/sessions/profile-dir — D-24 per-session directory layout (`<data-dir>/sessions/<id>/{userdata,screenshots,downloads,trace.zip}`), 0700, prepare/cleanup through an injected fs. */

import { join } from 'node:path';

/** Owner-only: a session directory holds cookies, tokens and screenshots (threat model). */
export const DIR_MODE = 0o700;

/** Sub-directory under the data dir that holds every session (D-24). */
export const SESSIONS_DIR_NAME = 'sessions';

/** Resolved paths of one session's directory tree. */
export interface SessionDirs {
  readonly root: string;
  /** Managed Chromium profile; only created for `persistent` sessions. */
  readonly userdata: string;
  readonly screenshots: string;
  readonly downloads: string;
  /** Trace chunk parts written between vault-fill pauses (D-13); merged into `traceZip` at close. */
  readonly traceParts: string;
  readonly traceZip: string;
}

/** Path builder over one data dir. */
export interface SessionDirLayout {
  readonly sessionsRoot: string;
  forSession(sessionId: string): SessionDirs;
}

/** Builds the D-24 layout for `dataDir`. */
export function sessionDirLayout(dataDir: string): SessionDirLayout {
  const sessionsRoot = join(dataDir, SESSIONS_DIR_NAME);
  return {
    sessionsRoot,
    forSession(sessionId) {
      const root = join(sessionsRoot, sessionId);
      return {
        root,
        userdata: join(root, 'userdata'),
        screenshots: join(root, 'screenshots'),
        downloads: join(root, 'downloads'),
        traceParts: join(root, 'trace-parts'),
        traceZip: join(root, 'trace.zip'),
      };
    },
  };
}

/** The filesystem operations the session subsystem performs, injectable for tests. */
export interface SessionDirFs {
  /** `mkdir -p` with `mode`. */
  mkdir(path: string, mode: number): Promise<void>;
  /** `rm -rf`; a missing path is not an error. */
  rm(path: string): Promise<void>;
  /** True when `path` is missing or an empty directory. */
  isEmptyOrMissing(path: string): Promise<boolean>;
  /** True when `path` exists. */
  exists(path: string): Promise<boolean>;
}

/** What the pipeline needs to know to lay the tree out. */
export interface PrepareOptions {
  readonly persistent: boolean;
  readonly trace: boolean;
}

/** Creates the session tree (D-24). `userdata` only for persistent sessions, `trace-parts` only when tracing. */
export async function prepareSessionDirs(
  fs: SessionDirFs,
  dirs: SessionDirs,
  options: PrepareOptions,
): Promise<void> {
  await fs.mkdir(dirs.root, DIR_MODE);
  await fs.mkdir(dirs.screenshots, DIR_MODE);
  await fs.mkdir(dirs.downloads, DIR_MODE);
  if (options.persistent) await fs.mkdir(dirs.userdata, DIR_MODE);
  if (options.trace) await fs.mkdir(dirs.traceParts, DIR_MODE);
}

/** Removes the whole session tree (launch compensation). Best-effort. */
export async function removeSessionDir(fs: SessionDirFs, dirs: SessionDirs): Promise<void> {
  await fs.rm(dirs.root);
}

/**
 * Post-close housekeeping. Trace parts are always dropped (they were merged or abandoned). A
 * `memory`/`storage-state` session that produced no artifact (no trace, no screenshot, no download)
 * leaves nothing behind: its directory is removed so an idle hive does not accumulate empty trees.
 * Persistent profiles and any artifacts are kept for retention (spec 03 §7.1).
 */
export async function cleanupAfterClose(
  fs: SessionDirFs,
  dirs: SessionDirs,
  options: { readonly persistent: boolean },
): Promise<void> {
  await fs.rm(dirs.traceParts);
  if (options.persistent) return;
  const [noShots, noDownloads, noTrace] = await Promise.all([
    fs.isEmptyOrMissing(dirs.screenshots),
    fs.isEmptyOrMissing(dirs.downloads),
    fs.exists(dirs.traceZip).then((present) => !present),
  ]);
  if (noShots && noDownloads && noTrace) await fs.rm(dirs.root);
}

/**
 * The production {@link SessionDirFs} over `node:fs/promises`. The single filesystem call site of
 * the session subsystem; app tests inject a fake.
 */
export function createNodeSessionDirFs(): SessionDirFs {
  return {
    async mkdir(path, mode) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path, { recursive: true, mode });
    },
    async rm(path) {
      const { rm } = await import('node:fs/promises');
      await rm(path, { recursive: true, force: true });
    },
    async isEmptyOrMissing(path) {
      const { readdir } = await import('node:fs/promises');
      try {
        const entries = await readdir(path);
        return entries.length === 0;
      } catch {
        return true;
      }
    },
    async exists(path) {
      const { stat } = await import('node:fs/promises');
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
