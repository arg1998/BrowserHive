/** @module infra/persistence/repositories/event-log — SQLite `EventLogRepository` (monotonic `seq`). */

import { type Kysely, sql } from 'kysely';
import type { EventLogRepository } from '../../../ports/persistence/event-log.ts';
import type { EventRecord, NewEvent } from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import { eventFromRow, eventToRow } from '../mappers/facts.ts';
import { asNumber, clampLimit } from './common.ts';

/** SQLite implementation of {@link EventLogRepository}. */
export class SqliteEventLogRepository implements EventLogRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async append(event: NewEvent): Promise<number> {
    const result = await this.#db
      .insertInto('events')
      .values(eventToRow(event))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows !== undefined && result.numInsertedOrUpdatedRows > 0n) {
      return Number(result.insertId ?? 0n);
    }
    const existing = await this.#db
      .selectFrom('events')
      .select('seq')
      .where('event_id', '=', event.eventId)
      .executeTakeFirst();
    return existing?.seq ?? 0;
  }

  async replay(
    afterSeq: number,
    limit: number,
    sessionId?: string,
  ): Promise<readonly EventRecord[]> {
    let qb = this.#db.selectFrom('events').selectAll().where('seq', '>', afterSeq);
    if (sessionId !== undefined) qb = qb.where('session_id', '=', sessionId);
    const rows = await qb
      .orderBy('seq', 'asc')
      .limit(clampLimit(limit, 100, 1000))
      .execute();
    return rows.map(eventFromRow);
  }

  async head(): Promise<number> {
    const row = await this.#db
      .selectFrom('events')
      .select(sql<number>`COALESCE(MAX(seq), 0)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}
