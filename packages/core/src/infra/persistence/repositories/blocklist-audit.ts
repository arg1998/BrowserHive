/** @module infra/persistence/repositories/blocklist-audit — SQLite `BlocklistAuditRepository`. */

import { type Kysely, sql } from 'kysely';
import type {
  BlockedRequestListRow,
  BlocklistAuditRepository,
} from '../../../ports/persistence/blocklist-audit.ts';
import type {
  BlockedRequestListQuery,
  BlockedStats,
  Page,
  TimeWindow,
} from '../../../ports/persistence/queries.ts';
import type { BlockedRequestRecord } from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import { blockedRequestFromRow, blockedRequestToRow } from '../mappers/facts.ts';
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

const RESOURCE = 'blocked_requests';

type SortName = NonNullable<BlockedRequestListQuery['sort']>;

const SORT: Record<SortName, SortExpr> = {
  ts: { expr: sql.ref('b.ts'), nullValue: 0 },
  domain: { expr: sql.ref('b.domain'), nullValue: '' },
  pattern: { expr: sql.ref('b.pattern'), nullValue: '' },
  session: { expr: sql.ref('s.slug'), nullValue: '' },
  source: { expr: sql.ref('b.source'), nullValue: '' },
};

function base(db: Kysely<DB>) {
  return db
    .selectFrom('blocked_requests as b')
    .leftJoin('sessions as s', 's.session_id', 'b.session_id')
    .selectAll('b')
    .select('s.slug as session_slug');
}

type BaseQuery = ReturnType<typeof base>;
type Row = Awaited<ReturnType<BaseQuery['execute']>>[number];

function applyFilters(qb: BaseQuery, q: BlockedRequestListQuery): BaseQuery {
  let out = qb;
  if (q.sessionId !== undefined) out = out.where('b.session_id', '=', q.sessionId);
  if (q.pattern !== undefined) out = out.where('b.pattern', '=', q.pattern);
  if (q.domain !== undefined) out = out.where('b.domain', '=', q.domain.toLowerCase());
  if (q.sources !== undefined && q.sources.length > 0)
    out = out.where('b.source', 'in', [...q.sources]);
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) =>
      eb.or([
        like(sql.ref('b.url'), term),
        like(sql.ref('b.pattern'), term),
        like(sql.ref('s.slug'), term),
      ]),
    );
  }
  if (q.since !== undefined) out = out.where('b.ts', '>=', q.since);
  if (q.until !== undefined) out = out.where('b.ts', '<=', q.until);
  return out;
}

function sortValue(row: Row, key: SortName): number | string {
  switch (key) {
    case 'ts':
      return row.ts;
    case 'domain':
      return row.domain ?? '';
    case 'pattern':
      return row.pattern;
    case 'session':
      return row.session_slug ?? '';
    case 'source':
      return row.source;
  }
}

/** SQLite implementation of {@link BlocklistAuditRepository}. */
export class SqliteBlocklistAuditRepository implements BlocklistAuditRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: BlockedRequestRecord): Promise<void> {
    await this.#db
      .insertInto('blocked_requests')
      .values(blockedRequestToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async list(query: BlockedRequestListQuery): Promise<Page<BlockedRequestListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'ts';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(base(this.#db), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('b.event_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('b.event_id', dir)
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
      (row) => ({ ...blockedRequestFromRow(row), sessionSlug: row.session_slug }),
      (row) => ({ key: sortValue(row, sortName), id: row.event_id }),
      total,
    );
  }

  async stats(window: TimeWindow, topLimit = 10): Promise<BlockedStats> {
    const limit = clampLimit(topLimit, 10, 100);
    const windowed = () => {
      let qb = this.#db.selectFrom('blocked_requests');
      if (window.since !== undefined) qb = qb.where('ts', '>=', window.since);
      if (window.until !== undefined) qb = qb.where('ts', '<=', window.until);
      return qb;
    };
    const totals = await windowed()
      .select([
        sql<number>`COUNT(*)`.as('attempts'),
        sql<number>`COUNT(DISTINCT session_id)`.as('sessions'),
        sql<number>`COUNT(DISTINCT domain)`.as('domains'),
      ])
      .executeTakeFirst();
    const allTime = await this.#db
      .selectFrom('blocked_requests')
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    const patterns = await windowed()
      .select(['pattern', sql<number>`COUNT(*)`.as('count'), sql<number>`MAX(ts)`.as('last_ts')])
      .groupBy('pattern')
      .orderBy('count', 'desc')
      .orderBy('pattern', 'asc')
      .limit(limit)
      .execute();
    const domains = await windowed()
      .select(['domain', sql<number>`COUNT(*)`.as('count')])
      .where('domain', 'is not', null)
      .where('domain', '<>', '')
      .groupBy('domain')
      .orderBy('count', 'desc')
      .orderBy('domain', 'asc')
      .limit(limit)
      .execute();
    return {
      attempts: asNumber(totals?.attempts),
      sessions: asNumber(totals?.sessions),
      domains: asNumber(totals?.domains),
      totalAllTime: asNumber(allTime?.n),
      topPatterns: patterns.map((p) => ({
        pattern: p.pattern,
        count: asNumber(p.count),
        lastTs: asNumber(p.last_ts),
      })),
      topDomains: domains.map((d) => ({ domain: d.domain ?? '', count: asNumber(d.count) })),
    };
  }
}
