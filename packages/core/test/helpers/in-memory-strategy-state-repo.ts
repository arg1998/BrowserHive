/** @module test/helpers/in-memory-strategy-state-repo — `template_strategy_state` in memory (schema v12, D53). */

import type {
  StrategyStateKey,
  StrategyStateRecord,
  StrategyStateRepository,
} from '../../src/ports/persistence/strategy-state.ts';

function keyOf(key: StrategyStateKey): string {
  return [key.templateId, key.strategy, key.packId, key.scopeKey].join('\u0000');
}

/** `template_strategy_state` in memory; `failPuts` makes every `put` reject (a failing disk). */
export class InMemoryStrategyStateRepository implements StrategyStateRepository {
  readonly rows = new Map<string, StrategyStateRecord>();
  failPuts = false;

  async list(): Promise<readonly StrategyStateRecord[]> {
    return [...this.rows.values()];
  }

  async put(record: StrategyStateRecord): Promise<void> {
    if (this.failPuts) throw new Error('put failed');
    this.rows.set(keyOf(record), { ...record });
  }

  async remove(key: StrategyStateKey): Promise<boolean> {
    return this.rows.delete(keyOf(key));
  }

  /** The cascade of a template deletion. */
  dropTemplate(templateId: string): void {
    for (const [k, row] of this.rows) if (row.templateId === templateId) this.rows.delete(k);
  }
}
