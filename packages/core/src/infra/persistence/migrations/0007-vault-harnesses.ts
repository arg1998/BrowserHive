/** @module infra/persistence/migrations/0007-vault-harnesses — schema v7: optional harness lists on vault bindings and group policies, and the raw declared harness name on connections and sessions (spec 03 §7, D-48). */

import type { Migration } from './migration.ts';

/*
 * `harnesses_json` is NULL for "every harness" (today's meaning, so nothing is backfilled), `[]` for
 * none, else a JSON array of known slugs and exact, case-sensitive declared names. `harness_declared`
 * is the raw value of a declared harness signal; NULL when none was declared, and for every row
 * written before v7 (no value is guessed).
 */
const sql = `
ALTER TABLE vault_bindings ADD COLUMN harnesses_json TEXT;
ALTER TABLE vault_group_policies ADD COLUMN harnesses_json TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_declared TEXT;
ALTER TABLE sessions ADD COLUMN harness_declared TEXT;
`;

/**
 * Schema v7. `compatible`: four nullable columns and nothing else, so a v6 reader still understands
 * every table. A v6 binary ignores the lists, which only narrow access (D-48).
 */
export const vaultHarnesses: Migration = {
  version: 7,
  name: 'vault-harnesses',
  compatible: true,
  sql,
};
