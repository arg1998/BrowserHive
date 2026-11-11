/** @module infra/persistence/repositories/template-versions — SQLite `TemplateVersionRepository` (spec 13 §2.5, §2.6, §3.9). */

import type { Kysely } from 'kysely';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type {
  TemplateStateFileRecord,
  TemplateVersionRecord,
} from '../../../ports/persistence/records-templates.ts';
import type { TemplateVersionRepository } from '../../../ports/persistence/templates.ts';
import type { DB } from '../generated/db.d.ts';
import { boolToInt } from '../mappers/codec.ts';
import { templateVersionFromRow, templateVersionToRow } from '../mappers/template-versions.ts';

/** SQLite implementation of {@link TemplateVersionRepository}. */
export class SqliteTemplateVersionRepository implements TemplateVersionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(templateId: string): Promise<readonly TemplateVersionRecord[]> {
    const rows = await this.#db
      .selectFrom('template_versions')
      .selectAll()
      .where('template_id', '=', templateId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map(templateVersionFromRow);
  }

  async listAll(): Promise<readonly TemplateVersionRecord[]> {
    const rows = await this.#db
      .selectFrom('template_versions')
      .selectAll()
      .orderBy('template_id', 'asc')
      .orderBy('version', 'asc')
      .execute();
    return rows.map(templateVersionFromRow);
  }

  async get(templateId: string, version: number): Promise<TemplateVersionRecord | null> {
    const row = await this.#db
      .selectFrom('template_versions')
      .selectAll()
      .where('template_id', '=', templateId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row === undefined ? null : templateVersionFromRow(row);
  }

  async insert(record: TemplateVersionRecord): Promise<void> {
    const result = await this.#db
      .insertInto('template_versions')
      .values(templateVersionToRow(record))
      .onConflict((oc) => oc.columns(['template_id', 'version']).doNothing())
      .executeTakeFirst();
    if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n) {
      throw new AppError('CONFLICT', { current_version: record.version });
    }
  }

  async setPinned(
    templateId: string,
    version: number,
    pinned: boolean,
  ): Promise<TemplateVersionRecord | null> {
    await this.#db
      .updateTable('template_versions')
      .set({ pinned: boolToInt(pinned) })
      .where('template_id', '=', templateId)
      .where('version', '=', version)
      .execute();
    return await this.get(templateId, version);
  }

  async updateFile(
    templateId: string,
    version: number,
    file: TemplateStateFileRecord,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('template_versions')
      .set({ size_bytes: file.sizeBytes, sha256: file.sha256, key_id: file.keyId })
      .where('template_id', '=', templateId)
      .where('version', '=', version)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async remove(templateId: string, version: number): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('template_versions')
      .where('template_id', '=', templateId)
      .where('version', '=', version)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
