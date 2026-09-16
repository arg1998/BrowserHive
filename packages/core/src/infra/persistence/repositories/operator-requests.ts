/** @module infra/persistence/repositories/operator-requests — SQLite `OperatorRequestRepository` and `OperatorActionRepository`. */

import { type Kysely, sql } from 'kysely';
import type { OperatorRequestKind } from '../../../ports/persistence/enums.ts';
import type { OperatorActionRepository } from '../../../ports/persistence/operations.ts';
import type {
  OperatorRequestFacets,
  OperatorRequestListRow,
  OperatorRequestRepository,
  OperatorRequestResolution,
} from '../../../ports/persistence/operator-requests.ts';
import type {
  AuditListQuery,
  FacetCount,
  OperatorRequestListQuery,
  Page,
} from '../../../ports/persistence/queries.ts';
import type {
  NewOperatorAction,
  NewOperatorRequest,
  OperatorActionRecord,
} from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import {
  operatorActionFromRow,
  operatorActionToRow,
  operatorRequestFromRow,
  operatorRequestToRow,
} from '../mappers/operator-request.ts';
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

const RESOURCE = 'operator_requests';

type SortName = NonNullable<OperatorRequestListQuery['sort']>;

const SORT: Record<SortName, SortExpr> = {
  created_at: { expr: sql.ref('r.created_at'), nullValue: 0 },
  resolved_at: { expr: sql.ref('r.resolved_at'), nullValue: 0 },
  waited_ms: { expr: sql`(r.resolved_at - r.created_at)`, nullValue: 0 },
};

function base(db: Kysely<DB>) {
  return db
    .selectFrom('operator_requests as r')
    .leftJoin('sessions as s', 's.session_id', 'r.session_id')
    .selectAll('r')
    .select('s.slug as session_slug');
}

type BaseQuery = ReturnType<typeof base>;
type Row = Awaited<ReturnType<BaseQuery['execute']>>[number];

function toListRow(row: Row): OperatorRequestListRow {
  const record = operatorRequestFromRow(row);
  return {
    ...record,
    sessionSlug: row.session_slug,
    waitedMs: record.resolvedAt === null ? null : record.resolvedAt - record.createdAt,
  };
}

function applyFilters(qb: BaseQuery, q: OperatorRequestListQuery): BaseQuery {
  let out = qb;
  if (q.kind !== undefined) out = out.where('r.kind', '=', q.kind);
  if (q.statuses !== undefined && q.statuses.length > 0)
    out = out.where('r.status', 'in', [...q.statuses]);
  if (q.modes !== undefined && q.modes.length > 0) out = out.where('r.mode', 'in', [...q.modes]);
  if (q.sessionId !== undefined) out = out.where('r.session_id', '=', q.sessionId);
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) =>
      eb.or([like(sql.ref('r.reason'), term), like(sql.ref('r.session_id'), term)]),
    );
  }
  if (q.since !== undefined) out = out.where('r.created_at', '>=', q.since);
  if (q.until !== undefined) out = out.where('r.created_at', '<=', q.until);
  return out;
}

function sortValue(row: Row, key: SortName): number {
  switch (key) {
    case 'created_at':
      return row.created_at;
    case 'resolved_at':
      return row.resolved_at ?? 0;
    case 'waited_ms':
      return row.resolved_at === null ? 0 : row.resolved_at - row.created_at;
  }
}

