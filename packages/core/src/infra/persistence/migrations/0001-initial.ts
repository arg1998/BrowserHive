/** @module infra/persistence/migrations/0001-initial — schema v1: every table of spec 03 §7. */

import {
  ACTOR_KINDS,
  ARTIFACT_KINDS,
  ATTENTION_MODES,
  AUTH_EVENT_TYPES,
  BLOCK_SOURCES,
  CLOSED_REASONS,
  CREDENTIAL_KINDS,
  MCP_TRANSPORTS,
  NOTIFICATION_TYPES,
  OPERATOR_REQUEST_KINDS,
  OPERATOR_REQUEST_STATUSES,
  ORIGIN_CHECKS,
  PAGE_CATEGORIES,
  PERSISTENCE_MODES,
  PRINCIPAL_KINDS,
  SCREENSHOT_KINDS,
  SESSION_CHANNELS,
  SESSION_ENGINES,
  SESSION_STATES,
  SYSTEM_EVENT_SEVERITIES,
  VAULT_ACCESS_MODES,
  VAULT_ACCESS_RESULTS,
} from '../../../ports/persistence/enums.ts';
import type { Migration } from './migration.ts';
import { boolCol, enumCol } from './sql-enums.ts';

const infrastructure = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  app_version TEXT NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

const identity = `
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  ${enumCol('kind', PRINCIPAL_KINDS)},
  display TEXT NOT NULL,
  tenant_id TEXT,
  ${boolCol('must_change_password', 0)},
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
) WITHOUT ROWID;
CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  ${enumCol('kind', CREDENTIAL_KINDS)},
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
  ${enumCol('type', AUTH_EVENT_TYPES)},
  principal_id TEXT,
  ip TEXT,
  user_agent TEXT,
  details_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_events_time ON auth_events(occurred_at);
`;

const mcp = `
CREATE TABLE mcp_connections (
  connection_id TEXT PRIMARY KEY,
  principal_id TEXT,
  ${enumCol('transport', MCP_TRANSPORTS)},
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
`;

const sessions = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  owner TEXT NOT NULL,
  tenant_id TEXT,
  connection_id TEXT REFERENCES mcp_connections(connection_id) ON DELETE SET NULL,
  engine TEXT NOT NULL DEFAULT 'chromium' CHECK (engine IN ('${SESSION_ENGINES.join("','")}')),
  ${enumCol('channel', SESSION_CHANNELS)},
  ${boolCol('headless')},
  ${boolCol('incognito', 0)},
  ${enumCol('persistence_mode', PERSISTENCE_MODES)},
  ${boolCol('disable_evaluate', 0)},
  ${boolCol('vault_enabled', 1)},
  ${boolCol('stealth')},
  ${boolCol('fingerprint')},
  ${boolCol('humanize')},
  identity_json TEXT,
  proxy_label TEXT,
  ${enumCol('state', SESSION_STATES)},
  created_at INTEGER NOT NULL,
  launched_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  lease_paused_at INTEGER,
  closed_at INTEGER,
  ${enumCol('closed_reason', CLOSED_REASONS, true)},
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
`;

const events = `
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  tenant_id TEXT,
  ${enumCol('actor_kind', ACTOR_KINDS)},
  actor_id TEXT,
  occurred_at INTEGER NOT NULL,
  trace_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_session ON events(session_id, seq);
CREATE INDEX idx_events_type_time ON events(type, occurred_at);
CREATE INDEX idx_events_time ON events(occurred_at);
`;

const facts = `
CREATE TABLE tool_calls (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  connection_id TEXT,
  tool TEXT NOT NULL,
  tab_id TEXT,
  args_json TEXT NOT NULL,
  ${boolCol('ok')},
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
  ${enumCol('category', PAGE_CATEGORIES)},
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
  ${enumCol('kind', SCREENSHOT_KINDS)},
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
  ${enumCol('result', VAULT_ACCESS_RESULTS)},
  reason TEXT,
  ${boolCol('evaluate_enabled')},
  page_url TEXT NOT NULL,
  ${enumCol('origin_check', ORIGIN_CHECKS)},
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
  ${enumCol('source', BLOCK_SOURCES)},
  tool TEXT,
  ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_blocked_ts ON blocked_requests(ts, event_id);
CREATE INDEX idx_blocked_session ON blocked_requests(session_id, ts);
CREATE INDEX idx_blocked_pattern ON blocked_requests(pattern, ts);
CREATE INDEX idx_blocked_domain ON blocked_requests(domain, ts);
`;

const operatorRequests = `
CREATE TABLE operator_requests (
  request_id TEXT PRIMARY KEY,
  ${enumCol('kind', OPERATOR_REQUEST_KINDS)},
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  ${enumCol('mode', ATTENTION_MODES, true)},
  entry_name TEXT,
  tool TEXT,
  tool_event_id TEXT,
  page_url TEXT,
  options_json TEXT,
  idempotency_key TEXT,
  ${enumCol('status', OPERATOR_REQUEST_STATUSES)},
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
`;

const vault = `
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
  ${boolCol('allow_all_sessions', 0)},
  ${boolCol('redact_username', 0)},
  ${boolCol('require_no_evaluate', 0)},
  ${boolCol('dashboard_confirm', 0)},
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_vault_bindings_group ON vault_bindings(group_id);
CREATE TABLE vault_group_policies (
  group_key TEXT PRIMARY KEY,
  group_id TEXT,
  tenant_id TEXT,
  ${enumCol('access_mode', VAULT_ACCESS_MODES)},
  ${boolCol('allow_all_sessions', 0)},
  session_slug_globs_json TEXT NOT NULL DEFAULT '[]',
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',
  ${boolCol('dashboard_confirm', 0)},
  ${boolCol('require_no_evaluate', 0)},
  ${boolCol('redact_username', 0)},
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

const notifications = `
CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  principal_id TEXT,
  ${enumCol('type', NOTIFICATION_TYPES)},
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
`;

const operations = `
CREATE TABLE system_events (
  seq INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  ${enumCol('severity', SYSTEM_EVENT_SEVERITIES)},
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
  ${enumCol('kind', ARTIFACT_KINDS)},
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
`;

/** Schema v1. Not `compatible`: it defines the floor every reader must understand. */
export const initial: Migration = {
  version: 1,
  name: 'initial',
  compatible: false,
  sql: [
    infrastructure,
    identity,
    mcp,
    sessions,
    events,
    facts,
    operatorRequests,
    vault,
    notifications,
    operations,
  ].join('\n'),
};
