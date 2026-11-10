/** @module infra/persistence/migrations/0009-templates — schema v9: session templates, their sites, versions and probes, the session's template columns, and the operator-token scope rewrite for the five template and site-pack scopes (spec 13 §2.5, D-49). */

import type { Migration } from './migration.ts';

/*
 * Every CHECK list below is a literal frozen in this file, never built from a live constant
 * (D-04 as amended by D-54): a later binary that grows an enum must not change what this migration
 * wrote. `sessions.template_mode` is an open set on purpose (`serial` is reserved, spec 13 §16).
 *
 * Operator token scopes (data step, spec 13 §2.5 and §6.2). This release adds `templates:read`,
 * `templates:write`, `templates:login`, `sitepacks:read` and `sitepacks:write` to the operator's
 * scopes. A token issued with exactly the 0.2.x full list (the 19 scopes, in registry order) was
 * issued as "every scope"; without a rewrite it would no longer hold every operator scope and would
 * lose the account routes (`hasFullOperatorAccess`). Migration v8 rewrote the ones that existed when
 * it ran; a token issued later with that explicit list is rewritten here, with v8's statement.
 * `[]` reads as the kind's full set in every binary, so this stays compatible.
 */
const FULL_V02 =
  '["sessions:read","sessions:write","sessions:takeover","attention:read","attention:resolve","vault:read","vault:write","vault:confirm","blocklist:read","blocklist:write","system:read","system:write","logs:read","notifications:read","notifications:write","channels:read","channels:write","preferences:write","mcp:tools"]';

const sql = `
CREATE TABLE templates (
  template_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('recording','ready','disabled')),
  owner TEXT NOT NULL,
  tenant_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('chromium','chrome','edge')),
  headless INTEGER NOT NULL DEFAULT 0 CHECK (headless IN (0,1)),
  stealth TEXT NOT NULL CHECK (stealth IN ('off','standard','max')),
  fingerprint INTEGER NOT NULL CHECK (fingerprint IN (0,1)),
  humanize INTEGER NOT NULL CHECK (humanize IN (0,1)),
  identity_json TEXT NOT NULL,
  identity_observed_json TEXT,
  proxy_json TEXT,
  agent_windows TEXT NOT NULL DEFAULT 'normal' CHECK (agent_windows IN ('normal','minimized')),
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',
  harnesses_json TEXT,
  max_concurrent INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent BETWEEN 1 AND 20),
  unseal_json TEXT NOT NULL DEFAULT '{}',
  health_interval_ms INTEGER NOT NULL CHECK (health_interval_ms BETWEEN 1800000 AND 604800000),
  prelaunch_check INTEGER NOT NULL DEFAULT 1 CHECK (prelaunch_check IN (0,1)),
  current_version INTEGER,
  checkpoint_at INTEGER,
  checkpoint_size_bytes INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  disabled_at INTEGER
) WITHOUT ROWID;
CREATE TABLE template_sites (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  pack_id TEXT,
  pack_version INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  write_policy TEXT CHECK (write_policy IN ('allow','warn','confirm')),
  vault_handle TEXT,
  auto_relogin INTEGER NOT NULL DEFAULT 0 CHECK (auto_relogin IN (0,1)),
  form_json TEXT,
  learned_cookie_names_json TEXT NOT NULL DEFAULT '[]',
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('unknown','signed_in','signed_out','challenged','inconclusive')),
  health_reason TEXT,
  health_checked_at INTEGER,
  health_changed_at INTEGER,
  consecutive_inconclusive INTEGER NOT NULL DEFAULT 0,
  stopped_at INTEGER,
  device_bound INTEGER NOT NULL DEFAULT 0 CHECK (device_bound IN (0,1)),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, site_id)
) WITHOUT ROWID;
CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('recording','relogin','restore','manual','import','signin_change','daily')),
  restored_from INTEGER,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL,
  structure_sha256 TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  health_json TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
) WITHOUT ROWID;
CREATE TABLE template_probes (
  seq INTEGER PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('signed_in','signed_out','challenged','inconclusive')),
  reason TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','prelaunch','recording','relogin','manual','host_start','attention','restore')),
  final_url TEXT,
  duration_ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_template_probes_template ON template_probes(template_id, site_id, at);
CREATE INDEX idx_template_probes_at ON template_probes(at);
ALTER TABLE sessions ADD COLUMN template_id TEXT REFERENCES templates(template_id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN template_name TEXT;
ALTER TABLE sessions ADD COLUMN template_version INTEGER;
ALTER TABLE sessions ADD COLUMN template_mode TEXT;
ALTER TABLE sessions ADD COLUMN sealed INTEGER CHECK (sealed IN (0,1));
CREATE INDEX idx_sessions_template ON sessions(template_id, created_at) WHERE template_id IS NOT NULL;
UPDATE credentials SET scopes_json = '[]'
WHERE kind = 'api_token'
  AND principal_id IN (SELECT principal_id FROM principals WHERE kind = 'operator')
  AND scopes_json = '${FULL_V02}';
`;

/**
 * Schema v9. `compatible`: four new tables, five nullable `sessions` columns and an index, plus one
 * data rewrite an older binary reads the same way (`[]` is the operator's full set), so
 * `meta.min_reader_version` is not raised. A virtual session is recorded as `persistence_mode =
 * 'memory'`, so the frozen `sessions` CHECKs need no rebuild (D-12).
 */
export const templates: Migration = {
  version: 9,
  name: 'templates',
  compatible: true,
  sql,
};