/** SQLite implementation of {@link OperatorRequestRepository}. */
export class SqliteOperatorRequestRepository implements OperatorRequestRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: NewOperatorRequest): Promise<void> {
    await this.#db
      .insertInto('operator_requests')
      .values(operatorRequestToRow(record))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async resolve(requestId: string, resolution: OperatorRequestResolution): Promise<boolean> {
    const result = await this.#db
      .updateTable('operator_requests')
      .set({
        status: resolution.status,
        resolved_at: resolution.at,
        message: resolution.message ?? null,
        resolved_by: resolution.resolvedBy ?? null,
        resolution_reason: resolution.reason ?? null,
      })
      .where('request_id', '=', requestId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async open(kind?: OperatorRequestKind): Promise<readonly OperatorRequestListRow[]> {
    let qb = base(this.#db).where('r.status', '=', 'pending');
    if (kind !== undefined) qb = qb.where('r.kind', '=', kind);
    const rows = await qb.orderBy('r.created_at', 'asc').orderBy('r.request_id', 'asc').execute();
    return rows.map(toListRow);
  }

  async get(requestId: string): Promise<OperatorRequestListRow | null> {
    const row = await base(this.#db).where('r.request_id', '=', requestId).executeTakeFirst();
    return row === undefined ? null : toListRow(row);
  }

  async getByIdempotencyKey(
    sessionId: string,
    key: string,
  ): Promise<OperatorRequestListRow | null> {
    const row = await base(this.#db)
      .where('r.session_id', '=', sessionId)
      .where('r.idempotency_key', '=', key)
      .executeTakeFirst();
    return row === undefined ? null : toListRow(row);
  }

  async listHistory(query: OperatorRequestListQuery): Promise<Page<OperatorRequestListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'created_at';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(base(this.#db), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('r.request_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('r.request_id', dir)
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
      (row) => ({ key: sortValue(row, sortName), id: row.request_id }),
      total,
    );
  }

  async facets(query: OperatorRequestListQuery): Promise<OperatorRequestFacets> {
    const { statuses, modes, ...rest } = query;
    const count = async (
      column: 'status' | 'mode',
      q: OperatorRequestListQuery,
    ): Promise<FacetCount[]> => {
      const rows = await applyFilters(base(this.#db), q)
        .clearSelect()
        .select([sql.ref<string | null>(`r.${column}`).as('value'), sql<number>`COUNT(*)`.as('n')])
        .groupBy(`r.${column}`)
        .orderBy(`r.${column}`, 'asc')
        .execute();
      return rows.flatMap((r) =>
        r.value === null ? [] : [{ value: String(r.value), count: asNumber(r.n) }],
      );
    };
    return {
      statuses: await count('status', { ...rest, ...(modes !== undefined && { modes }) }),
      modes: await count('mode', { ...rest, ...(statuses !== undefined && { statuses }) }),
    };
  }

  async countOpen(kind?: OperatorRequestKind): Promise<number> {
    let qb = this.#db
      .selectFrom('operator_requests')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('status', '=', 'pending');
    if (kind !== undefined) qb = qb.where('kind', '=', kind);
    return asNumber((await qb.executeTakeFirst())?.n);
  }
}

const ACTIONS = 'operator_actions';

/** SQLite implementation of {@link OperatorActionRepository}. */
export class SqliteOperatorActionRepository implements OperatorActionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async append(action: NewOperatorAction): Promise<number> {
    const result = await this.#db
      .insertInto('operator_actions')
      .values(operatorActionToRow(action))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows !== undefined && result.numInsertedOrUpdatedRows > 0n) {
      return Number(result.insertId ?? 0n);
    }
    const existing = await this.#db
      .selectFrom('operator_actions')
      .select('seq')
      .where('event_id', '=', action.eventId)
      .executeTakeFirst();
    return existing?.seq ?? 0;
  }

  async list(query: AuditListQuery): Promise<Page<OperatorActionRecord>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(ACTIONS, query.cursor);
    let qb = this.#db.selectFrom('operator_actions').selectAll();
    if (query.principalId !== undefined) qb = qb.where('principal_id', '=', query.principalId);
    if (query.types !== undefined && query.types.length > 0)
      qb = qb.where('action', 'in', [...query.types]);
    if (query.since !== undefined) qb = qb.where('occurred_at', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('occurred_at', '<=', query.until);
    if (cursor !== null) qb = qb.where('seq', dir === 'desc' ? '<' : '>', Number(cursor.key));
    const rows = await qb
      .orderBy('seq', dir)
      .limit(limit + 1)
      .execute();
    return toPage(ACTIONS, rows, limit, operatorActionFromRow, (row) => ({
      key: row.seq,
      id: row.event_id,
    }));
  }
}
