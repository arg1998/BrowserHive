/** @module infra/persistence/log-rows — SQLite `LogRepository`: batched inserts into `logs` for the durable log sink (spec 10 §4.3). */

import type { Kysely } from 'kysely';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { LogRepository } from '../../ports/persistence/operations.ts';
import type { LogRecordRow } from '../../ports/persistence/records.ts';
import type { DB } from './generated/db.d.ts';
import { toJsonOrNull } from './mappers/codec.ts';

/** A `logs` row before SQLite assigns `seq`. */
export type NewLogRecordRow = Omit<LogRecordRow, 'seq'>;

/** Rows per `INSERT` statement (SQLite binds ≤ 32 766 parameters; 11 columns per row). */
export const LOG_INSERT_CHUNK = 500;

/**
 * SQLite implementation of {@link LogRepository}. Like every repository it is bound to one Kysely
 * handle; the write queue uses the transaction-bound instance (`repos.logs`), because a query on
 * the root handle issued from inside a drain transaction would wait for that transaction.
 */
export class SqliteLogRepository implements LogRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  /** Inserts `rows` in chunks; an empty batch is a no-op. */
  async insertMany(rows: readonly NewLogRecordRow[]): Promise<void> {
    for (let start = 0; start < rows.length; start += LOG_INSERT_CHUNK) {
      const chunk = rows.slice(start, start + LOG_INSERT_CHUNK);
      await this.#db
        .insertInto('logs')
        .values(
          chunk.map((row) => ({
            ts: row.ts,
            level: row.level,
            module: row.module,
            msg: row.msg,
            trace_id: row.traceId,
            span_id: row.spanId,
            request_id: row.requestId,
            session_id: row.sessionId,
            principal: row.principal,
            fields_json: fieldsJson(row.fields),
          })),
        )
        .execute();
    }
  }

  /** Rows currently stored (diagnostics, tests). */
  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('logs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }
}

function fieldsJson(fields: JsonObject | null): string | null {
  return toJsonOrNull(fields);
}
