/** @module infra/persistence/migrations/backups — `VACUUM INTO` backups and their retention (D-04, D-24). */

import type { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../kernel/errors/app-error.ts';

/** Backups kept per directory (spec 03 §7.1). */
export const BACKUPS_KEEP = 5;

const BACKUP_RE = /^browserhive-v(\d+)-.+\.db$/;

/** Formats an epoch ms as a filesystem-safe UTC stamp (`20260915T224800123Z`). */
export function backupStamp(at: number): string {
  return new Date(at).toISOString().replaceAll(/[-:.]/g, '');
}

/** Path of the backup for schema `version` taken at `at`. */
export function backupPath(backupsDir: string, version: number, at: number): string {
  return join(backupsDir, `browserhive-v${version}-${backupStamp(at)}.db`);
}

/**
 * Copies the live database with `VACUUM INTO` (consistent, compacted, no lock held longer than
 * a read). Creates the directory (0700). Throws `DB_OPEN_FAILED` on failure.
 */
export function createBackup(
  db: Database,
  backupsDir: string,
  version: number,
  at: number,
): string {
  const target = backupPath(backupsDir, version, at);
  try {
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } catch (cause) {
    throw new AppError(
      'DB_OPEN_FAILED',
      { path: target, reason: 'backup failed' },
      { message: `backup failed: ${String(cause)}`, cause },
    );
  }
  return target;
}

/** Every backup in the directory, newest first (by mtime, then name). */
export function listBackups(
  backupsDir: string,
): { path: string; sizeBytes: number; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    return [];
  }
  const entries = names
    .filter((name) => BACKUP_RE.test(name))
    .flatMap((name) => {
      const path = join(backupsDir, name);
      try {
        const stat = statSync(path);
        return [{ path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  return entries;
}

/** Newest backup path, or `null`. */
export function newestBackup(backupsDir: string): string | null {
  return listBackups(backupsDir)[0]?.path ?? null;
}

/** Deletes all but the newest `keep` backups; returns the paths removed. */
export function pruneBackups(backupsDir: string, keep = BACKUPS_KEEP): string[] {
  const removed: string[] = [];
  for (const entry of listBackups(backupsDir).slice(Math.max(0, keep))) {
    try {
      unlinkSync(entry.path);
      removed.push(entry.path);
    } catch {
      // Already gone; nothing to do.
    }
  }
  return removed;
}
