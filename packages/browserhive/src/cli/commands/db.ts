/** @module cli/commands/db — `db status | backup [--out] | restore <file> [--yes] | migrate [--dryRun]` (spec 08 §7.1, D-04) */
import type { CommandContext, DatabaseStatus } from '../deps.ts';
import { EXIT, type ExitCode } from '../invocation.ts';
import {
  databaseExists,
  databasePath,
  formatTimestamp,
  refuseWhileLocked,
  size,
  withStorage,
} from './common.ts';

function missingDatabase(context: CommandContext, dataDir: string): ExitCode {
  context.out.diagnostic(
    `browserhive: no database at ${databasePath(dataDir)}. Run 'browserhive init' to create it.`,
  );
  return EXIT.fatal;
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`;
}

/** JSON form of `db status` (snake_case like every machine output). */
function statusJson(status: DatabaseStatus): Record<string, unknown> {
  return {
    path: status.path,
    user_version: status.userVersion,
    min_reader_version: status.minReaderVersion,
    application_id: status.applicationId,
    binary_schema_version: status.binarySchemaVersion,
    pending_migrations: status.pending.map((m) => ({ version: m.version, name: m.name })),
    size_bytes: status.sizeBytes,
    page_count: status.pageCount,
    page_size: status.pageSize,
    last_backup:
      status.lastBackup === null
        ? null
        : {
            path: status.lastBackup.path,
            size_bytes: status.lastBackup.sizeBytes,
            created_at: Math.round(status.lastBackup.mtimeMs),
          },
    backups_count: status.backupsCount,
    quick_check: { ok: status.quickCheck.ok, messages: status.quickCheck.messages },
  };
}

/**
 * Runs `db status`.
 *
 * @returns 0, or 1 when the quick check fails or the database is missing.
 */
export async function runDbStatus(
  context: CommandContext,
  dataDir: string,
  json: boolean,
): Promise<ExitCode> {
  const { deps, out } = context;
  if (!(await databaseExists(deps, dataDir))) return missingDatabase(context, dataDir);
  const status = await withStorage(
    deps,
    { dataDir, readOnly: true, migrate: false, owner: 'db status' },
    (storage) => storage.status(),
  );
  if (json) {
    out.json(statusJson(status));
    return status.quickCheck.ok ? EXIT.ok : EXIT.fatal;
  }
  const pending =
    status.pending.length === 0
      ? 'none'
      : status.pending.map((m) => `v${m.version} ${m.name}`).join(', ');
  const backup =
    status.lastBackup === null
      ? `none (${status.backupsCount} backups)`
      : `${status.lastBackup.path} (${size(status.lastBackup.sizeBytes)}, ${formatTimestamp(
          status.lastBackup.mtimeMs,
        )}; ${status.backupsCount} backups)`;
  const appIdOk = status.applicationId === deps.applicationId;
  out.table(
    [{ header: 'FIELD' }, { header: 'VALUE' }],
    [
      ['path', status.path],
      ['user_version', `${status.userVersion} (this binary: ${status.binarySchemaVersion})`],
      ['min_reader_version', String(status.minReaderVersion)],
      ['application_id', `${hex(status.applicationId)}${appIdOk ? ' (BHIV)' : ' (unexpected)'}`],
      ['pending migrations', pending],
      ['size', `${size(status.sizeBytes)} (${status.pageCount} pages × ${status.pageSize} B)`],
      ['last backup', backup],
      [
        'integrity',
        status.quickCheck.ok
          ? 'ok'
          : `FAILED: ${status.quickCheck.messages.slice(0, 3).join('; ')}`,
      ],
    ],
  );
  return status.quickCheck.ok ? EXIT.ok : EXIT.fatal;
}

/**
 * Runs `db backup [--out path]` (`VACUUM INTO`; safe while a server runs).
 *
 * @returns 0 on success.
 */
export async function runDbBackup(
  context: CommandContext,
  dataDir: string,
  outPath: string | null,
): Promise<ExitCode> {
  const { deps, out } = context;
  if (!(await databaseExists(deps, dataDir))) return missingDatabase(context, dataDir);
  if (outPath !== null && (await deps.fs.stat(outPath)) !== null) {
    out.diagnostic(`browserhive: ${outPath} already exists; refusing to overwrite it.`);
    return EXIT.fatal;
  }
  const written = await withStorage(
    deps,
    { dataDir, readOnly: true, migrate: false, owner: 'db backup' },
    (storage) => storage.backup(outPath),
  );
  const bytes = (await deps.fs.stat(written))?.sizeBytes ?? 0;
  out.status('ok', `backup written: ${written}`, size(bytes));
  return EXIT.ok;
}

/**
 * Runs `db restore <file> [--yes]`: refuses while the lock is held, verifies `application_id`
 * and the reader window, backs up the current database, then replaces it.
 *
 * @returns 0 on success, 1 on refusal or failure, 3 when a server holds the data dir.
 */
export async function runDbRestore(
  context: CommandContext,
  dataDir: string,
  file: string,
  yes: boolean,
): Promise<ExitCode> {
  const { deps, out } = context;
  const locked = refuseWhileLocked(context, dataDir, 'restore the database');
  if (locked !== null) return locked;
  const source = await deps.fs.stat(file);
  if (source === null || !source.isFile) {
    out.diagnostic(`browserhive: cannot read ${file}: no such file.`);
    return EXIT.fatal;
  }
  const info = await deps.inspectDatabase(file);
  if (info === null || info.applicationId !== deps.applicationId) {
    const found =
      info === null ? 'not a SQLite database' : `application_id ${hex(info.applicationId)}`;
    out.diagnostic(
      `browserhive: ${file} is not a BrowserHive database (${found}); nothing was changed.`,
    );
    return EXIT.fatal;
  }
  if (info.minReaderVersion > deps.schemaVersion) {
    out.diagnostic(
      `browserhive: [DB_NEWER_THAN_BINARY] ${file} has schema v${info.userVersion} (readable from v${info.minReaderVersion}); this binary reads up to v${deps.schemaVersion}. Upgrade BrowserHive first.`,
    );
    return EXIT.policy;
  }
  const target = databasePath(dataDir);
  if (!yes) {
    if (deps.prompt === null) {
      out.diagnostic(
        'browserhive: refusing to replace the database without confirmation, and stdin is not a terminal.',
      );
      out.diagnostic('Run it in a terminal, or pass --yes if you are scripting this deliberately.');
      return EXIT.fatal;
    }
    const answer = await deps.prompt(`Replace ${target} with ${file}? Type YES to continue: `);
    if (answer.trim() !== 'YES') {
      out.line('Aborted — nothing was changed.');
      return EXIT.fatal;
    }
  }
  const lock = deps.lock.acquire(dataDir, 'db restore');
  try {
    if (await databaseExists(deps, dataDir)) {
      const backup = await withStorage(
        deps,
        { dataDir, readOnly: true, migrate: false, owner: 'db restore' },
        (storage) => storage.backup(null),
      );
      out.status('ok', `current database backed up: ${backup}`);
    }
    for (const suffix of ['', '-wal', '-shm']) await deps.fs.unlink(`${target}${suffix}`);
    await deps.copyFile(file, target);
  } finally {
    lock.release();
  }
  out.status('ok', `restored ${file}`, `schema v${info.userVersion} → ${target}`);
  if (info.userVersion < deps.schemaVersion) {
    out.line(
      `Schema v${info.userVersion} is older than this binary (v${deps.schemaVersion}); migrations apply on the next start or with 'browserhive db migrate'.`,
    );
  }
  return EXIT.ok;
}

/**
 * Runs `db migrate [--dryRun]`.
 *
 * @returns 0 on success.
 */
export async function runDbMigrate(
  context: CommandContext,
  dataDir: string,
  dryRun: boolean,
  json: boolean,
): Promise<ExitCode> {
  const { deps, out } = context;
  if (dryRun) {
    if (!(await databaseExists(deps, dataDir))) return missingDatabase(context, dataDir);
    const pending = await withStorage(
      deps,
      { dataDir, readOnly: true, migrate: false, owner: 'db migrate' },
      (storage) => storage.pending(),
    );
    if (json) {
      out.json({
        dry_run: true,
        pending: pending.map((m) => ({ version: m.version, name: m.name })),
      });
      return EXIT.ok;
    }
    if (pending.length === 0) out.status('ok', 'database is up to date', 'nothing to apply');
    else {
      out.line(`${pending.length} pending migration(s) (dry run, nothing applied):`);
      for (const m of pending) out.line(`  v${m.version}  ${m.name}`);
    }
    return EXIT.ok;
  }
  const report = await withStorage(
    deps,
    { dataDir, readOnly: false, migrate: true, owner: 'db migrate' },
    (storage) => storage.migrate(),
  );
  if (json) {
    out.json({
      dry_run: false,
      from: report.from,
      to: report.to,
      applied: report.applied.map((m) => ({
        version: m.version,
        name: m.name,
        duration_ms: m.durationMs,
      })),
      backup_path: report.backupPath,
    });
    return EXIT.ok;
  }
  if (report.applied.length === 0) {
    out.status('ok', 'database is up to date', `schema v${report.to}`);
    return EXIT.ok;
  }
  for (const m of report.applied) out.status('ok', `v${m.version} ${m.name}`, `${m.durationMs} ms`);
  out.line(
    `Migrated schema v${report.from} → v${report.to}.${
      report.backupPath === null ? '' : ` Backup: ${report.backupPath}`
    }`,
  );
  return EXIT.ok;
}
