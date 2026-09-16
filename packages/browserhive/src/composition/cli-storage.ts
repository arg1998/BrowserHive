/** @module composition/cli-storage — `openStorageForCli`: the database for the `db`, `admin`, `purge` and `doctor` commands, with read-only/non-migrating opens and data-dir lock detection. */

import { existsSync } from 'node:fs';
import { VERSION } from '@browserhive/core';
import type { DatabaseHandle } from '@browserhive/core/persistence';
import {
  openDatabase,
  SCHEMA_VERSION,
  SqliteMaintenanceService,
  SqliteUnitOfWork,
} from '@browserhive/core/persistence';
import type { AuthService, Clock, Logger, Repositories } from '@browserhive/core/runtime';
import { AppError, createNanoidIdGenerator, createSystemClock } from '@browserhive/core/runtime';
import { createAuthStack } from './auth-stack.ts';
import { dataDirLayout, ensureDataDir } from './data-dir.ts';
import {
  acquireDataDirLock,
  type DataDirLock,
  type LockInfo,
  type PidProbe,
  processPidProbe,
  readLiveLock,
} from './lock-file.ts';

/** Options of {@link openStorageForCli}. */
export interface CliStorageOptions {
  readonly dataDir: string;
  /** Read-only connection: never migrates, never takes the lock, works next to a running server. */
  readonly readOnly: boolean;
  /** Writable opens only: apply pending migrations (`db migrate`, `init`). `false` refuses a DB that needs them. */
  readonly migrate: boolean;
  readonly logger: Logger;
  /** Recorded on `schema_migrations.app_version`. Default: the core `VERSION`. */
  readonly appVersion?: string;
  /** Lock owner label (the command name), e.g. `admin reset-password`. */
  readonly command?: string;
  readonly clock?: Clock;
  readonly probe?: PidProbe;
}

/** An open database for a maintenance command. */
export interface CliStorage {
  readonly handle: DatabaseHandle;
  readonly uow: SqliteUnitOfWork;
  readonly repos: Repositories;
  readonly maintenance: SqliteMaintenanceService;
  /** Token and password operations (`admin tokens …`, `admin reset-password`). */
  readonly auth: AuthService;
  /** The live server lock seen at open time (read-only opens only; writable opens hold the lock). */
  readonly serverLock: LockInfo | null;
  /** Checkpoints and closes the database, then releases the lock. Idempotent. */
  close(): Promise<void>;
}

/**
 * Opens the data directory's database for a CLI command.
 *
 * - Writable opens refuse with `DATA_DIR_LOCKED` while a live process (a server or another
 *   command) holds `<data-dir>/browserhive.lock`, and hold the lock until `close()`.
 * - Read-only opens report the live lock in `serverLock` and leave the decision to the command.
 * - `migrate: false` on a writable open refuses a database whose schema is behind this binary.
 *
 * @throws `DATA_DIR_LOCKED`, `DATA_DIR_UNWRITABLE`, `DB_OPEN_FAILED`, `DB_CORRUPT`,
 * `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`.
 */
export async function openStorageForCli(options: CliStorageOptions): Promise<CliStorage> {
  const clock = options.clock ?? createSystemClock();
  const appVersion = options.appVersion ?? VERSION;
  const probe = options.probe ?? processPidProbe;
  const layout = options.readOnly ? dataDirLayout(options.dataDir) : ensureDataDir(options.dataDir);
  let lock: DataDirLock | null = null;
  let serverLock: LockInfo | null = null;
  if (options.readOnly) {
    serverLock = readLiveLock(layout.root, probe);
    if (!existsSync(layout.database)) {
      throw new AppError(
        'DB_OPEN_FAILED',
        { path: layout.database, reason: 'missing' },
        { publicMessage: `No database at ${layout.database}.` },
      );
    }
  } else {
    lock = acquireDataDirLock({
      dataDir: layout.root,
      owner: options.command ?? 'cli',
      now: clock.now(),
      probe,
    });
  }
  let handle: DatabaseHandle | undefined;
  try {
    if (!options.readOnly && !options.migrate && existsSync(layout.database)) {
      await assertNoPendingMigrations(
        layout.database,
        layout.root,
        appVersion,
        clock,
        options.logger,
      );
    }
    handle = await openDatabase({
      path: layout.database,
      dataDir: layout.root,
      backupsDir: layout.backups,
      appVersion,
      clock,
      logger: options.logger,
      readOnly: options.readOnly,
    });
  } catch (err) {
    lock?.release();
    throw err;
  }
  const opened = handle;
  const uow = new SqliteUnitOfWork(opened.db);
  const auth = createAuthStack({
    repos: uow.repos,
    dataDir: layout.root,
    clock,
    ids: createNanoidIdGenerator({ clock }),
    logger: options.logger,
    mode: 'off',
    authTokens: [],
    allowInsecureBind: false,
  });
  let closed = false;
  return {
    handle: opened,
    uow,
    repos: uow.repos,
    maintenance: new SqliteMaintenanceService({
      handle: opened,
      clock,
      logger: options.logger,
      appVersion,
    }),
    auth: auth.service,
    serverLock,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await opened.close();
      } finally {
        lock?.release();
      }
    },
  };
}

async function assertNoPendingMigrations(
  path: string,
  dataDir: string,
  appVersion: string,
  clock: Clock,
  logger: Logger,
): Promise<void> {
  const probe = await openDatabase({ path, dataDir, appVersion, clock, logger, readOnly: true });
  const version = probe.schemaVersion;
  await probe.close();
  if (version < SCHEMA_VERSION) {
    throw new AppError(
      'DB_OPEN_FAILED',
      { path, reason: 'migration_pending' },
      {
        publicMessage: `The database schema is v${version}; this version needs v${SCHEMA_VERSION}. Run 'browserhive db migrate' first.`,
      },
    );
  }
}
