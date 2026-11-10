/** @module infra/persistence/repositories/templates — SQLite `TemplateRepository` and `TemplateSiteRepository` (spec 13 §2.5, §2.6). */

import { type Kysely, sql } from 'kysely';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type {
  TemplatePatch,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
} from '../../../ports/persistence/records-templates.ts';
import type {
  TemplateRepository,
  TemplateSiteRepository,
} from '../../../ports/persistence/templates.ts';
import type { DB } from '../generated/db.d.ts';
import {
  templateFromRow,
  templatePatchToRow,
  templateSiteFromRow,
  templateSiteToRow,
  templateToRow,
} from '../mappers/templates.ts';
import { asNumber } from './common.ts';

function nameTaken(name: string): AppError<'TEMPLATE_NAME_TAKEN'> {
  return new AppError(
    'TEMPLATE_NAME_TAKEN',
    { name },
    { publicMessage: `A session template named '${name}' already exists.` },
  );
}

function notFound(templateId: string): AppError<'TEMPLATE_NOT_FOUND'> {
  return new AppError(
    'TEMPLATE_NOT_FOUND',
    { template: templateId },
    { publicMessage: `No session template '${templateId}'.` },
  );
}

/** SQLite implementation of {@link TemplateRepository}. */
export class SqliteTemplateRepository implements TemplateRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async listAll(): Promise<readonly TemplateRecord[]> {
    const rows = await this.#db
      .selectFrom('templates')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return rows.map(templateFromRow);
  }

  async get(templateId: string): Promise<TemplateRecord | null> {
    const row = await this.#db
      .selectFrom('templates')
      .selectAll()
      .where('template_id', '=', templateId)
      .executeTakeFirst();
    return row === undefined ? null : templateFromRow(row);
  }

  async getByName(name: string): Promise<TemplateRecord | null> {
    const row = await this.#db
      .selectFrom('templates')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? null : templateFromRow(row);
  }

  async insert(record: TemplateRecord): Promise<void> {
    const result = await this.#db
      .insertInto('templates')
      .values({ ...templateToRow(record), version: 1 })
      .onConflict((oc) => oc.column('name').doNothing())
      .executeTakeFirst();
    if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n) throw nameTaken(record.name);
  }

  async update(
    templateId: string,
    patch: TemplatePatch,
    ifVersion?: number,
  ): Promise<TemplateRecord> {
    const current = await this.get(templateId);
    if (current === null) throw notFound(templateId);
    if (ifVersion !== undefined && current.version !== ifVersion) {
      throw new AppError('CONFLICT', { current_version: current.version });
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      const holder = await this.getByName(patch.name);
      if (holder !== null) throw nameTaken(patch.name);
    }
    const result = await this.#db
      .updateTable('templates')
      .set({ ...templatePatchToRow(patch), version: current.version + 1 })
      .where('template_id', '=', templateId)
      .where('version', '=', current.version)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new AppError('CONFLICT', { current_version: (await this.get(templateId))?.version });
    }
    const stored = await this.get(templateId);
    if (stored === null) throw notFound(templateId);
    return stored;
  }

  async remove(templateId: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('templates')
      .where('template_id', '=', templateId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async touchLastUsed(templateId: string, at: number): Promise<void> {
    await this.#db
      .updateTable('templates')
      .set({ last_used_at: at })
      .where('template_id', '=', templateId)
      .execute();
  }

  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('templates')
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}

/** SQLite implementation of {@link TemplateSiteRepository}. */
export class SqliteTemplateSiteRepository implements TemplateSiteRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(templateId: string): Promise<readonly TemplateSiteRecord[]> {
    const rows = await this.#db
      .selectFrom('template_sites')
      .selectAll()
      .where('template_id', '=', templateId)
      .orderBy('added_at', 'asc')
      .orderBy('site_id', 'asc')
      .execute();
    return rows.map(templateSiteFromRow);
  }

  async listAll(): Promise<readonly TemplateSiteRecord[]> {
    const rows = await this.#db
      .selectFrom('template_sites')
      .selectAll()
      .orderBy('template_id', 'asc')
      .orderBy('added_at', 'asc')
      .orderBy('site_id', 'asc')
      .execute();
    return rows.map(templateSiteFromRow);
  }

  async upsert(record: TemplateSiteRecord): Promise<void> {
    const row = templateSiteToRow(record);
    const { template_id: _t, site_id: _s, added_at: _a, ...updatable } = row;
    await this.#db
      .insertInto('template_sites')
      .values(row)
      .onConflict((oc) => oc.columns(['template_id', 'site_id']).doUpdateSet(updatable))
      .execute();
  }

  async remove(templateId: string, siteId: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('template_sites')
      .where('template_id', '=', templateId)
      .where('site_id', '=', siteId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async setHealth(
    templateId: string,
    siteId: string,
    health: TemplateSiteHealthRecord,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('template_sites')
      .set({
        health_state: health.state,
        health_reason: health.reason,
        health_checked_at: health.checkedAt,
        health_changed_at: health.changedAt,
        consecutive_inconclusive: health.consecutiveInconclusive,
      })
      .where('template_id', '=', templateId)
      .where('site_id', '=', siteId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
