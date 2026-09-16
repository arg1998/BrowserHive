/** @module cli/production/storage — adapts the composition's `openStorageForCli` (SQLite handle, maintenance, auth) to the CLI's `CliStorage`, plus SQLite header inspection for `db restore` */
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuthService, Clock, Logger } from '@browserhive/core/runtime';
import { z } from 'zod';
import type {
  CliStorage,
  DatabaseFileInfo,
  DatabaseStatus,
  MigrationRef,
  OpenStorageInput,
  TokenRow,
} from '../deps.ts';

type Composition = typeof import('../../composition/index.ts');
type Persistence = typeof import('@browserhive/core/persistence');
type ComposedStorage = Awaited<ReturnType<Composition['openStorageForCli']>>;
type Issuer = Parameters<AuthService['createToken']>[0];

/** The CLI acts as the seeded operator when it issues or revokes tokens (audit `principal_id`). */
const CLI_ISSUER: Issuer = Object.freeze({
  subject: 'admin',
  kind: 'operator',
  display: 'browserhive CLI',
  auth: Object.freeze({ method: 'local' as const }),
  scopes: [],
  tenantId: null,
  mustChangePassword: false,
});

const PragmaRow = z.record(z.string(), z.union([z.number(), z.string(), z.null()]));

function pragma(storage: ComposedStorage, name: string): number {
  const row = PragmaRow.parse(storage.handle.raw.query(`PRAGMA ${name}`).get() ?? {});
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function quickCheck(storage: ComposedStorage): { ok: boolean; messages: string[] } {
  const rows = z.array(PragmaRow).parse(storage.handle.raw.query('PRAGMA quick_check').all());
  const messages = rows.map((row) => String(Object.values(row)[0] ?? ''));
  return {
    ok: messages.length === 1 && messages[0] === 'ok',
    messages: messages[0] === 'ok' ? [] : messages,
  };
}

function pendingOf(persistence: Persistence, version: number): MigrationRef[] {
  return persistence.MIGRATIONS.filter((m) => m.version > version).map((m) => ({
    version: m.version,
    name: m.name,
  }));
}

/**
 * Opens storage through the composition root and wraps it.
 *
 * @returns The CLI storage.
 * @throws `DATA_DIR_LOCKED`, `DB_OPEN_FAILED`, `DB_CORRUPT`, `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`.
 */
export async function openCliStorage(
  input: OpenStorageInput,
  options: { readonly logger: Logger; readonly appVersion: string; readonly clock: Clock },
): Promise<CliStorage> {
  const composition: Composition = await import('../../composition/index.ts');
  const persistence: Persistence = await import('@browserhive/core/persistence');
  const storage = await composition.openStorageForCli({
    dataDir: input.dataDir,
    readOnly: input.readOnly,
    migrate: input.migrate,
    logger: options.logger,
    appVersion: options.appVersion,
    command: input.owner,
  });
  const { handle } = storage;
  const tokenRow = (row: Awaited<ReturnType<AuthService['listTokens']>>[number]): TokenRow => ({
    credentialId: row.credentialId,
    publicPrefix: row.publicPrefix,
    ownerKind: row.ownerKind,
    subject: row.subject,
    scopes: row.scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
  });
  return {
    status: async (): Promise<DatabaseStatus> => {
      const backups = persistence.listBackups(handle.backupsDir);
      const newest = backups[0];
      const pageCount = pragma(storage, 'page_count');
      const pageSize = pragma(storage, 'page_size');
      return {
        path: handle.path,
        exists: true,
        userVersion: handle.schemaVersion,
        minReaderVersion: handle.minReaderVersion,
        applicationId: pragma(storage, 'application_id'),
        binarySchemaVersion: persistence.SCHEMA_VERSION,
        pending: pendingOf(persistence, handle.schemaVersion),
        sizeBytes: pageCount * pageSize,
        pageCount,
        pageSize,
        lastBackup:
          newest === undefined
            ? null
            : { path: newest.path, sizeBytes: newest.sizeBytes, mtimeMs: newest.mtimeMs },
        backupsCount: backups.length,
        quickCheck: quickCheck(storage),
      };
    },
    pending: async () => pendingOf(persistence, handle.schemaVersion),
    migrate: async () => {
      // A writable open already ran the migration runner (with its pre-migration backup).
      const applied = handle.migrationsApplied;
      const first = applied[0];
      return {
        from: first === undefined ? handle.schemaVersion : first.version - 1,
        to: handle.schemaVersion,
        applied: applied.map((m) => ({
          version: m.version,
          name: m.name,
          durationMs: m.durationMs,
        })),
        backupPath: handle.backupPath,
      };
    },
    backup: async (out) => {
      if (!input.readOnly) {
        if (out === null) return storage.maintenance.backup();
        await mkdir(dirname(out), { recursive: true, mode: 0o700 });
        handle.raw.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
        return out;
      }
      // `VACUUM INTO` opens its target with the source connection's flags, so a read-only
      // connection (the only kind allowed next to a running server) cannot write it. Serialize the
      // current snapshot instead: consistent, WAL content included, same header and application_id.
      const at = options.clock.now();
      const target =
        out ??
        join(
          handle.backupsDir,
          `browserhive-v${handle.schemaVersion}-${new Date(at).toISOString().replaceAll(/[-:.]/g, '')}.db`,
        );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, handle.raw.serialize(), { mode: 0o600, flag: 'wx' });
      if (out === null) persistence.pruneBackups(handle.backupsDir, persistence.BACKUPS_KEEP);
      return target;
    },
    tableCounts: async () => (await storage.maintenance.inventory()).tables,
    openSessionCount: async () => {
      const row = PragmaRow.parse(
        handle.raw.query('SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL').get() ?? {},
      );
      return typeof row['n'] === 'number' ? row['n'] : 0;
    },
    resetPassword: async () => {
      const result = await storage.auth.resetPassword();
      return { password: result.password.reveal(), credentialsPath: result.credentialsPath };
    },
    listTokens: async () => (await storage.auth.listTokens()).map(tokenRow),
    createToken: async ({ principal, expiresInMs }) => {
      const created = await storage.auth.createToken(CLI_ISSUER, {
        ownerKind: 'agent',
        display: principal,
        subject: principal,
        ...(expiresInMs !== null && { expiresInMs }),
      });
      return {
        credentialId: created.credentialId,
        principalId: created.principalId,
        publicPrefix: created.publicPrefix,
        token: created.token.reveal(),
        expiresAt: created.expiresAt,
      };
    },
    revokeToken: async (credentialId) => {
      await storage.auth.revokeToken(CLI_ISSUER, credentialId);
    },
    close: () => storage.close(),
  };
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/**
 * Reads the SQLite header of a file: `user_version` (offset 60) and `application_id` (offset 68),
 * big-endian. `min_reader_version` lives in the `meta` table; it is read through a read-only open
 * only when the file is newer than this binary.
 *
 * @returns The header facts, or `null` when the file is not a SQLite database.
 */
export async function inspectDatabaseFile(
  path: string,
  options: { readonly logger: Logger; readonly appVersion: string },
): Promise<DatabaseFileInfo | null> {
  const header = Buffer.alloc(100);
  const file = await open(path, 'r');
  try {
    const { bytesRead } = await file.read(header, 0, 100, 0);
    if (bytesRead < 100 || header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) return null;
  } finally {
    await file.close();
  }
  const userVersion = header.readUInt32BE(60);
  const applicationId = header.readUInt32BE(68);
  const persistence: Persistence = await import('@browserhive/core/persistence');
  if (userVersion <= persistence.SCHEMA_VERSION) {
    // Readable by construction: min_reader_version <= user_version <= SCHEMA_VERSION.
    return { applicationId, userVersion, minReaderVersion: userVersion };
  }
  const { createSystemClock } = await import('@browserhive/core/runtime');
  try {
    const handle = await persistence.openDatabase({
      path,
      dataDir: dirname(path),
      appVersion: options.appVersion,
      clock: createSystemClock(),
      logger: options.logger,
      readOnly: true,
    });
    const minReaderVersion = handle.minReaderVersion;
    await handle.close();
    return { applicationId, userVersion, minReaderVersion };
  } catch {
    // Outside the compatibility window (or unreadable): treat the file's own version as the floor.
    return { applicationId, userVersion, minReaderVersion: userVersion };
  }
}
