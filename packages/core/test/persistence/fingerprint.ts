/** @module test/persistence/fingerprint — pragma-normalised schema snapshot (D-04 drift check). */

import type { Database } from 'bun:sqlite';

/** Normalised description of one table. */
export interface TableFingerprint {
  readonly name: string;
  readonly withoutRowid: boolean;
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
    readonly columns: readonly Record<string, unknown>[];
  }[];
  readonly foreignKeys: readonly Record<string, unknown>[];
}

/** The whole schema: tables sorted by name plus the SQL of every trigger and view. */
export interface SchemaFingerprint {
  readonly tables: readonly TableFingerprint[];
  readonly triggers: readonly { readonly name: string; readonly sql: string }[];
  readonly views: readonly { readonly name: string; readonly sql: string }[];
}

function rows(db: Database, sql: string, ...params: string[]): Record<string, unknown>[] {
  return db
    .query(sql)
    .all(...params)
    .map((row) => {
      const out: Record<string, unknown> = {};
      if (row !== null && typeof row === 'object') {
        for (const [k, v] of Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
      }
      return out;
    });
}

/** Computes the fingerprint of the open database (system tables excluded). */
export function schemaFingerprint(db: Database): SchemaFingerprint {
  const master = rows(
    db,
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables: TableFingerprint[] = [];
  for (const entry of master.filter((m) => m['type'] === 'table')) {
    const name = String(entry['name']);
    const sql = String(entry['sql'] ?? '');
    const indexes = rows(db, `PRAGMA index_list(${JSON.stringify(name)})`)
      .filter((ix) => String(ix['origin']) === 'c')
      .map((ix) => ({
        name: String(ix['name']),
        unique: Number(ix['unique']),
        partial: Number(ix['partial']),
        columns: rows(db, `PRAGMA index_xinfo(${JSON.stringify(String(ix['name']))})`),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    tables.push({
      name,
      withoutRowid: /WITHOUT ROWID/i.test(sql),
      columns: rows(db, `PRAGMA table_xinfo(${JSON.stringify(name)})`),
      indexes,
      foreignKeys: rows(db, `PRAGMA foreign_key_list(${JSON.stringify(name)})`),
    });
  }
  const named = (type: string) =>
    master
      .filter((m) => m['type'] === type)
      .map((m) => ({ name: String(m['name']), sql: String(m['sql'] ?? '') }));
  return { tables, triggers: named('trigger'), views: named('view') };
}
