/** @module infra/persistence/repositories/common — limits, keyset cursors, LIKE escaping and page assembly shared by repositories (spec 03 §5). */

import { type RawBuilder, type SqlBool, sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { Page, SortDir } from '../../../ports/persistence/queries.ts';

/** Default and maximum page sizes (spec 03 §5). */
export const DEFAULT_LIMIT = 50;
/** Maximum page size. */
export const MAX_LIMIT = 500;

/** Clamps a requested page size into `1..max`, defaulting when absent. */
export function clampLimit(
  limit: number | undefined,
  fallback = DEFAULT_LIMIT,
  max = MAX_LIMIT,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

/** Decoded keyset position: the sort-key value and the tie-breaking id of the last row seen. */
export interface Cursor {
  readonly key: number | string;
  readonly id: string;
}

const cursorSchema = z.object({
  r: z.string(),
  k: z.union([z.number(), z.string()]),
  id: z.string(),
});

/** Encodes a cursor for `resource` as base64url JSON. */
export function encodeCursor(resource: string, cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ r: resource, k: cursor.key, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a cursor minted for `resource`; `null`/`undefined` means the first page. A malformed
 * cursor or one from another resource throws `VALIDATION_FAILED` (spec 03 §5).
 */
export function decodeCursor(resource: string, cursor: string | null | undefined): Cursor | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    raw = undefined;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.r !== resource) {
    throw new AppError('VALIDATION_FAILED', {
      issues: [
        { path: 'cursor', message: `cursor is not valid for ${resource}`, code: 'invalid_cursor' },
      ],
    });
  }
  return { key: parsed.data.k, id: parsed.data.id };
}

/** `%term%` with `%`, `_` and `\` escaped; pair with `ESCAPE '\'` (see {@link like}). */
export function likePattern(term: string): string {
  return `%${term.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** `<expr> LIKE ? ESCAPE '\'` fragment. */
export function like(expr: RawBuilder<unknown>, term: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`${expr} LIKE ${likePattern(term)} ESCAPE '\\'`;
}

/** Sort expression with the value substituted for NULL so row-value comparison stays total. */
export interface SortExpr {
  readonly expr: RawBuilder<unknown>;
  readonly nullValue: number | string;
}

/** `COALESCE(expr, nullValue)` as an expression usable in ORDER BY and keyset comparison. */
export function sortKey(spec: SortExpr): RawBuilder<unknown> {
  return sql`COALESCE(${spec.expr}, ${spec.nullValue})`;
}

/** Keyset predicate: `(sortKey, id) < (k, id)` for descending, `>` for ascending. */
export function keysetWhere(
  spec: SortExpr,
  idExpr: RawBuilder<unknown>,
  dir: SortDir,
  cursor: Cursor,
): RawBuilder<SqlBool> {
  const op = dir === 'desc' ? sql.raw('<') : sql.raw('>');
  return sql<SqlBool>`(${sortKey(spec)}, ${idExpr}) ${op} (${cursor.key}, ${cursor.id})`;
}

/**
 * Turns `limit + 1` fetched rows into a page: maps the first `limit`, and mints the next cursor
 * from the last mapped row when more rows exist.
 */
export function toPage<Row, Item>(
  resource: string,
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
  cursorOf: (row: Row) => Cursor,
  total?: number,
): Page<Item> {
  const slice = rows.slice(0, limit);
  const items = slice.map(map);
  const last = rows.length > limit ? slice[slice.length - 1] : undefined;
  return {
    items,
    nextCursor: last === undefined ? null : encodeCursor(resource, cursorOf(last)),
    ...(total !== undefined && { total }),
  };
}

/** Coerces a COUNT/SUM result (`number | string | bigint | null`) to a number. */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}
