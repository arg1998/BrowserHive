/** @module infra/persistence/repositories/tool-calls — SQLite `ToolCallRepository`. */

import { type Kysely, sql } from 'kysely';
import type { Page, ToolCallListQuery } from '../../../ports/persistence/queries.ts';
import type { ToolCallRecord } from '../../../ports/persistence/records.ts';
import type { ToolCallListRow, ToolCallRepository } from '../../../ports/persistence/tool-calls.ts';
import type { DB } from '../generated/db.d.ts';
import { toolCallFromRow, toolCallToRow } from '../mappers/facts.ts';
import {
  asNumber,
  clampLimit,
  decodeCursor,
  keysetWhere,
  like,
  type SortExpr,
  sortKey,
  toPage,
} from './common.ts';

const RESOURCE = 'tool_calls';

const SORT: Record<'ts' | 'duration_ms', SortExpr> = {
  ts: { expr: sql.ref('t.ts'), nullValue: 0 },
  duration_ms: { expr: sql.ref('t.duration_ms'), nullValue: 0 },
};

function base(db: Kysely<DB>) {
  return db
    .selectFrom('tool_calls as t')
    .leftJoin('sessions as s', 's.session_id', 't.session_id')
    .leftJoin('screenshots as sc', 'sc.event_id', 't.event_id')
    .selectAll('t')
    .select([
      's.slug as session_slug',
      sql<number>`(sc.event_id IS NOT NULL)`.as('has_screenshot'),
    ]);
}

type BaseQuery = ReturnType<typeof base>;
type Row = Awaited<ReturnType<BaseQuery['execute']>>[number];

function applyFilters(qb: BaseQuery, q: ToolCallListQuery): BaseQuery {
  let out = qb;
  if (q.sessionId !== undefined) out = out.where('t.session_id', '=', q.sessionId);
  if (q.hasSession !== undefined) {
    out = out.where('t.session_id', q.hasSession ? 'is not' : 'is', null);
  }
  if (q.tools !== undefined && q.tools.length > 0) out = out.where('t.tool', 'in', [...q.tools]);
  if (q.ok !== undefined) out = out.where('t.ok', '=', q.ok ? 1 : 0);
  if (q.hasError !== undefined) {
    out = out.where('t.error_code', q.hasError ? 'is not' : 'is', null);
  }
  if (q.errorCodes !== undefined && q.errorCodes.length > 0)
    out = out.where('t.error_code', 'in', [...q.errorCodes]);
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) =>
      eb.or([
        like(sql.ref('t.tool'), term),
        like(sql.ref('t.error_code'), term),
        like(sql.ref('t.error_message'), term),
        like(sql.ref('t.tab_id'), term),
      ]),
    );
  }
  if (q.since !== undefined) out = out.where('t.ts', '>=', q.since);
  if (q.until !== undefined) out = out.where('t.ts', '<=', q.until);
  return out;
}

function toListRow(row: Row): ToolCallListRow {
  return {
    ...toolCallFromRow(row),
    sessionSlug: row.session_slug,
    hasScreenshot: asNumber(row.has_screenshot) !== 0,
  };
}

/** SQLite implementation of {@link ToolCallRepository}. */
export class SqliteToolCallRepository implements ToolCallRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: ToolCallRecord): Promise<void> {
    await this.#db
      .insertInto('tool_calls')
      .values(toolCallToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async get(eventId: string): Promise<ToolCallListRow | null> {
    const row = await base(this.#db).where('t.event_id', '=', eventId).executeTakeFirst();
    return row === undefined ? null : toListRow(row);
  }

  listBySession(sessionId: string, query: ToolCallListQuery): Promise<Page<ToolCallListRow>> {
    return this.listAll({ ...query, sessionId });
  }

  async listAll(query: ToolCallListQuery): Promise<Page<ToolCallListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'ts';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(base(this.#db), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('t.event_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('t.event_id', dir)
      .limit(limit + 1)
      .execute();
    let total: number | undefined;
    if (query.total === true) {
      const n = await applyFilters(base(this.#db), query)
        .clearSelect()
        .select(sql<number>`COUNT(*)`.as('n'))
        .executeTakeFirst();
      total = asNumber(n?.n);
    }
    return toPage(
      RESOURCE,
      rows,
      limit,
      toListRow,
      (row) => ({ key: row[sortName], id: row.event_id }),
      total,
    );
  }
}
