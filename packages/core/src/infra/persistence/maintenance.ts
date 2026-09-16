/** @module infra/persistence/maintenance — SQLite `MaintenanceService`: migrate, backup, retention, vacuum, inventory, integrity. */

import { statSync } from 'node:fs';
import { sql } from 'kysely';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  IntegrityResult,
  MaintenanceService,
  MigrationResult,
  PurgeInventory,
  RetentionPolicy,
  RetentionResult,
} from '../../ports/persistence/maintenance.ts';
import type { WriteQueue } from '../../ports/persistence/write-queue.ts';
import { BACKUPS_KEEP, createBackup, listBackups, pruneBackups } from './migrations/backups.ts';
import { MIGRATIONS, TABLES } from './migrations/index.ts';
import type { Migration } from './migrations/migration.ts';
import { runMigrations } from './migrations/runner.ts';
import type { DatabaseHandle } from './open.ts';
import { pragmaLines, pragmaNumber } from './pragma.ts';
import { asNumber } from './repositories/common.ts';
import { sweepRetention } from './retention.ts';

/** Options of {@link SqliteMaintenanceService}. */
export interface MaintenanceOptions {
  readonly handle: DatabaseHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly appVersion: string;
  /** Drained before backups and sweeps so they see every write. */
  readonly queue?: WriteQueue;
  /** Migration list override (tests). */
  readonly migrations?: readonly Migration[];
}

/** SQLite implementation of {@link MaintenanceService}. */
export class SqliteMaintenanceService implements MaintenanceService {
  readonly #o: MaintenanceOptions;

  constructor(options: MaintenanceOptions) {
    this.#o = options;
  }

  async #drain(): Promise<void> {
    if (this.#o.queue !== undefined) await this.#o.queue.drain();
  }

  async migrate(): Promise<MigrationResult> {
    await this.#drain();
    const { handle } = this.#o;
    return runMigrations({
      raw: handle.raw,
      path: handle.path,
      migrations: this.#o.migrations ?? MIGRATIONS,
      appVersion: this.#o.appVersion,
      clock: this.#o.clock,
      logger: this.#o.logger,
      backupsDir: handle.path === ':memory:' ? null : handle.backupsDir,
    });
  }

  async backup(): Promise<string> {
    await this.#drain();
    const { handle } = this.#o;
    if (handle.path === ':memory:') {
      throw new AppError('DB_OPEN_FAILED', {
        path: handle.path,
        reason: 'cannot back up an in-memory database',
      });
    }
    const version = pragmaNumber(handle.raw, 'user_version');
    const path = createBackup(handle.raw, handle.backupsDir, version, this.#o.clock.now());
    pruneBackups(handle.backupsDir, BACKUPS_KEEP);
    this.#o.logger.info('backup created', { path });
    return path;
  }

  async retentionSweep(policy: RetentionPolicy): Promise<RetentionResult> {
    await this.#drain();
    return sweepRetention(
      {
        db: this.#o.handle.db,
        clock: this.#o.clock,
        logger: this.#o.logger,
        databaseSize: () => this.#size(),
        incrementalVacuum: (pages) => this.incrementalVacuum(pages),
      },
      policy,
    );
  }

  async incrementalVacuum(pages = 256): Promise<void> {
    await sql`PRAGMA incremental_vacuum(${sql.raw(String(Math.max(1, Math.floor(pages))))})`.execute(
      this.#o.handle.db,
    );
  }

  async inventory(): Promise<PurgeInventory> {
    await this.#drain();
    const { handle } = this.#o;
    const tables: { table: string; rows: number }[] = [];
    for (const table of TABLES) {
      const result = await sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM ${sql.table(table)}`.execute(handle.db);
      tables.push({ table, rows: asNumber(result.rows[0]?.n) });
    }
    let sizeBytes = await this.#size();
    if (handle.path !== ':memory:') {
      try {
        sizeBytes = statSync(handle.path).size;
      } catch {
        // Fall back to page_count * page_size.
      }
    }
    return {
      path: handle.path,
      sizeBytes,
      schemaVersion: pragmaNumber(handle.raw, 'user_version'),
      tables,
      backups: listBackups(handle.backupsDir).map((b) => ({
        path: b.path,
        sizeBytes: b.sizeBytes,
      })),
    };
  }

  async integrityCheck(): Promise<IntegrityResult> {
    await this.#drain();
    const messages = pragmaLines(this.#o.handle.raw, 'integrity_check');
    return { ok: messages.length === 1 && messages[0] === 'ok', messages };
  }

  async #size(): Promise<number> {
    const result = await sql<{
      n: number;
    }>`SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS n`.execute(
      this.#o.handle.db,
    );
    return asNumber(result.rows[0]?.n);
  }
}
