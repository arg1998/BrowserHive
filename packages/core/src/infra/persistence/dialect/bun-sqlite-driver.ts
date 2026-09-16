/** @module infra/persistence/dialect/bun-sqlite-driver — Kysely `Driver` over one `bun:sqlite` connection (D-04). */

import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { sqlOperation, withSpan } from './spans.ts';

/** Options of {@link BunSqliteDriver}. */
export interface BunSqliteDriverOptions {
  /** The open connection; the driver never closes it (the owner does). */
  readonly database: Database;
  /** Emit a `db.query` span per statement (debug sampling, `--otelVerbose`). Default false. */
  readonly querySpans?: boolean;
  /** Prepared statements kept per connection (LRU). Default 256. */
  readonly statementCacheSize?: number;
}

/** Normalises a Kysely parameter into a `bun:sqlite` binding. */
function toBinding(value: unknown): SQLQueryBindings {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.getTime();
  throw new AppError(
    'INTERNAL_ERROR',
    { ref: 'db-binding' },
    { message: `unsupported sqlite binding type ${typeof value}` },
  );
}

/** One connection: prepares (and caches) statements, distinguishes readers by column count. */
class BunSqliteConnection implements DatabaseConnection {
  readonly #db: Database;
  readonly #cache = new Map<string, Statement>();
  readonly #cacheSize: number;
  readonly #querySpans: boolean;

  constructor(db: Database, cacheSize: number, querySpans: boolean) {
    this.#db = db;
    this.#cacheSize = cacheSize;
    this.#querySpans = querySpans;
  }

  #statement(sql: string): Statement {
    const cached = this.#cache.get(sql);
    if (cached !== undefined) {
      // Refresh LRU position.
      this.#cache.delete(sql);
      this.#cache.set(sql, cached);
      return cached;
    }
    const stmt = this.#db.prepare(sql);
    this.#cache.set(sql, stmt);
    if (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) {
        this.#cache.get(oldest.value)?.finalize();
        this.#cache.delete(oldest.value);
      }
    }
    return stmt;
  }

  #run<R>(sql: string, parameters: readonly unknown[]): QueryResult<R> {
    const stmt = this.#statement(sql);
    const bindings = parameters.map(toBinding);
    if (stmt.columnNames.length > 0) {
      // Narrowing the compiler cannot see: rows are typed by the Kysely query that compiled `sql`.
      const rows = stmt.all(...bindings) as R[];
      return { rows };
    }
    const { changes, lastInsertRowid } = stmt.run(...bindings);
    return {
      insertId: BigInt(lastInsertRowid),
      numAffectedRows: BigInt(changes),
      rows: [],
    };
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    if (!this.#querySpans) return Promise.resolve(this.#run<R>(sql, parameters));
    return Promise.resolve(
      withSpan('db.query', { 'db.operation': sqlOperation(sql) }, (span) => {
        const result = this.#run<R>(sql, parameters);
        span.setAttribute('browserhive.rows', result.rows.length);
        return result;
      }),
    );
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.#statement(sql);
    for (const row of stmt.iterate(...parameters.map(toBinding))) {
      // Same contract as `executeQuery`: rows are typed by the query that produced them.
      yield { rows: [row as R] };
    }
  }

  /** Finalizes cached statements. */
  release(): void {
    for (const stmt of this.#cache.values()) stmt.finalize();
    this.#cache.clear();
  }
}

/**
 * Single-connection driver. Kysely serialises access through its connection mutex because the
 * SQLite adapter reports `supportsMultipleConnections = false`; transactions use `BEGIN IMMEDIATE`
 * so the write lock is taken up front and `busy_timeout` applies at the start.
 */
export class BunSqliteDriver implements Driver {
  readonly #options: BunSqliteDriverOptions;
  #connection: BunSqliteConnection | undefined;

  constructor(options: BunSqliteDriverOptions) {
    this.#options = options;
  }

  init(): Promise<void> {
    this.#connection = new BunSqliteConnection(
      this.#options.database,
      this.#options.statementCacheSize ?? 256,
      this.#options.querySpans ?? false,
    );
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    if (this.#connection === undefined) {
      throw new AppError(
        'INTERNAL_ERROR',
        { ref: 'db-driver' },
        { message: 'driver not initialised' },
      );
    }
    return Promise.resolve(this.#connection);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.#connection?.release();
    this.#connection = undefined;
    return Promise.resolve();
  }
}
