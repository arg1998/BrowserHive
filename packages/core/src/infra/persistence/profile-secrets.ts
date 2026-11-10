/** @module infra/persistence/profile-secrets — saved passwords and autofill data in a template's Chromium profile (spec 13 §3.1): found before a host start, cleared on the operator's request while the browser is stopped. Chromium's own SQLite files, read here because SQLite stays in persistence. */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Chromium's saved-password databases and their table. */
const LOGIN_FILES = ['Login Data', 'Login Data For Account'] as const;
/** Chromium's autofill database and the tables that hold what it would fill. */
const WEB_DATA_FILE = 'Web Data';
const AUTOFILL_TABLES = [
  'autofill',
  'credit_cards',
  'autofill_profiles',
  'local_addresses',
  'addresses',
  'local_ibans',
] as const;

/** The tables of `db` among `names`. */
function tablesOf(db: Database, names: readonly string[]): string[] {
  const rows = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const present = new Set(rows.map((r) => r.name));
  return names.filter((n) => present.has(n));
}

/** Runs `use` on the database at `path` when it exists; a file Chromium holds or that is not SQLite reads as empty. */
function withDb<T>(path: string, readonly: boolean, fallback: T, use: (db: Database) => T): T {
  if (!existsSync(path)) return fallback;
  let db: Database | null = null;
  try {
    db = new Database(path, readonly ? { readonly: true } : { readwrite: true });
    return use(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

function hasRows(db: Database, tables: readonly string[]): boolean {
  return tablesOf(db, tables).some(
    (t) => (db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t}"`).get()?.n ?? 0) > 0,
  );
}

function clearTables(db: Database, tables: readonly string[]): void {
  for (const t of tablesOf(db, tables)) db.run(`DELETE FROM "${t}"`);
}

/**
 * True when the profile under `userDataDir` (its `Default` profile) holds saved passwords or
 * autofill data. Read before the browser opens the profile.
 */
export function profileHasSecrets(userDataDir: string): boolean {
  const dir = join(userDataDir, 'Default');
  const logins = LOGIN_FILES.some((file) =>
    withDb(join(dir, file), true, false, (db) => hasRows(db, ['logins'])),
  );
  return (
    logins || withDb(join(dir, WEB_DATA_FILE), true, false, (db) => hasRows(db, AUTOFILL_TABLES))
  );
}

/** Empties saved passwords and autofill data of the profile; only while no browser has it open. */
export function clearProfileSecrets(userDataDir: string): void {
  const dir = join(userDataDir, 'Default');
  for (const file of LOGIN_FILES) {
    withDb(join(dir, file), false, undefined, (db) => clearTables(db, ['logins']));
  }
  withDb(join(dir, WEB_DATA_FILE), false, undefined, (db) => clearTables(db, AUTOFILL_TABLES));
}
