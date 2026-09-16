/** @module infra/persistence/migrations — the ordered migration list and the head version (D-04). */

import { initial } from './0001-initial.ts';
import { notificationGroups } from './0002-notification-groups.ts';
import type { Migration } from './migration.ts';

export type { Migration } from './migration.ts';

/** Every migration in apply order. Append only; never edit a shipped entry. */
export const MIGRATIONS: readonly Migration[] = [initial, notificationGroups];

/** The schema version this binary writes. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** `application_id` stamped on every BrowserHive database ("BHIV"). */
export const APPLICATION_ID = 0x42484956;

/** Table names of schema v1, in FK-safe delete order (children first). */
export const TABLES: readonly string[] = [
  'screenshots',
  'tool_calls',
  'pages',
  'vault_access',
  'blocked_requests',
  'operator_requests',
  'resource_samples',
  'events',
  'notifications',
  'sessions',
  'grants',
  'auth_sessions',
  'credentials',
  'preferences',
  'principals',
  'auth_events',
  'operator_actions',
  'mcp_connections',
  'vault_bindings',
  'vault_group_policies',
  'system_events',
  'artifact_outbox',
  'idempotency_keys',
  'logs',
  'schema_migrations',
  'meta',
];
