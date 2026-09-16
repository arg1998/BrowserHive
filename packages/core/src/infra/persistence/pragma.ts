/** @module infra/persistence/pragma — typed PRAGMA reads/writes over the raw `bun:sqlite` handle. */

import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';

const scalarRow = z.record(z.string(), z.union([z.number(), z.string(), z.bigint(), z.null()]));

/** Reads a scalar PRAGMA (`PRAGMA <name>`) as a number; throws `INTERNAL_ERROR` when absent. */
export function pragmaNumber(db: Database, name: string): number {
  const value = pragmaScalar(db, name);
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new AppError(
    'INTERNAL_ERROR',
    { ref: 'pragma' },
    { message: `pragma ${name} is not numeric` },
  );
}

/** Reads a scalar PRAGMA as a string (numbers are stringified). */
export function pragmaString(db: Database, name: string): string {
  return String(pragmaScalar(db, name));
}

function pragmaScalar(db: Database, name: string): number | string | bigint | null {
  const row = db.query(`PRAGMA ${name}`).get();
  const parsed = scalarRow.safeParse(row);
  if (!parsed.success) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'pragma' },
      { message: `pragma ${name} returned no row` },
    );
  }
  const first = Object.values(parsed.data)[0];
  return first === undefined ? null : first;
}

/** Sets a PRAGMA to a literal value (`PRAGMA <name>=<value>`); values are never user input. */
export function setPragma(db: Database, name: string, value: string | number): void {
  db.exec(`PRAGMA ${name}=${value}`);
}

/** Every row of a multi-row PRAGMA (`integrity_check`, `quick_check`) as strings. */
export function pragmaLines(db: Database, name: string): string[] {
  const rows = db.query(`PRAGMA ${name}`).all();
  return rows.map((row) => {
    const parsed = scalarRow.safeParse(row);
    const first = parsed.success ? Object.values(parsed.data)[0] : undefined;
    return first === undefined || first === null ? '' : String(first);
  });
}

/** True when a table exists in `sqlite_master`. */
export function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  const parsed = z.object({ n: z.number() }).safeParse(row);
  return parsed.success && parsed.data.n > 0;
}
