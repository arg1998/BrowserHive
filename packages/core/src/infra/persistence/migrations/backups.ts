/** @module infra/persistence/migrations/backups — `VACUUM INTO` backups and their retention (D-04, D-24). */

import type { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { MIGRATIONS } from './index.ts';
import type { Migration } from './migration.ts';

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

/** One backup file: its path, size, mtime and the schema version in its name. */
export interface BackupFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly version: number;
}

/** Every backup in the directory, newest first (by mtime, then name). */
export function listBackups(backupsDir: string): BackupFile[] {
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
      const version = Number(BACKUP_RE.exec(name)?.[1] ?? 0);
      try {
        const stat = statSync(path);
        return [{ path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, version }];
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

/**
 * The backup a binary that reads up to schema `maxVersion` can restore: the highest schema version
 * at most `maxVersion`, newest first within it (the pre-upgrade backup of an incompatible
 * migration, never a later manual backup of the newer schema). `null` when there is none.
 */
export function readableBackup(backupsDir: string, maxVersion: number): string | null {
  const readable = listBackups(backupsDir).filter((b) => b.version <= maxVersion);
  readable.sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs);
  return readable[0]?.path ?? null;
}

/** Versions of the incompatible migrations (each raised `meta.min_reader_version`). */
export function readerFloors(migrations: readonly Migration[] = MIGRATIONS): number[] {
  return migrations.filter((m) => !m.compatible).map((m) => m.version);
}

/**
 * The backups pruning never deletes: for each reader floor `F` (an incompatible migration), the
 * newest backup below `F`, which is the only file a binary older than `F` can restore (D-04).
 */
export function protectedBackups(
  backups: readonly BackupFile[],
  floors: readonly number[],
): Set<string> {
  const keep = new Set<string>();
  for (const floor of floors) {
    const below = backups.find((b) => b.version < floor);
    if (below !== undefined) keep.add(below.path);
  }
  return keep;
}

/**
 * Deletes all but the newest `keep` backups, never a {@link protectedBackups} file, together with
 * any `-wal`/`-shm` sidecar; returns the paths removed.
 */
export function pruneBackups(
  backupsDir: string,
  keep = BACKUPS_KEEP,
  floors: readonly number[] = readerFloors(),
): string[] {
  const backups = listBackups(backupsDir);
  const kept = protectedBackups(backups, floors);
  const removed: string[] = [];
  for (const entry of backups.slice(Math.max(0, keep))) {
    if (kept.has(entry.path)) continue;
    try {
      unlinkSync(entry.path);
      removed.push(entry.path);
    } catch {
      // Already gone; nothing to do.
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        unlinkSync(`${entry.path}${suffix}`);
      } catch {
        // No sidecar.
      }
    }
  }
  return removed;
}
