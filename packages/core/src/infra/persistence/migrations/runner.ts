/** @module infra/persistence/migrations/runner — forward-only migration runner with backup and compat window (D-04). */

import type { Database } from 'bun:sqlite';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { Clock } from '../../../ports/clock.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { MigrationResult } from '../../../ports/persistence/maintenance.ts';
import { withSpan } from '../dialect/spans.ts';
import { pragmaNumber, setPragma, tableExists } from '../pragma.ts';
import { BACKUPS_KEEP, createBackup, pruneBackups } from './backups.ts';
import type { Migration } from './migration.ts';

/** Inputs of {@link runMigrations}. */
export interface RunMigrationsOptions {
  readonly raw: Database;
  /** Database path; `:memory:` skips the backup. */
  readonly path: string;
  readonly migrations: readonly Migration[];
  readonly appVersion: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Where pre-upgrade backups go; `null` disables backups (tests, memory). */
  readonly backupsDir: string | null;
  /** Backups retained after pruning. Default 5. */
  readonly backupsKeep?: number;
}

/** Key of the compatibility floor in `meta`. */
export const MIN_READER_KEY = 'min_reader_version';

/** Reads `meta.min_reader_version`, or 0 when the table or row does not exist yet. */
export function readMinReaderVersion(raw: Database): number {
  if (!tableExists(raw, 'meta')) return 0;
  const row = raw.query('SELECT value FROM meta WHERE key = ?').get(MIN_READER_KEY);
  if (row === null || typeof row !== 'object' || !('value' in row)) return 0;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Applies every migration with `version > user_version` inside one `BEGIN IMMEDIATE` transaction.
 * Order: busy_timeout (already set by the opener) → backup via `VACUUM INTO` → `foreign_keys=OFF`
 * → BEGIN → `db.exec` per migration + audit row → `user_version` + `meta.min_reader_version`
 * → `foreign_key_check` → COMMIT. Any failure rolls back and throws `MIGRATION_FAILED`.
 */
export function runMigrations(options: RunMigrationsOptions): MigrationResult {
  const { raw, migrations, clock, logger } = options;
  const from = pragmaNumber(raw, 'user_version');
  const pending = migrations.filter((m) => m.version > from);
  const to = migrations[migrations.length - 1]?.version ?? from;
  if (pending.length === 0) return { from, to: from, applied: [], backupPath: null };

  return withSpan(
    'db.migrate',
    { 'browserhive.from_version': from, 'browserhive.to_version': to },
    (span) => {
      let backupPath: string | null = null;
      if (options.backupsDir !== null && options.path !== ':memory:' && from > 0) {
        backupPath = createBackup(raw, options.backupsDir, from, clock.now());
        span.setAttribute('browserhive.backup_path', backupPath);
        const pruned = pruneBackups(options.backupsDir, options.backupsKeep ?? BACKUPS_KEEP);
        logger.info('backup created', { path: backupPath, pruned: pruned.length });
      }

      const applied: { version: number; name: string; durationMs: number }[] = [];
      setPragma(raw, 'foreign_keys', 'OFF');
      try {
        raw.exec('BEGIN IMMEDIATE');
        let minReader = readMinReaderVersion(raw);
        let current: Migration | undefined;
        try {
          for (const migration of pending) {
            current = migration;
            const durationMs = withSpan(
              'db.migrate.step',
              { 'browserhive.to_version': migration.version },
              () => applyOne(raw, migration, options.appVersion, clock),
            );
            applied.push({ version: migration.version, name: migration.name, durationMs });
            if (!migration.compatible) minReader = migration.version;
          }
          setPragma(raw, 'user_version', to);
          raw
            .query(
              'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            )
            .run(MIN_READER_KEY, String(Math.max(minReader, 1)));
          const violations = raw.query('PRAGMA foreign_key_check').all();
          if (violations.length > 0) {
            throw new Error(`foreign_key_check reported ${violations.length} violation(s)`);
          }
          raw.exec('COMMIT');
        } catch (cause) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            // Nothing to roll back (the failure happened before BEGIN took effect).
          }
          const name = current?.name ?? 'unknown';
          logger.error('migration failed', { from, to, name, error: String(cause) });
          throw new AppError(
            'MIGRATION_FAILED',
            { from, to, name, backup_path: backupPath ?? '' },
            { message: `migration ${name} failed: ${String(cause)}`, cause },
          );
        }
      } finally {
        setPragma(raw, 'foreign_keys', 'ON');
      }
      logger.info('migrations applied', { from, to, count: applied.length });
      return { from, to, applied, backupPath };
    },
  );
}

/** Executes one migration and writes its audit row; returns the wall time it took. */
function applyOne(raw: Database, migration: Migration, appVersion: string, clock: Clock): number {
  const startedAt = clock.now();
  raw.exec(migration.sql);
  const durationMs = Math.max(0, clock.now() - startedAt);
  raw
    .query(
      'INSERT INTO schema_migrations (version, name, applied_at, duration_ms, app_version) VALUES (?, ?, ?, ?, ?)',
    )
    .run(migration.version, migration.name, startedAt, durationMs, appVersion);
  return durationMs;
}
