/** @module infra/persistence/repositories/pages — SQLite `PageRepository`. */

import { type Kysely, sql } from 'kysely';
import type {
  DomainCount,
  PageFacets,
  PageListRow,
  PageRepository,
} from '../../../ports/persistence/pages.ts';
import type { Page, PageListQuery, TopDomainsQuery } from '../../../ports/persistence/queries.ts';
import type { PageRecord } from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import { pageFromRow, pageToRow } from '../mappers/facts.ts';
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

const RESOURCE = 'pages';

type SortName = NonNullable<PageListQuery['sort']>;

const SORT: Record<SortName, SortExpr> = {
  ts: { expr: sql.ref('p.ts'), nullValue: 0 },
  domain: { expr: sql.ref('p.domain'), nullValue: '' },
  category: { expr: sql.ref('p.category'), nullValue: '' },
  session: { expr: sql.ref('s.slug'), nullValue: '' },
};

function base(db: Kysely<DB>) {
  return db
    .selectFrom('pages as p')
    .leftJoin('sessions as s', 's.session_id', 'p.session_id')
    .selectAll('p')
    .select('s.slug as session_slug');
}

type BaseQuery = ReturnType<typeof base>;
type Row = Awaited<ReturnType<BaseQuery['execute']>>[number];

function applyFilters(qb: BaseQuery, q: PageListQuery): BaseQuery {
  let out = qb;
  if (q.sessionId !== undefined) out = out.where('p.session_id', '=', q.sessionId);
  if (q.categories !== undefined && q.categories.length > 0)
    out = out.where('p.category', 'in', [...q.categories]);
  if (q.domain !== undefined) out = out.where('p.domain', '=', q.domain.toLowerCase());
  if (q.tabId !== undefined) out = out.where('p.tab_id', '=', q.tabId);
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) => eb.or([like(sql.ref('p.url'), term), like(sql.ref('p.title'), term)]));
  }
  if (q.since !== undefined) out = out.where('p.ts', '>=', q.since);
  if (q.until !== undefined) out = out.where('p.ts', '<=', q.until);
  return out;
}

function toListRow(row: Row): PageListRow {
  return { ...pageFromRow(row), sessionSlug: row.session_slug };
}

function sortValue(row: Row, key: SortName): number | string {
  switch (key) {
    case 'ts':
      return row.ts;
    case 'domain':
      return row.domain;
    case 'category':
      return row.category;
    case 'session':
      return row.session_slug ?? '';
  }
}

/** SQLite implementation of {@link PageRepository}. */
export class SqlitePageRepository implements PageRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: PageRecord): Promise<void> {
    await this.#db
      .insertInto('pages')
      .values(pageToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async facets(query: PageListQuery): Promise<PageFacets> {
    const { categories: _categories, ...rest } = query;
    const rows = await applyFilters(base(this.#db), rest)
      .clearSelect()
      .select([sql.ref<string>('p.category').as('value'), sql<number>`COUNT(*)`.as('n')])
      .groupBy('p.category')
      .orderBy('p.category', 'asc')
      .execute();
    return { categories: rows.map((r) => ({ value: r.value, count: asNumber(r.n) })) };
  }

  async list(query: PageListQuery): Promise<Page<PageListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'ts';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(base(this.#db), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('p.event_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('p.event_id', dir)
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
      (row) => ({ key: sortValue(row, sortName), id: row.event_id }),
      total,
    );
  }

  async recent(limit: number): Promise<readonly PageListRow[]> {
    const rows = await base(this.#db)
      .orderBy('p.ts', 'desc')
      .orderBy('p.event_id', 'desc')
      .limit(clampLimit(limit, 15, 200))
      .execute();
    return rows.map(toListRow);
  }

  async topDomains(query: TopDomainsQuery): Promise<readonly DomainCount[]> {
    let qb = this.#db
      .selectFrom('pages')
      .select(['domain', sql<number>`COUNT(*)`.as('count')])
      .where('domain', '<>', '');
    if (query.since !== undefined) qb = qb.where('ts', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('ts', '<=', query.until);
    const rows = await qb
      .groupBy('domain')
      .orderBy('count', 'desc')
      .orderBy('domain', 'asc')
      .limit(clampLimit(query.limit, 5, 100))
      .execute();
    return rows.map((r) => ({ domain: r.domain, count: asNumber(r.count) }));
  }
}
