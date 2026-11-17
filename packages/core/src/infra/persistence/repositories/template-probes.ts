/** @module infra/persistence/repositories/template-probes — SQLite `TemplateProbeRepository` (spec 13 §2.5, §8; telemetry class, pruned with `retentionDays`). */

import { type Kysely, type Selectable, sql } from 'kysely';
import {
  TEMPLATE_PROBE_OUTCOMES,
  TEMPLATE_PROBE_TRIGGERS,
} from '../../../ports/persistence/enums.ts';
import type { Page } from '../../../ports/persistence/queries.ts';
import type { TemplateProbeRecord } from '../../../ports/persistence/records-templates.ts';
import type {
  TemplateProbeQuery,
  TemplateProbeRepository,
} from '../../../ports/persistence/templates.ts';
import type { DB, TemplateProbes } from '../generated/db.d.ts';
import { parseEnum } from '../mappers/codec.ts';
import { clampLimit, decodeCursor, toPage } from './common.ts';

const RESOURCE = 'template_probes';

function fromRow(row: Selectable<TemplateProbes>): TemplateProbeRecord {
  const where = `template_probes.${row.seq}`;
  return {
    seq: row.seq ?? 0,
    templateId: row.template_id,
    siteId: row.site_id,
    outcome: parseEnum(TEMPLATE_PROBE_OUTCOMES, row.outcome, where),
    reason: row.reason,
    trigger: parseEnum(TEMPLATE_PROBE_TRIGGERS, row.trigger, where),
    finalUrl: row.final_url,
    durationMs: row.duration_ms,
    at: row.at,
  };
}

/** SQLite implementation of {@link TemplateProbeRepository}. */
export class SqliteTemplateProbeRepository implements TemplateProbeRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: TemplateProbeRecord): Promise<number> {
    const row = await this.#db
      .insertInto('template_probes')
      .values({
        template_id: record.templateId,
        site_id: record.siteId,
        outcome: record.outcome,
        reason: record.reason,
        trigger: record.trigger,
        final_url: record.finalUrl,
        duration_ms: record.durationMs,
        at: record.at,
      })
      .returning('seq')
      .executeTakeFirstOrThrow();
    return row.seq ?? 0;
  }

  async list(templateId: string, query: TemplateProbeQuery): Promise<Page<TemplateProbeRecord>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(RESOURCE, query.cursor);
    let qb = this.#db
      .selectFrom('template_probes')
      .selectAll()
      .where('template_id', '=', templateId);
    if (query.siteId !== undefined) qb = qb.where('site_id', '=', query.siteId);
    if (query.outcomes !== undefined && query.outcomes.length > 0) {
      qb = qb.where('outcome', 'in', [...query.outcomes]);
    }
    if (query.triggers !== undefined && query.triggers.length > 0) {
      qb = qb.where('trigger', 'in', [...query.triggers]);
    }
    if (query.since !== undefined) qb = qb.where('at', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('at', '<', query.until);
    if (cursor !== null) {
      // `seq` is an integer: compared as a number, never as the cursor's text id.
      const at = Number(cursor.key);
      const seq = Number(cursor.id);
      qb = qb.where(sql<boolean>`(at < ${at} OR (at = ${at} AND seq < ${seq}))`);
    }
    const rows = await qb
      .orderBy('at', 'desc')
      .orderBy('seq', 'desc')
      .limit(limit + 1)
      .execute();
    return toPage(RESOURCE, rows, limit, fromRow, (row) => ({ key: row.at, id: String(row.seq) }));
  }

  async since(since: number, until: number): Promise<readonly TemplateProbeRecord[]> {
    const rows = await this.#db
      .selectFrom('template_probes')
      .selectAll()
      .where('at', '>=', since)
      .where('at', '<', until)
      .orderBy('at', 'asc')
      .orderBy('seq', 'asc')
      .execute();
    return rows.map(fromRow);
  }

  async prune(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('template_probes')
      .where('at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
