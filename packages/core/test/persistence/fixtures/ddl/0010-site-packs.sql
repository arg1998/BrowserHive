
CREATE TABLE operator_requests_v10 (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('attention','vault_confirm','security_intercept')),
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT CHECK (mode IN ('takeover','notify')),
  entry_name TEXT,
  tool TEXT,
  tool_event_id TEXT,
  page_url TEXT,
  options_json TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','resolved','rejected','timeout','cancelled')),
  message TEXT,
  resolved_by TEXT,
  resolution_reason TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER,
  resolved_at INTEGER,
  template_id TEXT
) WITHOUT ROWID;
INSERT INTO operator_requests_v10 (request_id, kind, session_id, owner, reason, mode, entry_name, tool, tool_event_id, page_url,
  options_json, idempotency_key, status, message, resolved_by, resolution_reason, created_at,
  deadline_at, resolved_at)
  SELECT request_id, kind, session_id, owner, reason, mode, entry_name, tool, tool_event_id, page_url,
  options_json, idempotency_key, status, message, resolved_by, resolution_reason, created_at,
  deadline_at, resolved_at FROM operator_requests;
DROP TABLE operator_requests;
ALTER TABLE operator_requests_v10 RENAME TO operator_requests;
CREATE INDEX idx_operator_requests_open ON operator_requests(kind, created_at) WHERE status = 'pending';
CREATE INDEX idx_operator_requests_session ON operator_requests(session_id, created_at);
CREATE INDEX idx_operator_requests_history ON operator_requests(kind, created_at, request_id) WHERE status <> 'pending';
CREATE UNIQUE INDEX idx_operator_requests_idem ON operator_requests(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_operator_requests_template ON operator_requests(template_id, created_at) WHERE status = 'pending' AND template_id IS NOT NULL;

CREATE TABLE site_pack_state (
  pack_id TEXT PRIMARY KEY,
  approved_version INTEGER,
  approved_sha256 TEXT,
  approved_source TEXT CHECK (approved_source IN ('bundled','remote','import','local')),
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
  source TEXT NOT NULL CHECK (source IN ('bundled','remote','import','local')),
  classification TEXT NOT NULL CHECK (classification IN ('unclassified','tightening','restrictive','loosening','neutral','new_pack','revoked','local_override')),
  new_domains_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  diff_json TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('available','downloaded','auto','approved','rejected','superseded','reverted')),
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_site_pack_changes_pack ON site_pack_changes(pack_id, seq);
CREATE INDEX idx_site_pack_changes_pending ON site_pack_changes(created_at) WHERE decision IN ('available','downloaded');
CREATE TABLE site_guard_hits (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  template_id TEXT,
  pack_id TEXT NOT NULL,
  guard_id TEXT NOT NULL,
  guard_kind TEXT NOT NULL CHECK (guard_kind IN ('logout','account','credential','destructive','write','stop')),
  action TEXT NOT NULL CHECK (action IN ('block','confirm','warn','paced','held')),
  outcome TEXT CHECK (outcome IN ('approved','denied','timeout','cancelled')),
  decided_by TEXT,
  source TEXT NOT NULL CHECK (source IN ('tool','request','element')),
  method TEXT,
  url TEXT NOT NULL,
  request_id TEXT,
  tool TEXT,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_site_guard_hits_ts ON site_guard_hits(ts, event_id);
CREATE INDEX idx_site_guard_hits_session ON site_guard_hits(session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX idx_site_guard_hits_template ON site_guard_hits(template_id, ts);
