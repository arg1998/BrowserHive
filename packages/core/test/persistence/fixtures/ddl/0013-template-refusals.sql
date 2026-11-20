
CREATE TABLE template_refusals (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_declared TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('list','launch')),
  reason TEXT NOT NULL CHECK (reason IN ('principal_not_allowed','harness_not_allowed')),
  count INTEGER NOT NULL CHECK (count >= 1),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, principal_id, harness, harness_declared, kind)
);
CREATE INDEX idx_template_refusals_last ON template_refusals(template_id, last_at);
