/** @module infra/persistence — public surface of the SQLite persistence adapter (D-04). */

export { resolveBucketMs, SqliteAnalyticsQueries } from './analytics.ts';
export { BunSqliteDialect, type BunSqliteDialectOptions } from './dialect/bun-sqlite-dialect.ts';
export { BunSqliteDriver, type BunSqliteDriverOptions } from './dialect/bun-sqlite-driver.ts';
export type { DB } from './generated/db.d.ts';
export { LOG_INSERT_CHUNK, type NewLogRecordRow, SqliteLogRepository } from './log-rows.ts';
export { type MaintenanceOptions, SqliteMaintenanceService } from './maintenance.ts';
export { BACKUPS_KEEP, listBackups, newestBackup, pruneBackups } from './migrations/backups.ts';
export {
  APPLICATION_ID,
  MIGRATIONS,
  type Migration,
  SCHEMA_VERSION,
  TABLES,
} from './migrations/index.ts';
export { type RunMigrationsOptions, runMigrations } from './migrations/runner.ts';
export {
  type DatabaseHandle,
  type OpenDatabaseOptions,
  openDatabase,
  REQUIRED_PRAGMAS,
} from './open.ts';
export { createRepositories } from './repositories/index.ts';
export { type RetentionContext, sweepRetention } from './retention.ts';
export { SqliteUnitOfWork } from './unit-of-work.ts';
export { SqliteWriteQueue, type WriteQueueOptions } from './write-queue.ts';
