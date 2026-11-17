
ALTER TABLE notifications ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1);
ALTER TABLE notifications ADD COLUMN group_key TEXT;
UPDATE notifications SET updated_at = created_at;
CREATE INDEX idx_notifications_updated ON notifications(principal_id, updated_at) WHERE dismissed_at IS NULL;
CREATE INDEX idx_notifications_group ON notifications(group_key, updated_at) WHERE group_key IS NOT NULL AND read_at IS NULL AND dismissed_at IS NULL;
