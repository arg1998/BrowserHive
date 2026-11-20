/** @module infra/persistence/migrations/0012-strategy-state — schema v12: the state of the site-pack strategies that must survive a restart (spec 13 §9.4; deferred D53, owner decision 2026-11-20): `pace-writes` buckets, the `launch-spacing` turn and the `human-dwell` last action, per template. */

import type { Migration } from './migration.ts';

/*
 * One table, deleted with its template (FK cascade). `strategy` names the strategy, `pack_id` the
 * pack (the site) and `scope_key` the strategy's own key inside it (a pace rule id); both are ''
 * when the state is the template's. `state_json` is the strategy's snake_case state with wall-clock
 * epoch milliseconds; the application parses it and ignores a row it cannot read. `strategy` has no
 * CHECK on purpose: a strategy that later persists state adds rows, not a table rebuild, and a
 * binary that does not know a strategy ignores its rows.
 */
const sql = `
CREATE TABLE template_strategy_state (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  pack_id TEXT NOT NULL DEFAULT '',
  scope_key TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, strategy, pack_id, scope_key)
) WITHOUT ROWID;
`;

/**
 * Schema v12. `compatible`: one new table, nothing existing changes, so a v11 reader still
 * understands every table it knows. A v11 binary ignores the table (its strategies keep their state
 * in memory, as before), and its template deletions still remove the rows through the cascade, so
 * `meta.min_reader_version` stays 10.
 */
export const strategyState: Migration = {
  version: 12,
  name: 'strategy-state',
  compatible: true,
  sql,
};
