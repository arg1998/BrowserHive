
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  app_version TEXT NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;


CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('operator','agent','service')),
  display TEXT NOT NULL,
  tenant_id TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
) WITHOUT ROWID;
CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('password','api_token')),
  public_prefix TEXT,
  secret_hash TEXT NOT NULL,
  display TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_credentials_prefix ON credentials(public_prefix) WHERE revoked_at IS NULL;
CREATE INDEX idx_credentials_principal ON credentials(principal_id);
CREATE TABLE auth_sessions (
  auth_session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_auth_sessions_principal ON auth_sessions(principal_id) WHERE revoked_at IS NULL;
CREATE TABLE grants (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(auth_session_id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) WITHOUT ROWID;
CREATE TABLE auth_events (
  seq INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('login_success','login_failure','lockout','logout','password_changed','token_issued','token_revoked','grant_issued','session_revoked','unauthorized')),
  principal_id TEXT,
  ip TEXT,
  user_agent TEXT,
  details_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_events_time ON auth_events(occurred_at);


CREATE TABLE mcp_connections (
  connection_id TEXT PRIMARY KEY,
  principal_id TEXT,
  transport TEXT NOT NULL CHECK (transport IN ('http','stdio')),
  mcp_session_id TEXT,
  client_name TEXT,
  client_version TEXT,
  protocol_version TEXT,
  capabilities_json TEXT,
  agent_name TEXT,
  model TEXT,
  harness TEXT,
  ip TEXT,
  user_agent TEXT,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_mcp_connections_open ON mcp_connections(last_seen_at) WHERE closed_at IS NULL;


CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  owner TEXT NOT NULL,
  tenant_id TEXT,
  connection_id TEXT REFERENCES mcp_connections(connection_id) ON DELETE SET NULL,
  engine TEXT NOT NULL DEFAULT 'chromium' CHECK (engine IN ('chromium')),
  channel TEXT NOT NULL CHECK (channel IN ('chromium','chrome','edge')),
  headless INTEGER NOT NULL CHECK (headless IN (0,1)),
  incognito INTEGER NOT NULL DEFAULT 0 CHECK (incognito IN (0,1)),
  persistence_mode TEXT NOT NULL CHECK (persistence_mode IN ('memory','persistent','storage-state')),
  disable_evaluate INTEGER NOT NULL DEFAULT 0 CHECK (disable_evaluate IN (0,1)),
  vault_enabled INTEGER NOT NULL DEFAULT 1 CHECK (vault_enabled IN (0,1)),
  stealth INTEGER NOT NULL CHECK (stealth IN (0,1)),
  fingerprint INTEGER NOT NULL CHECK (fingerprint IN (0,1)),
  humanize INTEGER NOT NULL CHECK (humanize IN (0,1)),
  identity_json TEXT,
  proxy_label TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','launching','live','paused','draining','closed','crashed')),
  created_at INTEGER NOT NULL,
  launched_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  lease_paused_at INTEGER,
  closed_at INTEGER,
  closed_reason TEXT CHECK (closed_reason IN ('user','operator','lease_expired','crash','shutdown','interrupted','launch_failed')),
  archived_at INTEGER,
  last_url TEXT,
  launch_ms INTEGER,
  config_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_sessions_open ON sessions(state) WHERE closed_at IS NULL;
CREATE INDEX idx_sessions_owner ON sessions(owner, created_at);
CREATE INDEX idx_sessions_created ON sessions(created_at, session_id);
CREATE INDEX idx_sessions_closed ON sessions(closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX idx_sessions_archived ON sessions(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX idx_sessions_lease ON sessions(lease_expires_at) WHERE closed_at IS NULL;


CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  tenant_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','operator','system')),
  actor_id TEXT,
  occurred_at INTEGER NOT NULL,
  trace_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_session ON events(session_id, seq);
CREATE INDEX idx_events_type_time ON events(type, occurred_at);
CREATE INDEX idx_events_time ON events(occurred_at);


CREATE TABLE tool_calls (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  connection_id TEXT,
  tool TEXT NOT NULL,
  tab_id TEXT,
  args_json TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  error_code TEXT,
  error_message TEXT,
  result_text TEXT,
  result_size_bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  seq INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_tool_calls_session_ts ON tool_calls(session_id, ts, event_id);
CREATE INDEX idx_tool_calls_ts ON tool_calls(ts, event_id);
CREATE INDEX idx_tool_calls_tool_ts ON tool_calls(tool, ts);
CREATE INDEX idx_tool_calls_error ON tool_calls(error_code, ts) WHERE error_code IS NOT NULL;
CREATE TABLE pages (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  domain TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('public','ip','local','ftp','other')),
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_pages_session_ts ON pages(session_id, ts, event_id);
CREATE INDEX idx_pages_ts ON pages(ts, event_id);
CREATE INDEX idx_pages_domain ON pages(domain, ts);
CREATE INDEX idx_pages_category_ts ON pages(category, ts);
CREATE TABLE screenshots (
  event_id TEXT PRIMARY KEY REFERENCES tool_calls(event_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool','trace')),
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_screenshots_session ON screenshots(session_id, ts);
CREATE TABLE vault_access (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_event_id TEXT,
  entry_name TEXT NOT NULL,
  handle TEXT,
  result TEXT NOT NULL CHECK (result IN ('success','origin_mismatch','auth_failed','blocked','denied')),
  reason TEXT,
  evaluate_enabled INTEGER NOT NULL CHECK (evaluate_enabled IN (0,1)),
  page_url TEXT NOT NULL,
  origin_check TEXT NOT NULL CHECK (origin_check IN ('pass','fail','skipped')),
  principal_id TEXT,
  details_json TEXT,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_vault_access_ts ON vault_access(ts, event_id);
CREATE INDEX idx_vault_access_session ON vault_access(session_id, ts);
CREATE INDEX idx_vault_access_entry ON vault_access(entry_name, ts);
CREATE TABLE blocked_requests (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_event_id TEXT,
  url TEXT NOT NULL,
  domain TEXT,
  pattern TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('tool','request')),
  tool TEXT,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_blocked_ts ON blocked_requests(ts, event_id);
CREATE INDEX idx_blocked_session ON blocked_requests(session_id, ts);
CREATE INDEX idx_blocked_pattern ON blocked_requests(pattern, ts);
CREATE INDEX idx_blocked_domain ON blocked_requests(domain, ts);


CREATE TABLE operator_requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('attention','vault_confirm')),
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
  resolved_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_operator_requests_open ON operator_requests(kind, created_at) WHERE status = 'pending';
CREATE INDEX idx_operator_requests_session ON operator_requests(session_id, created_at);
CREATE INDEX idx_operator_requests_history ON operator_requests(kind, created_at, request_id) WHERE status <> 'pending';
CREATE UNIQUE INDEX idx_operator_requests_idem ON operator_requests(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE operator_actions (
  seq INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT,
  details_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_operator_actions_time ON operator_actions(occurred_at);


CREATE TABLE vault_bindings (
  handle TEXT PRIMARY KEY,
  tenant_id TEXT,
  title TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_id TEXT NOT NULL DEFAULT '',
  group_id TEXT,
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',
  authorized_session_slugs_json TEXT NOT NULL DEFAULT '[]',
  allow_all_sessions INTEGER NOT NULL DEFAULT 0 CHECK (allow_all_sessions IN (0,1)),
  redact_username INTEGER NOT NULL DEFAULT 0 CHECK (redact_username IN (0,1)),
  require_no_evaluate INTEGER NOT NULL DEFAULT 0 CHECK (require_no_evaluate IN (0,1)),
  dashboard_confirm INTEGER NOT NULL DEFAULT 0 CHECK (dashboard_confirm IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_vault_bindings_group ON vault_bindings(group_id);
CREATE TABLE vault_group_policies (
  group_key TEXT PRIMARY KEY,
  group_id TEXT,
  tenant_id TEXT,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('manual','allow_all','reject_all')),
  allow_all_sessions INTEGER NOT NULL DEFAULT 0 CHECK (allow_all_sessions IN (0,1)),
  session_slug_globs_json TEXT NOT NULL DEFAULT '[]',
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',
  dashboard_confirm INTEGER NOT NULL DEFAULT 0 CHECK (dashboard_confirm IN (0,1)),
  require_no_evaluate INTEGER NOT NULL DEFAULT 0 CHECK (require_no_evaluate IN (0,1)),
  redact_username INTEGER NOT NULL DEFAULT 0 CHECK (redact_username IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;


CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  principal_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('attention','error','vault','lifecycle','system')),
  title TEXT NOT NULL,
  body TEXT,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  target TEXT,
  source_event_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  dismissed_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_notifications_inbox ON notifications(principal_id, created_at) WHERE dismissed_at IS NULL;
CREATE TABLE preferences (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, key)
) WITHOUT ROWID;


CREATE TABLE system_events (
  seq INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  message TEXT NOT NULL,
  details_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  resolved_at INTEGER
);
CREATE INDEX idx_system_events_open ON system_events(code) WHERE resolved_at IS NULL;
CREATE TABLE artifact_outbox (
  outbox_id INTEGER PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trace','screenshot','session_dir','backup')),
  path TEXT NOT NULL,
  session_id TEXT,
  enqueued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  route TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE logs (
  seq INTEGER PRIMARY KEY NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  module TEXT NOT NULL,
  msg TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  request_id TEXT,
  session_id TEXT,
  principal TEXT,
  fields_json TEXT
);
CREATE INDEX idx_logs_ts ON logs(ts);
CREATE INDEX idx_logs_trace ON logs(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_logs_session ON logs(session_id, ts) WHERE session_id IS NOT NULL;
CREATE TABLE resource_samples (
  ts INTEGER NOT NULL,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  cpu_pct REAL,
  rss_bytes INTEGER,
  host_free_bytes INTEGER,
  PRIMARY KEY (ts, session_id)
) WITHOUT ROWID;
