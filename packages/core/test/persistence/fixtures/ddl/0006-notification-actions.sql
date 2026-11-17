
CREATE TABLE notification_action_tokens (
  token_hash TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(channel_id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  op TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_notification_action_tokens_channel ON notification_action_tokens(channel_id);
CREATE INDEX idx_notification_action_tokens_notification ON notification_action_tokens(notification_id);
CREATE INDEX idx_notification_action_tokens_expiry ON notification_action_tokens(expires_at);

CREATE TABLE notification_actions (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  notification_id TEXT,
  action_id TEXT NOT NULL,
  action_label TEXT,
  op TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  actor_name TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('done','failed','not_allowed','used','expired','stale','wrong_channel','disabled')),
  detail TEXT
);
CREATE INDEX idx_notification_actions_at ON notification_actions(at);
CREATE INDEX idx_notification_actions_channel ON notification_actions(channel_id, seq);
CREATE INDEX idx_notification_actions_notification ON notification_actions(notification_id, seq) WHERE notification_id IS NOT NULL;

CREATE TABLE notification_cursors (
  cursor_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
