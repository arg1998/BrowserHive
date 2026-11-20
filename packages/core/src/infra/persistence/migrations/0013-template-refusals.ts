/** @module infra/persistence/migrations/0013-template-refusals — schema v13: the agents a template's access rules refused (spec 13 §6.1, §11.1; deferred D60). */

import type { Migration } from './migration.ts';

/*
 * One aggregated row per (template, principal, harness slug, declared harness name, kind): a
 * looping agent bumps `count` and `last_at` instead of adding rows, and the repository keeps at most
 * a fixed number of rows per template. `harness_declared` is `''` when none was declared, so the
 * primary key never holds a NULL. Rows go with their template (`ON DELETE CASCADE`). The CHECK lists
 * are literals frozen in this file (spec 13 §9.9).
 */
const sql = `
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
`;

/**
 * Schema v13. `compatible`: one new table, so a v12 reader still understands every table it knows
 * and simply records no refusals; `meta.min_reader_version` stays 10.
 */
export const templateRefusals: Migration = {
  version: 13,
  name: 'template-refusals',
  compatible: true,
  sql,
};
