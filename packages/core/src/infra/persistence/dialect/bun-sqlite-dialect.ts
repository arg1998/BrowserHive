/** @module infra/persistence/dialect/bun-sqlite-dialect — Kysely dialect wiring `bun:sqlite` to the stock SQLite adapter/compiler/introspector. */

import type { Database } from 'bun:sqlite';
import {
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import { BunSqliteDriver, type BunSqliteDriverOptions } from './bun-sqlite-driver.ts';

/** Options of {@link BunSqliteDialect}; see {@link BunSqliteDriverOptions}. */
export type BunSqliteDialectOptions = BunSqliteDriverOptions;

/**
 * The owned dialect (D-04). Only the driver is ours: SQL compilation, introspection and adapter
 * behaviour are Kysely's SQLite implementations, so generated types and query semantics match
 * upstream exactly.
 */
export class BunSqliteDialect implements Dialect {
  readonly #options: BunSqliteDialectOptions;

  constructor(options: BunSqliteDialectOptions) {
    this.#options = options;
  }

  /** The underlying `bun:sqlite` handle (for PRAGMAs and `exec`). */
  get database(): Database {
    return this.#options.database;
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Kysely's `Dialect` contract declares `Kysely<any>` here.
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
