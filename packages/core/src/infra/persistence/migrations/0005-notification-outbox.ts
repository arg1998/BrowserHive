/** @module infra/persistence/migrations/0005-notification-outbox — schema v5: the notification contract columns on `notifications` and the delivery outbox tables (spec 03 §7, §9; D-32, D-34, D-39). */

import {
  NOTIFICATION_CHANNEL_SOURCES,
  NOTIFICATION_CHANNEL_STATUSES,
  NOTIFICATION_DELIVERY_OPS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_STATES,
} from '../../../ports/persistence/enums.ts';
import type { Migration } from './migration.ts';
import { sqlIn } from './sql-enums.ts';

/*
 * The classification columns are nullable and `kind`/`category` carry no CHECK: an older binary in
 * the compatibility window may still insert rows without them (readers derive the values from
 * `type`, `classifyLegacy`), and new kinds must not need a table rebuild. The backfill uses facts
 * only: the row's own `type`, `title`, `group_key` and ids, and the request or degradation its
 * `source_event_id` points at. `message_json` stays NULL for existing rows.
 */
const sql = `
ALTER TABLE notifications ADD COLUMN kind TEXT;
ALTER TABLE notifications ADD COLUMN category TEXT;
ALTER TABLE notifications ADD COLUMN severity TEXT CHECK (severity IN (${sqlIn(NOTIFICATION_SEVERITIES)}));
ALTER TABLE notifications ADD COLUMN state TEXT CHECK (state IN (${sqlIn(NOTIFICATION_STATES)}));
ALTER TABLE notifications ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE notifications ADD COLUMN thread TEXT;
ALTER TABLE notifications ADD COLUMN message_json TEXT;

UPDATE notifications SET kind = CASE
  WHEN type = 'attention' THEN 'attention.requested'
  WHEN type = 'vault' THEN 'vault.confirm'
  WHEN type = 'lifecycle' THEN 'session.reaped'
  WHEN type = 'system' THEN 'system.degraded'
  WHEN title = 'Session crashed' THEN 'session.crashed'
  ELSE 'tool.errors' END;

UPDATE notifications SET
  category = CASE kind
    WHEN 'attention.requested' THEN 'needs-you'
    WHEN 'vault.confirm' THEN 'needs-you'
    WHEN 'system.degraded' THEN 'system'
    ELSE 'problems' END,
  severity = CASE kind
    WHEN 'session.crashed' THEN 'error'
    WHEN 'system.degraded' THEN 'error'
    ELSE 'warn' END,
  state = CASE
    WHEN kind IN ('attention.requested', 'vault.confirm') THEN COALESCE((
      SELECT CASE r.status
        WHEN 'pending' THEN 'open'
        WHEN 'resolved' THEN 'resolved'
        WHEN 'rejected' THEN 'resolved'
        WHEN 'timeout' THEN 'expired'
        ELSE 'final' END
      FROM operator_requests r WHERE r.request_id = notifications.source_event_id), 'final')
    WHEN kind = 'system.degraded' THEN COALESCE((
      SELECT CASE WHEN e.resolved_at IS NULL THEN 'open' ELSE 'resolved' END
      FROM system_events e WHERE e.event_id = notifications.source_event_id), 'final')
    WHEN kind = 'tool.errors' THEN 'open'
    ELSE 'final' END,
  thread = CASE
    WHEN kind = 'attention.requested' AND source_event_id IS NOT NULL THEN 'attention:' || source_event_id
    WHEN kind = 'vault.confirm' AND source_event_id IS NOT NULL THEN 'vault:' || source_event_id
    WHEN kind = 'tool.errors' THEN COALESCE(group_key, 'tool-errors:' || COALESCE(session_id, 'none'))
    WHEN kind IN ('session.crashed', 'session.reaped') AND session_id IS NOT NULL THEN 'session:' || session_id
    WHEN kind = 'system.degraded' AND source_event_id IS NOT NULL THEN 'system:' || source_event_id
    ELSE 'notification:' || notification_id END;

CREATE INDEX idx_notifications_thread ON notifications(thread, created_at) WHERE thread IS NOT NULL;

CREATE TABLE notification_channels (
  channel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  mode TEXT,
  source TEXT NOT NULL DEFAULT 'db' CHECK (source IN (${sqlIn(NOTIFICATION_CHANNEL_SOURCES)})),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${sqlIn(NOTIFICATION_CHANNEL_STATUSES)})),
  target_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  rules_json TEXT NOT NULL DEFAULT '{}',
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT,
  last_ok_at INTEGER,
  last_failure_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE notification_deliveries (
  seq INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(channel_id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  op TEXT NOT NULL CHECK (op IN (${sqlIn(NOTIFICATION_DELIVERY_OPS)})),
  status TEXT NOT NULL CHECK (status IN (${sqlIn(NOTIFICATION_DELIVERY_STATUSES)})),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  last_error TEXT,
  duration_ms INTEGER,
  message_ref_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_notification_deliveries_idem ON notification_deliveries(channel_id, notification_id, revision, op);
CREATE INDEX idx_notification_deliveries_due ON notification_deliveries(next_attempt_at, seq) WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_notification_deliveries_sending ON notification_deliveries(updated_at) WHERE status = 'sending';
CREATE INDEX idx_notification_deliveries_channel ON notification_deliveries(channel_id, seq);
CREATE INDEX idx_notification_deliveries_notification ON notification_deliveries(notification_id, seq);
CREATE INDEX idx_notification_deliveries_updated ON notification_deliveries(updated_at);

CREATE TABLE notification_channel_messages (
  channel_id TEXT NOT NULL REFERENCES notification_channels(channel_id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
  thread TEXT NOT NULL,
  message_ref_json TEXT NOT NULL,
  last_revision INTEGER NOT NULL CHECK (last_revision >= 1),
  sent_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (channel_id, notification_id)
) WITHOUT ROWID;
CREATE INDEX idx_notification_channel_messages_expiry ON notification_channel_messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_notification_channel_messages_thread ON notification_channel_messages(channel_id, thread, sent_at);
`;

/**
 * Schema v5. `compatible`: purely additive (nullable columns, new tables), so a v4 reader still
 * understands every table it knows; rows it inserts read their classification from `type`.
 */
export const notificationOutbox: Migration = {
  version: 5,
  name: 'notification-outbox',
  compatible: true,
  sql,
};
