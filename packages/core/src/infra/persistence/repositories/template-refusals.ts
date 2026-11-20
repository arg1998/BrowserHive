/** @module infra/persistence/repositories/template-refusals — SQLite `TemplateRefusalRepository` (deferred D60): an upsert per refusal, bounded per template, deleted with the template by the foreign key. */

import { type Kysely, type Selectable, sql } from 'kysely';
import {
  TEMPLATE_REFUSAL_KINDS,
  TEMPLATE_REFUSAL_REASONS,
  type TemplateRefusalRecord,
  type TemplateRefusalRepository,
} from '../../../ports/persistence/template-refusals.ts';
import type { DB, TemplateRefusals } from '../generated/db.d.ts';
import { parseEnum } from '../mappers/codec.ts';

function fromRow(row: Selectable<TemplateRefusals>): TemplateRefusalRecord {
  const where = `template_refusals.${row.template_id}`;
  return {
    templateId: row.template_id,
    principal: row.principal_id,
    harness: row.harness,
    harnessDeclared: row.harness_declared === '' ? null : row.harness_declared,
    kind: parseEnum(TEMPLATE_REFUSAL_KINDS, row.kind, where),
    reason: parseEnum(TEMPLATE_REFUSAL_REASONS, row.reason, where),
    count: row.count,
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
}

/** SQLite implementation of {@link TemplateRefusalRepository}. */
export class SqliteTemplateRefusalRepository implements TemplateRefusalRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async record(delta: TemplateRefusalRecord, maxRows: number): Promise<void> {
    const declared = delta.harnessDeclared ?? '';
    // `INSERT … SELECT … WHERE EXISTS`: a template deleted since the refusal records nothing (no
    // foreign key error inside the write queue's batch).
    await sql`
      INSERT INTO template_refusals
        (template_id, principal_id, harness, harness_declared, kind, reason, count, first_at, last_at)
      SELECT ${delta.templateId}, ${delta.principal}, ${delta.harness}, ${declared}, ${delta.kind},
        ${delta.reason}, ${delta.count}, ${delta.firstAt}, ${delta.lastAt}
      WHERE EXISTS (SELECT 1 FROM templates WHERE template_id = ${delta.templateId})
      ON CONFLICT (template_id, principal_id, harness, harness_declared, kind) DO UPDATE SET
        count = count + excluded.count,
        reason = excluded.reason,
        first_at = MIN(first_at, excluded.first_at),
        last_at = MAX(last_at, excluded.last_at)
    `.execute(this.#db);
    await sql`
      DELETE FROM template_refusals
      WHERE template_id = ${delta.templateId}
        AND rowid NOT IN (
          SELECT rowid FROM template_refusals WHERE template_id = ${delta.templateId}
          ORDER BY last_at DESC, rowid DESC LIMIT ${maxRows}
        )
    `.execute(this.#db);
  }

  async list(templateId: string): Promise<readonly TemplateRefusalRecord[]> {
    const rows = await this.#db
      .selectFrom('template_refusals')
      .selectAll()
      .where('template_id', '=', templateId)
      .orderBy('last_at', 'desc')
      .orderBy('principal_id', 'asc')
      .orderBy('kind', 'asc')
      .execute();
    return rows.map(fromRow);
  }
}
