/** @module composition/cli-storage — `openStorageForCli`: the database for the `db`, `admin`, `purge` and `doctor` commands, with read-only/non-migrating opens and data-dir lock detection. */
import type { DatabaseHandle } from '@browserhive/core/persistence';
import { SqliteMaintenanceService, SqliteUnitOfWork } from '@browserhive/core/persistence';
import type { AuthService, Clock, Logger, Repositories } from '@browserhive/core/runtime';
import { type LockInfo, type PidProbe } from './lock-file.ts';
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
export declare function openStorageForCli(options: CliStorageOptions): Promise<CliStorage>;
//# sourceMappingURL=cli-storage.d.ts.map
