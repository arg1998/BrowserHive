/** @module infra/persistence/repositories/sessions — SQLite `SessionRepository` with the aggregated list view. */

import { type Kysely, sql } from 'kysely';
import type { ClosedReason } from '../../../ports/persistence/enums.ts';
import type {
  FacetCount,
  Page,
  SessionFacets,
  SessionListQuery,
  SessionSortKey,
} from '../../../ports/persistence/queries.ts';
import type {
  SessionListRow,
  SessionPatch,
  SessionRecord,
} from '../../../ports/persistence/records.ts';
import type {
  SessionDeleteResult,
  SessionRepository,
} from '../../../ports/persistence/sessions.ts';
import type { DB } from '../generated/db.d.ts';
import { sessionFromRow, sessionPatchToRow, sessionToRow } from '../mappers/session.ts';
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

const RESOURCE = 'sessions';

const SORT: Record<SessionSortKey, SortExpr> = {
  created_at: { expr: sql.ref('v.created_at'), nullValue: 0 },
  slug: { expr: sql.ref('v.slug'), nullValue: '' },
  channel: { expr: sql.ref('v.channel'), nullValue: '' },
  last_activity_at: { expr: sql.ref('v.last_activity_at'), nullValue: 0 },
  errors: { expr: sql.ref('v.errors'), nullValue: 0 },
  lease_expires_at: { expr: sql.ref('v.lease_expires_at'), nullValue: 0 },
  closed_at: { expr: sql.ref('v.closed_at'), nullValue: 0 },
  owner: { expr: sql.ref('v.owner'), nullValue: '' },
  persistence_mode: { expr: sql.ref('v.persistence_mode'), nullValue: '' },
  blocked: { expr: sql.ref('v.blocked'), nullValue: 0 },
};

function count(table: string, extra = ''): ReturnType<typeof sql<number>> {
  return sql<number>`(SELECT COUNT(*) FROM ${sql.table(table)} c WHERE c.session_id = s.session_id${sql.raw(extra)})`;
}

/** Sessions with their aggregates as an inline view aliased `v`. */
function view(db: Kysely<DB>) {
  return db
    .selectFrom('sessions as s')
    .selectAll('s')
    .select([
      count('tool_calls').as('tool_calls'),
      count('tool_calls', ' AND c.error_code IS NOT NULL').as('errors'),
      count('pages').as('pages'),
      count('blocked_requests').as('blocked'),
      count('operator_requests', " AND c.status = 'pending' AND c.kind = 'attention'").as(
        'attention_open',
      ),
      count('vault_access').as('vault_access'),
    ])
    .as('v');
}

/** The view with every column selected; filters and pagination are applied on top. */
function baseView(db: Kysely<DB>) {
  return db.selectFrom(view(db)).selectAll('v');
}

type ViewQuery = ReturnType<typeof baseView>;
type ViewRow = Awaited<ReturnType<ViewQuery['execute']>>[number];

function applyFilters(qb: ViewQuery, q: SessionListQuery): ViewQuery {
  let out = qb;
  const archived = q.view === 'archived' ? 'only' : (q.archived ?? 'exclude');
  if (archived === 'exclude') out = out.where('v.archived_at', 'is', null);
  if (archived === 'only') out = out.where('v.archived_at', 'is not', null);
  if (q.view === 'live') out = out.where('v.closed_at', 'is', null);
  if (q.view === 'closed') out = out.where('v.closed_at', 'is not', null);
  if (q.states !== undefined && q.states.length > 0)
    out = out.where('v.state', 'in', [...q.states]);
  if (q.owner !== undefined) out = out.where('v.owner', '=', q.owner);
  if (q.channels !== undefined && q.channels.length > 0)
    out = out.where('v.channel', 'in', [...q.channels]);
  if (q.persistenceModes !== undefined && q.persistenceModes.length > 0) {
    out = out.where('v.persistence_mode', 'in', [...q.persistenceModes]);
  }
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) =>
      eb.or([like(sql.ref('v.slug'), term), like(sql.ref('v.session_id'), term)]),
    );
  }
  if (q.since !== undefined) {
    const since = q.since;
    out = out.where((eb) => eb.or([eb('v.closed_at', 'is', null), eb('v.closed_at', '>=', since)]));
  }
  if (q.until !== undefined) out = out.where('v.created_at', '<=', q.until);
  return out;
}

function toListRow(row: ViewRow): SessionListRow {
  return {
    ...sessionFromRow(row),
    counts: {
      toolCalls: asNumber(row.tool_calls),
      errors: asNumber(row.errors),
      pages: asNumber(row.pages),
      blocked: asNumber(row.blocked),
      attentionOpen: asNumber(row.attention_open),
      vaultAccess: asNumber(row.vault_access),
    },
  };
}

