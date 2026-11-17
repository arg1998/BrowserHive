/** @module infra/persistence/repositories/site-packs — SQLite site-pack repositories (spec 13 §9.9): approval state (configuration, never pruned), candidates and decisions, and guard hits (both audit, pruned with `auditRetentionDays`). */

import { type Kysely, sql } from 'kysely';
import type { Page } from '../../../ports/persistence/queries.ts';
import type {
  SiteGuardHitQuery,
  SiteGuardHitRecord,
  SiteGuardHitRepository,
  SitePackChangeQuery,
  SitePackChangeRecord,
  SitePackChangeRepository,
  SitePackDecisionValue,
  SitePackSourceId,
  SitePackStateRecord,
  SitePackStateRepository,
  UnreadableRowOptions,
} from '../../../ports/persistence/site-packs.ts';
import type { DB } from '../generated/db.d.ts';
import {
  siteGuardHitFromRow,
  siteGuardHitToRow,
  sitePackChangeFromRow,
  sitePackChangeToRow,
  sitePackStateFromRow,
  sitePackStateToRow,
} from '../mappers/site-packs.ts';
import { asNumber, clampLimit, decodeCursor, toPage } from './common.ts';

/** Maps rows one by one; with `onUnreadable` a row that fails is reported and left out. */
function mapRows<R, T>(
  rows: readonly R[],
  map: (row: R) => T,
  keyOf: (row: R) => string,
  options: UnreadableRowOptions,
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (options.onUnreadable === undefined) {
      out.push(map(row));
      continue;
    }
    try {
      out.push(map(row));
    } catch (error) {
      options.onUnreadable(keyOf(row), error);
    }
  }
  return out;
}

/** Decisions that leave a candidate open (`idx_site_pack_changes_pending`). */
const PENDING: readonly SitePackDecisionValue[] = ['available', 'downloaded'];

/** SQLite implementation of {@link SitePackStateRepository}. */
export class SqliteSitePackStateRepository implements SitePackStateRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(options: UnreadableRowOptions = {}): Promise<readonly SitePackStateRecord[]> {
    const rows = await this.#db
      .selectFrom('site_pack_state')
      .selectAll()
      .orderBy('pack_id', 'asc')
      .execute();
    return mapRows(rows, sitePackStateFromRow, (r) => r.pack_id, options);
  }

  async get(packId: string): Promise<SitePackStateRecord | null> {
    const row = await this.#db
      .selectFrom('site_pack_state')
      .selectAll()
      .where('pack_id', '=', packId)
      .executeTakeFirst();
    return row === undefined ? null : sitePackStateFromRow(row);
  }

  async put(record: SitePackStateRecord): Promise<void> {
    const row = sitePackStateToRow(record);
    const { pack_id: _key, ...updatable } = row;
    await this.#db
      .insertInto('site_pack_state')
      .values(row)
      .onConflict((oc) => oc.column('pack_id').doUpdateSet(updatable))
      .execute();
  }
}

const CHANGES = 'site_pack_changes';

