/** @module infra/persistence/repositories/vault-audit — SQLite `VaultAuditRepository`. */

import { type Kysely, sql } from 'kysely';
import type { Page, VaultAccessListQuery } from '../../../ports/persistence/queries.ts';
import type { VaultAccessRecord } from '../../../ports/persistence/records.ts';
import type {
  VaultAccessListRow,
  VaultAuditRepository,
} from '../../../ports/persistence/vault-audit.ts';
import type { DB } from '../generated/db.d.ts';
import { vaultAccessFromRow, vaultAccessToRow } from '../mappers/facts.ts';
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

const RESOURCE = 'vault_access';

type SortName = NonNullable<VaultAccessListQuery['sort']>;

const SORT: Record<SortName, SortExpr> = {
  ts: { expr: sql.ref('va.ts'), nullValue: 0 },
  entry_name: { expr: sql.ref('va.entry_name'), nullValue: '' },
  result: { expr: sql.ref('va.result'), nullValue: '' },
  session: { expr: sql.ref('s.slug'), nullValue: '' },
};

function base(db: Kysely<DB>) {
  return db
    .selectFrom('vault_access as va')
    .leftJoin('sessions as s', 's.session_id', 'va.session_id')
    .selectAll('va')
    .select('s.slug as session_slug');
}

type BaseQuery = ReturnType<typeof base>;
type Row = Awaited<ReturnType<BaseQuery['execute']>>[number];

function applyFilters(qb: BaseQuery, q: VaultAccessListQuery): BaseQuery {
  let out = qb;
  if (q.sessionId !== undefined) out = out.where('va.session_id', '=', q.sessionId);
  if (q.results !== undefined && q.results.length > 0)
    out = out.where('va.result', 'in', [...q.results]);
  if (q.originChecks !== undefined && q.originChecks.length > 0)
    out = out.where('va.origin_check', 'in', [...q.originChecks]);
  if (q.evaluate !== undefined)
    out = out.where('va.evaluate_enabled', '=', q.evaluate === 'on' ? 1 : 0);
  if (q.entryName !== undefined) out = out.where('va.entry_name', '=', q.entryName);
  if (q.q !== undefined && q.q !== '') {
    const term = q.q;
    out = out.where((eb) =>
      eb.or([
        like(sql.ref('va.entry_name'), term),
        like(sql.ref('va.page_url'), term),
        like(sql.ref('va.session_id'), term),
      ]),
    );
  }
  if (q.since !== undefined) out = out.where('va.ts', '>=', q.since);
  if (q.until !== undefined) out = out.where('va.ts', '<=', q.until);
  return out;
}

function sortValue(row: Row, key: SortName): number | string {
  switch (key) {
    case 'ts':
      return row.ts;
    case 'entry_name':
      return row.entry_name;
    case 'result':
      return row.result;
    case 'session':
      return row.session_slug ?? '';
  }
}

/** SQLite implementation of {@link VaultAuditRepository}. */
export class SqliteVaultAuditRepository implements VaultAuditRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: VaultAccessRecord): Promise<void> {
    await this.#db
      .insertInto('vault_access')
      .values(vaultAccessToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async list(query: VaultAccessListQuery): Promise<Page<VaultAccessListRow>> {
    const limit = clampLimit(query.limit);
    const sortName = query.sort ?? 'ts';
    const spec = SORT[sortName];
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = applyFilters(base(this.#db), query);
    if (cursor !== null) qb = qb.where(keysetWhere(spec, sql.ref('va.event_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(spec), dir)
      .orderBy('va.event_id', dir)
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
      (row) => ({ ...vaultAccessFromRow(row), sessionSlug: row.session_slug }),
      (row) => ({ key: sortValue(row, sortName), id: row.event_id }),
      total,
    );
  }
}
