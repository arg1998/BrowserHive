/** @module ports/persistence/unit-of-work — the repository bundle and the transaction boundary. */

import type { BlocklistAuditRepository } from './blocklist-audit.ts';
import type { EventLogRepository } from './event-log.ts';
import type {
  AuthEventRepository,
  AuthSessionRepository,
  CredentialRepository,
  GrantRepository,
  PrincipalRepository,
} from './identity.ts';
import type { NotificationRepository, PreferenceRepository } from './notifications.ts';
import type {
  ArtifactOutboxRepository,
  IdempotencyRepository,
  LogRepository,
  McpConnectionRepository,
  OperatorActionRepository,
  SchemaMigrationRepository,
  SystemEventRepository,
} from './operations.ts';
import type { OperatorRequestRepository } from './operator-requests.ts';
import type { PageRepository } from './pages.ts';
import type { ScreenshotRepository } from './screenshots.ts';
import type { SessionRepository } from './sessions.ts';
import type { ToolCallRepository } from './tool-calls.ts';
import type { VaultAuditRepository } from './vault-audit.ts';
import type { VaultBindingRepository, VaultGroupPolicyRepository } from './vault-policy.ts';

/** Every repository, bound to one connection (or one transaction inside {@link UnitOfWork}). */
export interface Repositories {
  readonly sessions: SessionRepository;
  readonly toolCalls: ToolCallRepository;
  readonly pages: PageRepository;
  readonly screenshots: ScreenshotRepository;
  readonly vaultAudit: VaultAuditRepository;
  readonly blocklistAudit: BlocklistAuditRepository;
  readonly operatorRequests: OperatorRequestRepository;
  readonly operatorActions: OperatorActionRepository;
  readonly events: EventLogRepository;
  readonly principals: PrincipalRepository;
  readonly credentials: CredentialRepository;
  readonly authSessions: AuthSessionRepository;
  readonly grants: GrantRepository;
  readonly authEvents: AuthEventRepository;
  readonly vaultBindings: VaultBindingRepository;
  readonly vaultGroupPolicies: VaultGroupPolicyRepository;
  readonly notifications: NotificationRepository;
  readonly preferences: PreferenceRepository;
  readonly systemEvents: SystemEventRepository;
  readonly idempotency: IdempotencyRepository;
  readonly logs: LogRepository;
  readonly artifactOutbox: ArtifactOutboxRepository;
  readonly mcpConnections: McpConnectionRepository;
  readonly schemaMigrations: SchemaMigrationRepository;
}

/**
 * Transaction boundary. `fn` receives repositories bound to one `BEGIN IMMEDIATE` transaction;
 * a thrown error rolls back and is rethrown, a returned value commits.
 */
export interface UnitOfWork {
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}