/** SQLite implementation of {@link SitePackChangeRepository}. */
export class SqliteSitePackChangeRepository implements SitePackChangeRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: SitePackChangeRecord): Promise<SitePackChangeRecord> {
    const row = await this.#db
      .insertInto('site_pack_changes')
      .values(sitePackChangeToRow(record))
      .returningAll()
      .executeTakeFirstOrThrow();
    return sitePackChangeFromRow(row);
  }

  async decide(
    eventId: string,
    decision: SitePackDecisionValue,
    by: string | null,
    at: number,
  ): Promise<void> {
    await this.#db
      .updateTable('site_pack_changes')
      .set({ decision, decided_by: by, decided_at: at })
      .where('event_id', '=', eventId)
      .execute();
  }

  async findCandidate(
    packId: string,
    sha256: string,
    source: SitePackSourceId,
  ): Promise<SitePackChangeRecord | null> {
    const row = await this.#db
      .selectFrom('site_pack_changes')
      .selectAll()
      .where('pack_id', '=', packId)
      .where('to_sha256', '=', sha256)
      .where('source', '=', source)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : sitePackChangeFromRow(row);
  }

  async listPending(options: UnreadableRowOptions = {}): Promise<readonly SitePackChangeRecord[]> {
    const rows = await this.#db
      .selectFrom('site_pack_changes')
      .selectAll()
      .where('decision', 'in', [...PENDING])
      .orderBy('created_at', 'asc')
      .orderBy('seq', 'asc')
      .execute();
    return mapRows(rows, sitePackChangeFromRow, (r) => r.pack_id, options);
  }

  async list(query: SitePackChangeQuery): Promise<Page<SitePackChangeRecord>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(CHANGES, query.cursor);
    let qb = this.#db.selectFrom('site_pack_changes').selectAll();
    if (query.packId !== undefined) qb = qb.where('pack_id', '=', query.packId);
    if (query.decisions !== undefined && query.decisions.length > 0) {
      qb = qb.where('decision', 'in', [...query.decisions]);
    }
    if (query.window?.since !== undefined) qb = qb.where('created_at', '>=', query.window.since);
    if (query.window?.until !== undefined) qb = qb.where('created_at', '<', query.window.until);
    if (cursor !== null) {
      // `seq` is an integer: compared as a number, never as the cursor's text id.
      const at = Number(cursor.key);
      const seq = Number(cursor.id);
      qb = qb.where(sql<boolean>`(created_at < ${at} OR (created_at = ${at} AND seq < ${seq}))`);
    }
    const rows = await qb
      .orderBy('created_at', 'desc')
      .orderBy('seq', 'desc')
      .limit(limit + 1)
      .execute();
    return toPage(CHANGES, rows, limit, sitePackChangeFromRow, (row) => ({
      key: row.created_at,
      id: String(row.seq),
    }));
  }

  async pruneBefore(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('site_pack_changes')
      .where('decision', 'not in', [...PENDING])
      .where('created_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

const HITS = 'site_guard_hits';

/** SQLite implementation of {@link SiteGuardHitRepository}. */
export class SqliteSiteGuardHitRepository implements SiteGuardHitRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: SiteGuardHitRecord): Promise<void> {
    await this.#db
      .insertInto('site_guard_hits')
      .values(siteGuardHitToRow(record))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
  }

  async list(query: SiteGuardHitQuery): Promise<Page<SiteGuardHitRecord>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(HITS, query.cursor);
    let qb = this.#db.selectFrom('site_guard_hits').selectAll();
    if (query.templateId !== undefined) qb = qb.where('template_id', '=', query.templateId);
    if (query.sessionId !== undefined) qb = qb.where('session_id', '=', query.sessionId);
    if (query.packId !== undefined) qb = qb.where('pack_id', '=', query.packId);
    if (query.actions !== undefined && query.actions.length > 0) {
      qb = qb.where('action', 'in', [...query.actions]);
    }
    if (query.window?.since !== undefined) qb = qb.where('ts', '>=', query.window.since);
    if (query.window?.until !== undefined) qb = qb.where('ts', '<', query.window.until);
    if (cursor !== null) {
      const ts = Number(cursor.key);
      qb = qb.where(sql<boolean>`(ts < ${ts} OR (ts = ${ts} AND event_id < ${cursor.id}))`);
    }
    const rows = await qb
      .orderBy('ts', 'desc')
      .orderBy('event_id', 'desc')
      .limit(limit + 1)
      .execute();
    return toPage(HITS, rows, limit, siteGuardHitFromRow, (row) => ({
      key: row.ts,
      id: row.event_id,
    }));
  }

  async countByTemplate(templateId: string, since: number): Promise<number> {
    const row = await this.#db
      .selectFrom('site_guard_hits')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('template_id', '=', templateId)
      .where('ts', '>=', since)
      .executeTakeFirst();
    return asNumber(row?.n);
  }

  async pruneBefore(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('site_guard_hits')
      .where('ts', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
