/** @module infra/persistence/repositories/strategy-state — SQLite `StrategyStateRepository` over `template_strategy_state` (schema v12, spec 13 §9.4, D53). */

import type { Kysely, Selectable } from 'kysely';
import type {
  StrategyStateKey,
  StrategyStateRecord,
  StrategyStateRepository,
} from '../../../ports/persistence/strategy-state.ts';
import type { DB, TemplateStrategyState } from '../generated/db.d.ts';

function fromRow(row: Selectable<TemplateStrategyState>): StrategyStateRecord {
  return {
    templateId: row.template_id,
    strategy: row.strategy,
    packId: row.pack_id,
    scopeKey: row.scope_key,
    stateJson: row.state_json,
    updatedAt: row.updated_at,
  };
}

/** SQLite implementation of {@link StrategyStateRepository}. */
export class SqliteStrategyStateRepository implements StrategyStateRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(): Promise<readonly StrategyStateRecord[]> {
    const rows = await this.#db.selectFrom('template_strategy_state').selectAll().execute();
    return rows.map(fromRow);
  }

  async put(record: StrategyStateRecord): Promise<void> {
    await this.#db
      .insertInto('template_strategy_state')
      .values({
        template_id: record.templateId,
        strategy: record.strategy,
        pack_id: record.packId,
        scope_key: record.scopeKey,
        state_json: record.stateJson,
        updated_at: record.updatedAt,
      })
      .onConflict((oc) =>
        oc.columns(['template_id', 'strategy', 'pack_id', 'scope_key']).doUpdateSet({
          state_json: record.stateJson,
          updated_at: record.updatedAt,
        }),
      )
      .execute();
  }

  async remove(key: StrategyStateKey): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('template_strategy_state')
      .where('template_id', '=', key.templateId)
      .where('strategy', '=', key.strategy)
      .where('pack_id', '=', key.packId)
      .where('scope_key', '=', key.scopeKey)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
