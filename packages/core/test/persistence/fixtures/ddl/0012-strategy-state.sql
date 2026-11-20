
CREATE TABLE template_strategy_state (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  pack_id TEXT NOT NULL DEFAULT '',
  scope_key TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, strategy, pack_id, scope_key)
) WITHOUT ROWID;
