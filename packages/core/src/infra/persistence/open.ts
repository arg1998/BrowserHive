/** @module infra/persistence/open — opens `browserhive.db`, asserts PRAGMAs, checks integrity and the compat window, migrates (D-04). */

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Kysely } from 'kysely';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { BunSqliteDialect } from './dialect/bun-sqlite-dialect.ts';
import type { DB } from './generated/db.d.ts';
import { newestBackup } from './migrations/backups.ts';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_VERSION } from './migrations/index.ts';
import type { Migration } from './migrations/migration.ts';
import { readMinReaderVersion, runMigrations } from './migrations/runner.ts';
import { pragmaLines, pragmaNumber, pragmaString, setPragma } from './pragma.ts';

/** Options of {@link openDatabase}. */
export interface OpenDatabaseOptions {
  /** Database file path or `:memory:`. */
  readonly path: string;
  /** Data directory (D-24); `backupsDir` defaults to `<dataDir>/backups`. */
  readonly dataDir: string;
  /** Recorded on `schema_migrations.app_version`. */
  readonly appVersion: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly backupsDir?: string;
  /** Open read-only and never migrate (second opener: `purge` inventory, `db` commands). */
  readonly readOnly?: boolean;
  /** Emit `db.query` spans (debug sampling). Default false. */
  readonly querySpans?: boolean;
  /** Migration list override (tests). Default: the shipped list. */
  readonly migrations?: readonly Migration[];
}

/** An open database. */
export interface DatabaseHandle {
  readonly db: Kysely<DB>;
  readonly raw: Database;
  readonly path: string;
  readonly backupsDir: string;
  /** `PRAGMA user_version` after open. */
  readonly schemaVersion: number;
  /** `meta.min_reader_version` after open. */
  readonly minReaderVersion: number;
  /** Migrations applied by this open (empty when already at head or read-only). */
  readonly migrationsApplied: readonly {
    readonly version: number;
    readonly name: string;
    readonly durationMs: number;
  }[];
  /** Pre-upgrade backup taken by this open, if any. */
  readonly backupPath: string | null;
  /** Checkpoints the WAL (`TRUNCATE`) and closes. Idempotent. */
  close(): Promise<void>;
}

/** PRAGMA values asserted on every open (D-04). */
export const REQUIRED_PRAGMAS = {
  journal_mode: 'wal',
  foreign_keys: 1,
  busy_timeout: 5000,
  synchronous: 1,
  auto_vacuum: 2,
} as const;

