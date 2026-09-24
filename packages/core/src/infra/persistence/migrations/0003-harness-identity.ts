/** @module infra/persistence/migrations/0003-harness-identity — schema v3: the resolved client identity on `mcp_connections` and the launch harness on `sessions` (spec 02 §1.4, 03 §7, D-30). */

import type { Migration } from './migration.ts';

const sql = `
ALTER TABLE mcp_connections ADD COLUMN client_title TEXT;
ALTER TABLE mcp_connections ADD COLUMN workspace TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_source TEXT;
ALTER TABLE mcp_connections ADD COLUMN model_source TEXT;
ALTER TABLE mcp_connections ADD COLUMN harness_conflicts_json TEXT;
ALTER TABLE mcp_connections ADD COLUMN meta_json TEXT;
UPDATE mcp_connections SET workspace = agent_name WHERE agent_name IS NOT NULL;
UPDATE mcp_connections SET harness_source = 'header' WHERE harness IS NOT NULL;
UPDATE mcp_connections SET model_source = 'header' WHERE model IS NOT NULL;
CREATE INDEX idx_mcp_connections_seen ON mcp_connections(last_seen_at, connection_id);
ALTER TABLE sessions ADD COLUMN harness TEXT;
CREATE INDEX idx_sessions_harness ON sessions(harness, created_at);
`;

/**
 * Schema v3. `compatible`: purely additive, so a v2 reader still understands every table. Rows
 * written before v3 keep their header values (now marked `header`), `workspace` is backfilled from
 * `agent_name`, and existing sessions keep a NULL harness, which reads `unknown`.
 */
export const harnessIdentity: Migration = {
  version: 3,
  name: 'harness-identity',
  compatible: true,
  sql,
};
