/** @module infra/persistence/repositories — binds every SQLite repository to one Kysely handle (connection or transaction). */

import type { Kysely } from 'kysely';
import type { Repositories } from '../../../ports/persistence/unit-of-work.ts';
import type { DB } from '../generated/db.d.ts';
import { SqliteLogRepository } from '../log-rows.ts';
import {
  SqliteAuthEventRepository,
  SqliteAuthSessionRepository,
  SqliteGrantRepository,
} from './auth.ts';
import { SqliteBlocklistAuditRepository } from './blocklist-audit.ts';
import { SqliteEventLogRepository } from './event-log.ts';
import { SqliteCredentialRepository, SqlitePrincipalRepository } from './identity.ts';
import { SqliteNotificationRepository, SqlitePreferenceRepository } from './notifications.ts';
import {
  SqliteArtifactOutboxRepository,
  SqliteIdempotencyRepository,
  SqliteMcpConnectionRepository,
  SqliteSchemaMigrationRepository,
  SqliteSystemEventRepository,
} from './operations.ts';
import {
  SqliteOperatorActionRepository,
  SqliteOperatorRequestRepository,
} from './operator-requests.ts';
import { SqlitePageRepository } from './pages.ts';
import { SqliteScreenshotRepository } from './screenshots.ts';
import { SqliteSessionRepository } from './sessions.ts';
import { SqliteToolCallRepository } from './tool-calls.ts';
import { SqliteVaultAuditRepository } from './vault-audit.ts';
import { SqliteVaultBindingRepository, SqliteVaultGroupPolicyRepository } from './vault-policy.ts';

/** Builds the full repository bundle over `db` (a `Kysely<DB>` or a `Transaction<DB>`). */
export function createRepositories(db: Kysely<DB>): Repositories {
  return {
    logs: new SqliteLogRepository(db),
    sessions: new SqliteSessionRepository(db),
    toolCalls: new SqliteToolCallRepository(db),
    pages: new SqlitePageRepository(db),
    screenshots: new SqliteScreenshotRepository(db),
    vaultAudit: new SqliteVaultAuditRepository(db),
    blocklistAudit: new SqliteBlocklistAuditRepository(db),
    operatorRequests: new SqliteOperatorRequestRepository(db),
    operatorActions: new SqliteOperatorActionRepository(db),
    events: new SqliteEventLogRepository(db),
    principals: new SqlitePrincipalRepository(db),
    credentials: new SqliteCredentialRepository(db),
    authSessions: new SqliteAuthSessionRepository(db),
    grants: new SqliteGrantRepository(db),
    authEvents: new SqliteAuthEventRepository(db),
    vaultBindings: new SqliteVaultBindingRepository(db),
    vaultGroupPolicies: new SqliteVaultGroupPolicyRepository(db),
    notifications: new SqliteNotificationRepository(db),
    preferences: new SqlitePreferenceRepository(db),
    systemEvents: new SqliteSystemEventRepository(db),
    idempotency: new SqliteIdempotencyRepository(db),
    artifactOutbox: new SqliteArtifactOutboxRepository(db),
    mcpConnections: new SqliteMcpConnectionRepository(db),
    schemaMigrations: new SqliteSchemaMigrationRepository(db),
  };
}
