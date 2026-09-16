/** @module composition/phases/open-storage — phase 3: D-24 data dir (0700), the lock file, `openDatabase` (backups, migrations, compat window), unit of work, write queue, analytics, maintenance, durable log sink. */

import {
  openDatabase,
  pruneBackups,
  SqliteAnalyticsQueries,
  SqliteMaintenanceService,
  SqliteUnitOfWork,
  SqliteWriteQueue,
} from '@browserhive/core/persistence';
import { createLogPersistSink } from '@browserhive/core/runtime';
import { type BootContext, part } from '../context.ts';
import { ensureDataDir } from '../data-dir.ts';
import { acquireDataDirLock } from '../lock-file.ts';
import type { PhaseHandle } from '../unwind.ts';

/** Phase `open-storage`. Errors (`DATA_DIR_LOCKED`, `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`, …) propagate typed. */
export async function openStoragePhase(ctx: BootContext): Promise<PhaseHandle> {
  ctx.health.enter('open-storage');
  const { logger } = part(ctx.observability, 'observability');
  const log = logger.child({ module: 'persistence' });
  const layout = ensureDataDir(ctx.config.dataDir);
  const lock = acquireDataDirLock({
    dataDir: layout.root,
    owner: 'serve',
    now: ctx.clock.now(),
  });
  let handle: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    handle = await openDatabase({
      path: layout.database,
      dataDir: layout.root,
      backupsDir: layout.backups,
      appVersion: ctx.input.appVersion,
      clock: ctx.clock,
      logger,
      querySpans: ctx.config.otel && ctx.config.otelVerbose,
    });
  } catch (err) {
    ctx.health.check('db', 'failed');
    lock.release();
    throw err;
  }
  const opened = handle;
  if (opened.migrationsApplied.length > 0) {
    log.info('database migrated', {
      schema_version: opened.schemaVersion,
      migrations: opened.migrationsApplied.length,
      backup: opened.backupPath,
    });
  }
  pruneBackups(layout.backups, ctx.config.backupsKeep);
  const uow = new SqliteUnitOfWork(opened.db);
  const queue = new SqliteWriteQueue({ uow, logger });
  const analytics = new SqliteAnalyticsQueries(opened.db, uow.repos, queue);
  const maintenance = new SqliteMaintenanceService({
    handle: opened,
    clock: ctx.clock,
    logger,
    appVersion: ctx.input.appVersion,
    queue,
  });
  const persistSink = createLogPersistSink({ queue, level: ctx.config.logPersist });
  if (persistSink !== null) logger.addSink(persistSink);
  ctx.health.check('db', 'ok');
  ctx.storage = {
    layout,
    lock,
    handle: opened,
    uow,
    queue,
    analytics,
    maintenance,
    persistSink,
    sqliteVersion: sqliteVersionOf(opened.raw),
  };

  return {
    async stop() {
      if (persistSink !== null) {
        await persistSink.close();
        logger.removeSink(persistSink.name);
      }
      await queue.close();
      await opened.close();
      lock.release();
    },
  };
}

/** `select sqlite_version()` over the raw handle; `unknown` when the query fails. */
export function sqliteVersionOf(raw: { query(sql: string): { get(): unknown } }): string {
  try {
    const row = raw.query('select sqlite_version() as v').get();
    if (typeof row === 'object' && row !== null && 'v' in row && typeof row.v === 'string') {
      return row.v;
    }
  } catch {
    // Reported as unknown on /system.
  }
  return 'unknown';
}
