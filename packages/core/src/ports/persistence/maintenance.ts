/** @module ports/persistence/maintenance — migrations, backups, retention and integrity operations. */

/** Retention policy (spec 03 §7.1); durations in days, sizes in bytes. */
export interface RetentionPolicy {
  /** Telemetry window (`retentionDays`, ≥ 1). */
  readonly retentionDays: number;
  /** Telemetry byte cap over the DB file (`retentionBytes`). */
  readonly retentionBytes: number;
  /** Audit window (`auditRetentionDays`). */
  readonly auditRetentionDays: number;
  /** Days a read or dismissed notification is kept (default 30). */
  readonly notificationSeenDays?: number;
  /** Days an untouched notification is kept (default 90). */
  readonly notificationDays?: number;
  /** Pages reclaimed per `incremental_vacuum` chunk (default 256). */
  readonly vacuumChunkPages?: number;
}

/** One failed retention item (never aborts the sweep). */
export interface RetentionFailure {
  readonly step: string;
  readonly message: string;
}

/** Outcome of one retention pass. */
export interface RetentionResult {
  readonly startedAt: number;
  readonly durationMs: number;
  /** Rows deleted per table. */
  readonly prunedRows: Readonly<Record<string, number>>;
  /** Files handed to the artifact outbox. */
  readonly artifactsEnqueued: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly failures: readonly RetentionFailure[];
}

/** Outcome of a migration run. */
export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly {
    readonly version: number;
    readonly name: string;
    readonly durationMs: number;
  }[];
  readonly backupPath: string | null;
}

/** Row counts and sizes for `browserhive purge`. */
export interface PurgeInventory {
  readonly path: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  readonly backups: readonly { readonly path: string; readonly sizeBytes: number }[];
}

/** Result of `PRAGMA integrity_check`. */
export interface IntegrityResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
}

/** Maintenance operations; every method throws `AppError` on failure except `retentionSweep`. */
export interface MaintenanceService {
  /** Applies pending migrations (no-op when at head). */
  migrate(): Promise<MigrationResult>;
  /** `VACUUM INTO` a timestamped backup under the backups directory; prunes to the last 5. */
  backup(): Promise<string>;
  /** One retention pass per spec 03 §7.1; never throws, per-item failures are reported. */
  retentionSweep(policy: RetentionPolicy): Promise<RetentionResult>;
  /** Reclaims up to `pages` free pages (`PRAGMA incremental_vacuum(N)`). */
  incrementalVacuum(pages?: number): Promise<void>;
  /** Row counts per table plus file and backup sizes. */
  inventory(): Promise<PurgeInventory>;
  /** Full `PRAGMA integrity_check`. */
  integrityCheck(): Promise<IntegrityResult>;
}
