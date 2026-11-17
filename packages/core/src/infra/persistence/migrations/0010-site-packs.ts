/** @module infra/persistence/migrations/0010-site-packs — schema v10: site-pack approval state, candidate and decision history, guard-hit audit, and the `security_intercept` operator request (spec 13 §9.9, D-15, D-54). */

import type { Migration } from './migration.ts';
import { enumCol, sqlIn } from './sql-enums.ts';

/*
 * Every CHECK list below is a literal frozen in this file, never built from a live constant
 * (spec 13 §9.9): a later binary that grows an enum must not change what this migration wrote.
 */
const KINDS = ['attention', 'vault_confirm', 'security_intercept'] as const;
const MODES = ['takeover', 'notify'] as const;
const STATUSES = ['pending', 'resolved', 'rejected', 'timeout', 'cancelled'] as const;
const PACK_SOURCES = ['bundled', 'remote', 'import', 'local'] as const;
const CLASSIFICATIONS = [
  'unclassified',
  'tightening',
  'restrictive',
  'loosening',
  'neutral',
  'new_pack',
  'revoked',
  'local_override',
] as const;
const DECISIONS = [
  'available',
  'downloaded',
  'auto',
  'approved',
  'rejected',
  'superseded',
  'reverted',
] as const;
const GUARD_KINDS = ['logout', 'account', 'credential', 'destructive', 'write', 'stop'] as const;
const GUARD_ACTIONS = ['block', 'confirm', 'warn', 'paced', 'held'] as const;
const GUARD_OUTCOMES = ['approved', 'denied', 'timeout', 'cancelled'] as const;
const GUARD_SOURCES = ['tool', 'request', 'element'] as const;

const COPIED = `request_id, kind, session_id, owner, reason, mode, entry_name, tool, tool_event_id, page_url,
  options_json, idempotency_key, status, message, resolved_by, resolution_reason, created_at,
  deadline_at, resolved_at`;

/*
 * `operator_requests.kind` has a CHECK, so adding `security_intercept` rebuilds the table (SQLite's
 * twelve-step procedure; the runner holds `foreign_keys=OFF` around every migration and runs
 * `foreign_key_check` before COMMIT). Same columns, indexes and data, plus `template_id`.
 */
const rebuildOperatorRequests = `
CREATE TABLE operator_requests_v10 (
  request_id TEXT PRIMARY KEY,
  ${enumCol('kind', KINDS)},
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  ${enumCol('mode', MODES, true)},
  entry_name TEXT,
  tool TEXT,
  tool_event_id TEXT,
  page_url TEXT,
  options_json TEXT,
  idempotency_key TEXT,
  ${enumCol('status', STATUSES)},
  message TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER,
  resolved_at INTEGER,
  template_id TEXT
) WITHOUT ROWID;
INSERT INTO operator_requests_v10 (${COPIED})
  SELECT ${COPIED} FROM operator_requests;
DROP TABLE operator_requests;
ALTER TABLE operator_requests_v10 RENAME TO operator_requests;
CREATE INDEX idx_operator_requests_open ON operator_requests(kind, created_at) WHERE status = 'pending';
CREATE INDEX idx_operator_requests_session ON operator_requests(session_id, created_at);
CREATE INDEX idx_operator_requests_history ON operator_requests(kind, created_at, request_id) WHERE status <> 'pending';
CREATE UNIQUE INDEX idx_operator_requests_idem ON operator_requests(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_operator_requests_template ON operator_requests(template_id, created_at) WHERE status = 'pending' AND template_id IS NOT NULL;
`;

const sitePackTables = `
CREATE TABLE site_pack_state (
  pack_id TEXT PRIMARY KEY,
  approved_version INTEGER,
  approved_sha256 TEXT,
  ${enumCol('approved_source', PACK_SOURCES, true)},
  approved_provenance_json TEXT,
  approved_domains_json TEXT NOT NULL DEFAULT '[]',
  approved_by TEXT,
  approved_at INTEGER,
  previous_version INTEGER,
  previous_sha256 TEXT,
  previous_source TEXT,
  local_path TEXT,
  local_approved_sha256 TEXT,
  local_approved_by TEXT,
  local_approved_at INTEGER,
  pinned_version INTEGER,
  follow INTEGER CHECK (follow IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE site_pack_changes (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  pack_id TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER,
  to_sha256 TEXT NOT NULL,
  ${enumCol('source', PACK_SOURCES)},
  ${enumCol('classification', CLASSIFICATIONS)},
  new_domains_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  diff_json TEXT,
  ${enumCol('decision', DECISIONS)},
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_site_pack_changes_pack ON site_pack_changes(pack_id, seq);
CREATE INDEX idx_site_pack_changes_pending ON site_pack_changes(created_at) WHERE decision IN (${sqlIn(['available', 'downloaded'])});
CREATE TABLE site_guard_hits (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  template_id TEXT,
  pack_id TEXT NOT NULL,
  guard_id TEXT NOT NULL,
  ${enumCol('guard_kind', GUARD_KINDS)},
  ${enumCol('action', GUARD_ACTIONS)},
  ${enumCol('outcome', GUARD_OUTCOMES, true)},
  decided_by TEXT,
  ${enumCol('source', GUARD_SOURCES)},
  method TEXT,
  url TEXT NOT NULL,
  request_id TEXT,
  tool TEXT,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_site_guard_hits_ts ON site_guard_hits(ts, event_id);
CREATE INDEX idx_site_guard_hits_session ON site_guard_hits(session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX idx_site_guard_hits_template ON site_guard_hits(template_id, ts);
`;

/**
 * Schema v10. **Incompatible** (spec 13 §9.9, accepted by the owner 2026-11-08): the
 * `operator_requests` rebuild widens a CHECK that older binaries would not accept rows under, so
 * `meta.min_reader_version` rises to 10 and every older binary refuses the database with
 * `DB_NEWER_THAN_BINARY`; downgrading means restoring the pre-upgrade backup (D-04).
 */
export const sitePacks: Migration = {
  version: 10,
  name: 'site-packs',
  compatible: false,
  sql: rebuildOperatorRequests + sitePackTables,
};
