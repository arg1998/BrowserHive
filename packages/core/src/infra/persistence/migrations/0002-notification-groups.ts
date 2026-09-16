/** @module infra/persistence/migrations/0002-notification-groups — schema v2: coalesced notifications (`count`, `updated_at`, `group_key`) so repeated tool errors fold into one row per session. */

import type { Migration } from './migration.ts';

const sql = `
ALTER TABLE notifications ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1);
ALTER TABLE notifications ADD COLUMN group_key TEXT;
UPDATE notifications SET updated_at = created_at;
CREATE INDEX idx_notifications_updated ON notifications(principal_id, updated_at) WHERE dismissed_at IS NULL;
CREATE INDEX idx_notifications_group ON notifications(group_key, updated_at) WHERE group_key IS NOT NULL AND read_at IS NULL AND dismissed_at IS NULL;
`;

/**
 * Schema v2. `compatible`: purely additive, so a v1 reader still understands every table (it just
 * ignores the new columns and sees each group as one row).
 */
export const notificationGroups: Migration = {
  version: 2,
  name: 'notification-groups',
  compatible: true,
  sql,
};
