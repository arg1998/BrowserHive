/** @module app/maintenance/purge — `browserhive purge` data: inventory of the data dir (DB row counts via a read-only open, directory sizes) and deletion of chosen targets; the CLI drives prompts (D-24). */

import { join } from 'node:path';
import type { FileSystem } from '../../ports/file-system.ts';
import type { PurgeInventory } from '../../ports/persistence/maintenance.ts';

/** Database file name inside the data dir (D-24). */
export const DATABASE_FILE = 'browserhive.db';
/** SQLite side files removed with the database. */
export const DATABASE_SIDE_FILES: readonly string[] = ['-wal', '-shm'];
/** Purgeable directories, in display order. */
export const PURGE_DIRECTORIES = [
  'sessions',
  'auth-states',
  'uploads',
  'backups',
  'admin',
] as const;

/** One purgeable directory. */
export type PurgeDirectory = (typeof PURGE_DIRECTORIES)[number];
/** Anything `purge` can delete. */
export type PurgeTarget = 'database' | PurgeDirectory;
/** Every target, in display order. */
export const PURGE_TARGETS: readonly PurgeTarget[] = ['database', ...PURGE_DIRECTORIES];

/**
 * Opens the database read-only without migrating and returns its inventory. Composition
 * implements it with `openDatabase({ readOnly: true })` + `SqliteMaintenanceService.inventory()`
 * (app may not import infra).
 */
export type ReadOnlyInventoryFn = (databasePath: string) => Promise<PurgeInventory>;

/** Dependencies of {@link purgeInventory} and {@link purge}. */
export interface PurgeDeps {
  readonly fs: Pick<FileSystem, 'stat' | 'readdir' | 'rm' | 'unlink'>;
  readonly readInventory: ReadOnlyInventoryFn;
}

/** Database section of the inventory. */
export interface DatabaseInventory {
  readonly path: string;
  /** DB + WAL + SHM bytes. */
  readonly sizeBytes: number;
  readonly schemaVersion: number | null;
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  /** Set when the file exists but could not be read (corrupt, newer schema, locked). */
  readonly error: string | null;
}

/** One directory section of the inventory. */
export interface DirectoryInventory {
  readonly name: PurgeDirectory;
  readonly path: string;
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly files: number;
}

/** Everything `browserhive purge` shows before asking. */
export interface DataDirInventory {
  readonly dataDir: string;
  readonly database: DatabaseInventory | null;
  readonly directories: readonly DirectoryInventory[];
  readonly totalBytes: number;
}

/** One display row (CLI table / `--json`). */
export interface InventoryRow {
  readonly target: PurgeTarget;
  readonly path: string;
  readonly sizeBytes: number;
  /** `12 tables, 4 031 rows`, `37 files`, `missing`, or the read error. */
  readonly detail: string;
}

/**
 * Builds the inventory. Never migrates; a DB that cannot be opened still reports its size.
 *
 * @returns The data dir inventory.
 */
export async function purgeInventory(dataDir: string, deps: PurgeDeps): Promise<DataDirInventory> {
  const dbPath = join(dataDir, DATABASE_FILE);
  let database: DatabaseInventory | null = null;
  const dbStat = await deps.fs.stat(dbPath);
  if (dbStat !== null) {
    let sizeBytes = dbStat.sizeBytes;
    for (const suffix of DATABASE_SIDE_FILES) {
      sizeBytes += (await deps.fs.stat(`${dbPath}${suffix}`))?.sizeBytes ?? 0;
    }
    try {
      const inv = await deps.readInventory(dbPath);
      database = {
        path: dbPath,
        sizeBytes,
        schemaVersion: inv.schemaVersion,
        tables: inv.tables,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unreadable database';
      database = { path: dbPath, sizeBytes, schemaVersion: null, tables: [], error: message };
    }
  }
  const directories: DirectoryInventory[] = [];
  for (const name of PURGE_DIRECTORIES) {
    const path = join(dataDir, name);
    const stat = await deps.fs.stat(path);
    if (stat === null || !stat.isDirectory) {
      directories.push({ name, path, exists: false, sizeBytes: 0, files: 0 });
      continue;
    }
    const usage = await directoryUsage(path, deps.fs);
    directories.push({ name, path, exists: true, ...usage });
  }
  const totalBytes = (database?.sizeBytes ?? 0) + directories.reduce((n, d) => n + d.sizeBytes, 0);
  return { dataDir, database, directories, totalBytes };
}

/**
 * Flattens an inventory into display rows, one per target.
 *
 * @returns Rows in {@link PURGE_TARGETS} order.
 */
export function inventoryRows(inventory: DataDirInventory): readonly InventoryRow[] {
  const db = inventory.database;
  const rows: InventoryRow[] = [
    {
      target: 'database',
      path: db?.path ?? join(inventory.dataDir, DATABASE_FILE),
      sizeBytes: db?.sizeBytes ?? 0,
      detail:
        db === null
          ? 'missing'
          : db.error !== null
            ? db.error
            : `${db.tables.length} tables, ${db.tables.reduce((n, t) => n + t.rows, 0)} rows`,
    },
  ];
  for (const dir of inventory.directories) {
    rows.push({
      target: dir.name,
      path: dir.path,
      sizeBytes: dir.sizeBytes,
      detail: dir.exists ? `${dir.files} files` : 'missing',
    });
  }
  return rows;
}

/** Options for {@link purge}. */
export interface PurgeOptions {
  /** Purge every target regardless of `targets`. */
  readonly all?: boolean;
}

/**
 * Deletes the chosen targets (the server must not be running; the CLI checks and prompts).
 *
 * @returns The paths removed, in order.
 */
export async function purge(
  dataDir: string,
  targets: readonly PurgeTarget[],
  deps: PurgeDeps,
  options: PurgeOptions = {},
): Promise<readonly string[]> {
  const chosen =
    options.all === true ? PURGE_TARGETS : PURGE_TARGETS.filter((t) => targets.includes(t));
  const removed: string[] = [];
  for (const target of chosen) {
    if (target === 'database') {
      const dbPath = join(dataDir, DATABASE_FILE);
      for (const path of [dbPath, ...DATABASE_SIDE_FILES.map((s) => `${dbPath}${s}`)]) {
        if ((await deps.fs.stat(path)) === null) continue;
        await deps.fs.unlink(path);
        removed.push(path);
      }
      continue;
    }
    const path = join(dataDir, target);
    if ((await deps.fs.stat(path)) === null) continue;
    await deps.fs.rm(path, { recursive: true });
    removed.push(path);
  }
  return removed;
}

async function directoryUsage(
  root: string,
  fs: Pick<FileSystem, 'stat' | 'readdir'>,
): Promise<{ sizeBytes: number; files: number }> {
  let sizeBytes = 0;
  let files = 0;
  const stack = [root];
  for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
    for (const name of await fs.readdir(path)) {
      const child = join(path, name);
      const stat = await fs.stat(child);
      if (stat === null) continue;
      if (stat.isDirectory) stack.push(child);
      else {
        files += 1;
        sizeBytes += stat.sizeBytes;
      }
    }
  }
  return { sizeBytes, files };
}
