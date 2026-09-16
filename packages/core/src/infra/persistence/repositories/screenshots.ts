/** @module infra/persistence/repositories/screenshots — SQLite `ScreenshotRepository`. */

import { type Kysely, sql } from 'kysely';
import type { Page, ScreenshotListQuery } from '../../../ports/persistence/queries.ts';
import type { ScreenshotRecord } from '../../../ports/persistence/records.ts';
import type {
  ScreenshotListRow,
  ScreenshotRepository,
} from '../../../ports/persistence/screenshots.ts';
import type { DB } from '../generated/db.d.ts';
import { screenshotFromRow, screenshotToRow } from '../mappers/facts.ts';
import { clampLimit, decodeCursor, keysetWhere, type SortExpr, sortKey, toPage } from './common.ts';

const RESOURCE = 'screenshots';
const TS: SortExpr = { expr: sql.ref('sc.ts'), nullValue: 0 };

function base(db: Kysely<DB>) {
  return db
    .selectFrom('screenshots as sc')
    .leftJoin('tool_calls as t', 't.event_id', 'sc.event_id')
    .selectAll('sc')
    .select('t.tool as tool');
}

type Row = Awaited<ReturnType<ReturnType<typeof base>['execute']>>[number];

function toListRow(row: Row): ScreenshotListRow {
  return { ...screenshotFromRow(row), tool: row.tool };
}

/** SQLite implementation of {@link ScreenshotRepository}. */
export class SqliteScreenshotRepository implements ScreenshotRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: ScreenshotRecord): Promise<void> {
    await this.#db
      .insertInto('screenshots')
      .values(screenshotToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async get(eventId: string): Promise<ScreenshotListRow | null> {
    const row = await base(this.#db).where('sc.event_id', '=', eventId).executeTakeFirst();
    return row === undefined ? null : toListRow(row);
  }

  async listBySession(
    sessionId: string,
    query: ScreenshotListQuery,
  ): Promise<Page<ScreenshotListRow>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = base(this.#db).where('sc.session_id', '=', sessionId);
    if (query.kinds !== undefined && query.kinds.length > 0)
      qb = qb.where('sc.kind', 'in', [...query.kinds]);
    if (query.since !== undefined) qb = qb.where('sc.ts', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('sc.ts', '<=', query.until);
    if (cursor !== null) qb = qb.where(keysetWhere(TS, sql.ref('sc.event_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(TS), dir)
      .orderBy('sc.event_id', dir)
      .limit(limit + 1)
      .execute();
    return toPage(RESOURCE, rows, limit, toListRow, (row) => ({ key: row.ts, id: row.event_id }));
  }
}
