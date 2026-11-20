/** @module ports/persistence/strategy-state — rows and repository of schema v12 (`0012-strategy-state`, spec 13 §9.4, D53): the strategy state that survives a restart, one row per (template, strategy, pack, scope key). */

/** The key of one `template_strategy_state` row. */
export interface StrategyStateKey {
  readonly templateId: string;
  /** The strategy id (`pace-writes`, `launch-spacing`, `human-dwell`). */
  readonly strategy: string;
  /** The pack (the site); `''` for template-wide state. */
  readonly packId: string;
  /** The strategy's own key inside the pack (a pace rule id); `''` when it has none. */
  readonly scopeKey: string;
}

/** One `template_strategy_state` row (state class: deleted with its template, never pruned by retention). */
export interface StrategyStateRecord extends StrategyStateKey {
  /** The strategy's snake_case state with wall-clock epoch milliseconds; parsed by the application. */
  readonly stateJson: string;
  readonly updatedAt: number;
}

/** Repository over `template_strategy_state`. */
export interface StrategyStateRepository {
  /** Every row, unparsed. */
  list(): Promise<readonly StrategyStateRecord[]>;
  /** Inserts or replaces one row. @throws when its template no longer exists (FK) */
  put(record: StrategyStateRecord): Promise<void>;
  /** Deletes one row; false when there was none. */
  remove(key: StrategyStateKey): Promise<boolean>;
}
