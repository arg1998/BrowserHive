/** @module app/maintenance — public surface: retention, artifact outbox, backups, purge, startup reconcile. */

export {
  ArtifactOutboxSweeper,
  type ArtifactOutboxSweeperDeps,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_OUTBOX_BATCH,
  DEFAULT_OUTBOX_INTERVAL_MS,
  OUTBOX_STEP,
  type OutboxSweepResult,
} from './artifact-outbox-sweeper.ts';
export {
  BACKUP_FILE_RE,
  type BackupEntry,
  BackupScheduler,
  type BackupSchedulerDeps,
} from './backup-scheduler.ts';
export {
  DATABASE_FILE,
  DATABASE_SIDE_FILES,
  type DatabaseInventory,
  type DataDirInventory,
  type DirectoryInventory,
  type InventoryRow,
  inventoryRows,
  PURGE_DIRECTORIES,
  PURGE_TARGETS,
  type PurgeDeps,
  type PurgeDirectory,
  type PurgeOptions,
  type PurgeTarget,
  purge,
  purgeInventory,
  type ReadOnlyInventoryFn,
} from './purge.ts';
export {
  DEFAULT_AUDIT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL_MS,
  RETENTION_FAILED,
  type RetentionConfig,
  type RetentionOutcome,
  type RetentionRun,
  RetentionScheduler,
  type RetentionSchedulerDeps,
  retentionPolicyFromConfig,
} from './retention-scheduler.ts';
export {
  RESTART_CLOSE_REASON,
  reconcileOnStartup,
  STALE_BROWSER_PROCESSES,
  type StartupReconcileDeps,
  type StartupReconcileResult,
} from './startup-reconcile.ts';
export { type IntervalScheduler, realIntervalScheduler } from './timer.ts';
