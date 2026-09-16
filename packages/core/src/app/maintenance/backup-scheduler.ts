/** @module app/maintenance/backup-scheduler — on-demand database backups and the backup listing (D-24 `backups/`); periodic only when an interval is supplied (no config key exists yet). */

import { join } from 'node:path';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { FileSystem } from '../../ports/file-system.ts';
import type { Logger } from '../../ports/logger.ts';
import type { MaintenanceService } from '../../ports/persistence/maintenance.ts';
import { type IntervalScheduler, realIntervalScheduler } from './timer.ts';

/** File names the migration runner and `backup()` produce: `browserhive-v<N>-<stamp>.db`. */
export const BACKUP_FILE_RE = /^browserhive-v(\d+)-.+\.db$/;

/** One backup file. */
export interface BackupEntry {
  readonly path: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
  readonly createdAt: number;
}

/** Dependencies of {@link BackupScheduler}. */
export interface BackupSchedulerDeps {
  readonly maintenance: Pick<MaintenanceService, 'backup'>;
  readonly fs: Pick<FileSystem, 'readdir' | 'stat'>;
  readonly backupsDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** When set, `start()` takes a backup on this interval. */
  readonly intervalMs?: number;
  readonly scheduler?: IntervalScheduler;
}

/** Backups: `backupNow()`, `listBackups()`, `lastBackupAt()`, optional periodic timer. */
export class BackupScheduler {
  private cancel: (() => void) | undefined;
  private last: number | null = null;
  private running: Promise<string> | undefined;
  private readonly log: Logger;

  constructor(private readonly deps: BackupSchedulerDeps) {
    this.log = deps.logger.child({ module: 'persistence.backup' });
  }

  /** Starts the periodic timer when `intervalMs` is configured; otherwise a no-op. */
  start(): void {
    if (this.cancel !== undefined || this.deps.intervalMs === undefined) return;
    this.cancel = (this.deps.scheduler ?? realIntervalScheduler).setInterval(() => {
      void this.backupNow().catch((err: unknown) => {
        this.log.error('backup failed', { err: serializeError(err) });
      });
    }, this.deps.intervalMs);
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /**
   * Takes a `VACUUM INTO` backup (concurrent calls share one).
   *
   * @returns The backup path.
   * @throws `AppError` from the maintenance service.
   */
  backupNow(): Promise<string> {
    if (this.running !== undefined) return this.running;
    const run = (async () => {
      try {
        const path = await this.deps.maintenance.backup();
        this.last = this.deps.clock.now();
        this.log.info('backup written', { path });
        return path;
      } finally {
        this.running = undefined;
      }
    })();
    this.running = run;
    return run;
  }

  /**
   * Backup files, newest first.
   *
   * @returns Entries parsed from the backups directory (unrelated files skipped).
   */
  async listBackups(): Promise<readonly BackupEntry[]> {
    const entries: BackupEntry[] = [];
    for (const name of await this.deps.fs.readdir(this.deps.backupsDir)) {
      const match = BACKUP_FILE_RE.exec(name);
      if (match === null) continue;
      const path = join(this.deps.backupsDir, name);
      const stat = await this.deps.fs.stat(path);
      if (stat === null || !stat.isFile) continue;
      entries.push({
        path,
        name,
        schemaVersion: Number(match[1]),
        sizeBytes: stat.sizeBytes,
        // Filesystem mtimes are fractional; the wire contract is integer epoch ms.
        createdAt: Math.floor(stat.mtimeMs),
      });
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }

  /** Time of the last backup taken by this process, or `null`. */
  lastBackupAt(): number | null {
    return this.last;
  }

  /**
   * Refreshes {@link lastBackupAt} from the newest file on disk (call once at boot).
   *
   * @returns The newest backup time, or `null`.
   */
  async refreshLastBackup(): Promise<number | null> {
    const newest = (await this.listBackups())[0];
    if (newest !== undefined && (this.last === null || newest.createdAt > this.last)) {
      this.last = newest.createdAt;
    }
    return this.last;
  }
}