/**
 * Opens (creating when needed) the database, applies PRAGMAs, stamps or verifies
 * `application_id`, runs `quick_check`, enforces the compatibility window, migrates, and wraps the
 * handle in Kysely. Throws `DB_OPEN_FAILED`, `DB_CORRUPT`, `DB_NEWER_THAN_BINARY` or
 * `MIGRATION_FAILED`.
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<DatabaseHandle> {
  const { path, clock, logger } = options;
  const readOnly = options.readOnly ?? false;
  const inMemory = path === ':memory:';
  const backupsDir = options.backupsDir ?? join(options.dataDir, 'backups');
  const migrations = options.migrations ?? MIGRATIONS;
  const headVersion = migrations[migrations.length - 1]?.version ?? SCHEMA_VERSION;

  const raw = openRaw(path, readOnly, inMemory);
  try {
    try {
      applyPragmas(raw, readOnly, inMemory);
      checkApplicationId(raw, path, readOnly);
      quickCheck(raw, path, inMemory, clock);
    } catch (error) {
      throw classifyOpenError(error, raw, path, inMemory, clock);
    }

    const userVersion = pragmaNumber(raw, 'user_version');
    const minReader = readMinReaderVersion(raw);
    let applied: DatabaseHandle['migrationsApplied'] = [];
    let backupPath: string | null = null;
    if (userVersion > headVersion) {
      if (minReader > headVersion) {
        const backup = newestBackup(backupsDir);
        throw new AppError(
          'DB_NEWER_THAN_BINARY',
          {
            db_version: userVersion,
            min_reader_version: minReader,
            binary_version: headVersion,
            ...(backup !== null && { backup_path: backup }),
          },
          {
            message: `database schema v${userVersion} requires a binary that reads v${minReader}+; this one reads up to v${headVersion}. Restore the pre-upgrade backup with: browserhive db restore ${backup ?? '<file>'}`,
          },
        );
      }
      logger.warn('db newer than binary', { db_version: userVersion, binary_version: headVersion });
    } else if (!readOnly) {
      const result = runMigrations({
        raw,
        path,
        migrations,
        appVersion: options.appVersion,
        clock,
        logger,
        backupsDir: inMemory ? null : backupsDir,
      });
      applied = result.applied;
      backupPath = result.backupPath;
    }
    if (!readOnly && !inMemory) secureFiles(path);

    const db = new Kysely<DB>({
      dialect: new BunSqliteDialect({
        database: raw,
        ...(options.querySpans !== undefined && { querySpans: options.querySpans }),
      }),
    });
    let closed = false;
    return {
      db,
      raw,
      path,
      backupsDir,
      schemaVersion: pragmaNumber(raw, 'user_version'),
      minReaderVersion: readMinReaderVersion(raw),
      migrationsApplied: applied,
      backupPath,
      close: async () => {
        if (closed) return;
        closed = true;
        await db.destroy();
        if (!readOnly && !inMemory) {
          try {
            raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          } catch (error) {
            logger.warn('wal checkpoint failed', { error: String(error) });
          }
        }
        raw.close();
      },
    };
  } catch (error) {
    raw.close();
    throw error;
  }
}

function openRaw(path: string, readOnly: boolean, inMemory: boolean): Database {
  try {
    if (!inMemory && !readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new Database(path, { create: !readOnly, readonly: readOnly, strict: true });
  } catch (cause) {
    throw new AppError(
      'DB_OPEN_FAILED',
      { path, reason: String(cause) },
      { message: `cannot open database ${path}: ${String(cause)}`, cause },
    );
  }
}

function applyPragmas(raw: Database, readOnly: boolean, inMemory: boolean): void {
  setPragma(raw, 'busy_timeout', REQUIRED_PRAGMAS.busy_timeout);
  setPragma(raw, 'foreign_keys', 'ON');
  if (readOnly) {
    setPragma(raw, 'query_only', 1);
    return;
  }
  setPragma(raw, 'synchronous', 'NORMAL');
  // Must precede table creation to take effect on a fresh file; a no-op on an existing one.
  setPragma(raw, 'auto_vacuum', 'INCREMENTAL');
  if (!inMemory) {
    const mode = pragmaString(raw, 'journal_mode=WAL').toLowerCase();
    if (mode !== REQUIRED_PRAGMAS.journal_mode) {
      throw new AppError(
        'DB_OPEN_FAILED',
        { path: raw.filename, reason: `journal_mode is ${mode}, expected wal` },
        { message: `cannot enable WAL on ${raw.filename} (got ${mode})` },
      );
    }
  }
}

function checkApplicationId(raw: Database, path: string, readOnly: boolean): void {
  const id = pragmaNumber(raw, 'application_id');
  if (id === APPLICATION_ID) return;
  const fresh = id === 0 && pragmaNumber(raw, 'user_version') === 0;
  if (fresh && !readOnly) {
    setPragma(raw, 'application_id', APPLICATION_ID);
    return;
  }
  if (fresh) return;
  throw new AppError(
    'DB_OPEN_FAILED',
    { path, reason: `application_id 0x${id.toString(16)} is not a BrowserHive database` },
    { message: `${path} is not a BrowserHive database (application_id 0x${id.toString(16)})` },
  );
}

function quickCheck(raw: Database, path: string, inMemory: boolean, clock: Clock): void {
  const lines = pragmaLines(raw, 'quick_check');
  if (lines.length === 1 && lines[0] === 'ok') return;
  throw corrupt(raw, path, inMemory, clock, `quick_check: ${lines.join('; ')}`, undefined);
}

const CORRUPTION_RE = /malformed|corrupt|not a database|file is not a database/i;

/** Maps a failure of the open sequence to `DB_CORRUPT` (quarantining the file) or `DB_OPEN_FAILED`. */
function classifyOpenError(
  error: unknown,
  raw: Database,
  path: string,
  inMemory: boolean,
  clock: Clock,
): unknown {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (CORRUPTION_RE.test(message)) return corrupt(raw, path, inMemory, clock, message, error);
  return new AppError(
    'DB_OPEN_FAILED',
    { path, reason: message },
    { message: `cannot open database ${path}: ${message}`, cause: error },
  );
}

/** Moves the file to `<path>.corrupt-<ts>` (never for `:memory:`) and builds `DB_CORRUPT`. */
function corrupt(
  raw: Database,
  path: string,
  inMemory: boolean,
  clock: Clock,
  detail: string,
  cause: unknown,
): AppError {
  const quarantine = inMemory ? path : `${path}.corrupt-${clock.now()}`;
  if (!inMemory) {
    raw.close();
    try {
      renameSync(path, quarantine);
    } catch {
      // Leave the file in place; the error still names the intended quarantine path.
    }
  }
  return new AppError(
    'DB_CORRUPT',
    { path, quarantine_path: quarantine },
    { message: `database ${path} is corrupt (${detail})`, ...(cause !== undefined && { cause }) },
  );
}

function secureFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(file)) chmodSync(file, 0o600);
    } catch {
      // Best effort (Windows, foreign filesystems).
    }
  }
}