/** SQLite implementation of {@link SessionRepository}. */
export class SqliteSessionRepository implements SessionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  #view(): ViewQuery {
    return baseView(this.#db);
  }

  async insert(record: SessionRecord): Promise<void> {
    await this.#db
      .insertInto('sessions')
      .values(sessionToRow(record))
      .onConflict((oc) => oc.column('session_id').doNothing())
      .execute();
  }

  async update(sessionId: string, patch: SessionPatch): Promise<boolean> {
    const row = sessionPatchToRow(patch);
    if (Object.keys(row).length === 0) return false;
    const result = await this.#db
      .updateTable('sessions')
      .set(row)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async get(sessionId: string): Promise<SessionListRow | null> {
    const row = await this.#view().where('v.session_id', '=', sessionId).executeTakeFirst();
    return row === undefined ? null : toListRow(row);
  }

  async list(query: SessionListQuery): Promise<Page<SessionListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'created_at';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(this.#view(), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('v.session_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('v.session_id', dir)
      .limit(limit + 1)
      .execute();
    const total = query.total === true ? await this.#count(query) : undefined;
    return toPage(
      RESOURCE,
      rows,
      limit,
      toListRow,
      (row) => ({ key: sortValue(row, sortName, spec.nullValue), id: row.session_id }),
      total,
    );
  }

  async #count(query: SessionListQuery): Promise<number> {
    const row = await applyFilters(this.#view(), query)
      .clearSelect()
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }

  async facets(query: SessionListQuery): Promise<SessionFacets> {
    const facet = async (
      column: 'owner' | 'channel' | 'persistence_mode' | 'state',
    ): Promise<FacetCount[]> => {
      const rows = await applyFilters(this.#view(), query)
        .clearSelect()
        .select([
          sql<string>`${sql.ref(`v.${column}`)}`.as('value'),
          sql<number>`COUNT(*)`.as('count'),
        ])
        .groupBy(sql.ref(`v.${column}`))
        .orderBy(sql.ref(`v.${column}`), 'asc')
        .execute();
      return rows.map((r) => ({ value: String(r.value), count: asNumber(r.count) }));
    };
    return {
      owners: await facet('owner'),
      channels: await facet('channel'),
      persistenceModes: await facet('persistence_mode'),
      states: await facet('state'),
    };
  }

  async markClosed(sessionId: string, at: number, reason: ClosedReason): Promise<boolean> {
    const state = reason === 'crash' ? 'crashed' : 'closed';
    const result = await this.#db
      .updateTable('sessions')
      .set({ closed_at: at, closed_reason: reason, state, lease_paused_at: null })
      .where('session_id', '=', sessionId)
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async archive(sessionId: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('sessions')
      .set({ archived_at: at })
      .where('session_id', '=', sessionId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async unarchive(sessionId: string): Promise<boolean> {
    const result = await this.#db
      .updateTable('sessions')
      .set({ archived_at: null })
      .where('session_id', '=', sessionId)
      .where('archived_at', 'is not', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async delete(sessionId: string, sessionDir: string): Promise<SessionDeleteResult> {
    const exists = await this.#db
      .selectFrom('sessions')
      .select('created_at')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (exists === undefined) return { rows: 0, paths: [] };
    const shots = await this.#db
      .selectFrom('screenshots')
      .select('path')
      .where('session_id', '=', sessionId)
      .execute();
    const before = asNumber(
      (await sql<{ n: number }>`SELECT total_changes() AS n`.execute(this.#db)).rows[0]?.n,
    );
    await this.#db.deleteFrom('sessions').where('session_id', '=', sessionId).execute();
    const after = asNumber(
      (await sql<{ n: number }>`SELECT total_changes() AS n`.execute(this.#db)).rows[0]?.n,
    );
    const outside = shots.map((s) => s.path).filter((p) => !p.startsWith(sessionDir));
    const enqueuedAt = exists.created_at;
    await this.#db
      .insertInto('artifact_outbox')
      .values([
        { kind: 'session_dir', path: sessionDir, session_id: sessionId, enqueued_at: enqueuedAt },
        ...outside.map((path) => ({
          kind: 'screenshot',
          path,
          session_id: sessionId,
          enqueued_at: enqueuedAt,
        })),
      ])
      .execute();
    return { rows: after - before, paths: [sessionDir, ...outside] };
  }

  async reconcileOpen(at: number, reason: ClosedReason): Promise<number> {
    const state = reason === 'crash' ? 'crashed' : 'closed';
    const result = await this.#db
      .updateTable('sessions')
      .set({ closed_at: at, closed_reason: reason, state, lease_paused_at: null })
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

function sortValue(row: ViewRow, key: SessionSortKey, nullValue: number | string): number | string {
  const value = row[key];
  return value === null ? nullValue : value;
}
