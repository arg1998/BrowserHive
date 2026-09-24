/** @module ports/persistence/records — readonly camelCase domain records stored by the repositories (spec 03 §7); the identity, vault and operations families live in sibling files and are re-exported here. */

import type {
  ActorKind,
  AttentionMode,
  BlockSource,
  ClosedReason,
  OperatorRequestKind,
  OperatorRequestStatus,
  OriginCheck,
  PageCategory,
  PersistenceMode,
  ScreenshotKind,
  SessionChannel,
  SessionEngine,
  SessionState,
  VaultAccessResult,
} from './enums.ts';

export type {
  AuthEventRecord,
  AuthSessionRecord,
  CredentialRecord,
  GrantRecord,
  McpConnectionRecord,
  NewAuthEvent,
  PrincipalRecord,
} from './records-identity.ts';
export type {
  ArtifactOutboxRecord,
  IdempotencyRecord,
  LogRecordRow,
  NewArtifact,
  NewSystemEvent,
  NotificationGroupPatch,
  NotificationRecord,
  PreferenceRecord,
  SystemEventRecord,
} from './records-operations.ts';
export type {
  VaultBindingRecord,
  VaultExportDocument,
  VaultGroupPolicyRecord,
} from './records-vault.ts';

import type { SessionClientInfo } from '../../domain/session/client-info.ts';
import type { JsonObject } from './json.ts';

export type { JsonObject, JsonValue } from './json.ts';

// --- infrastructure ---------------------------------------------------------------------------

/** One applied migration (`schema_migrations`). */
export interface SchemaMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: number;
  readonly durationMs: number;
  readonly appVersion: string;
}

// --- sessions ---------------------------------------------------------------------------------

/** A browser session state row (`sessions`). */
export interface SessionRecord {
  readonly sessionId: string;
  readonly slug: string;
  readonly owner: string;
  readonly tenantId: string | null;
  readonly connectionId: string | null;
  readonly engine: SessionEngine;
  readonly channel: SessionChannel;
  readonly headless: boolean;
  readonly incognito: boolean;
  readonly persistenceMode: PersistenceMode;
  readonly disableEvaluate: boolean;
  readonly vaultEnabled: boolean;
  readonly stealth: boolean;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
  readonly identity: JsonObject | null;
  readonly proxyLabel: string | null;
  readonly state: SessionState;
  readonly createdAt: number;
  readonly launchedAt: number | null;
  readonly lastActivityAt: number;
  readonly leaseExpiresAt: number;
  readonly leasePausedAt: number | null;
  readonly closedAt: number | null;
  readonly closedReason: ClosedReason | null;
  readonly archivedAt: number | null;
  readonly lastUrl: string | null;
  readonly launchMs: number | null;
  readonly config: JsonObject;
}

/** Mutable subset of {@link SessionRecord} accepted by `SessionRepository.update`. */
export type SessionPatch = Partial<
  Pick<
    SessionRecord,
    | 'connectionId'
    | 'identity'
    | 'proxyLabel'
    | 'state'
    | 'launchedAt'
    | 'lastActivityAt'
    | 'leaseExpiresAt'
    | 'leasePausedAt'
    | 'lastUrl'
    | 'launchMs'
    | 'closedAt'
    | 'closedReason'
  >
>;

/** Per-session aggregates joined onto list rows. */
export interface SessionCounts {
  readonly toolCalls: number;
  readonly errors: number;
  readonly pages: number;
  readonly blocked: number;
  readonly attentionOpen: number;
  readonly vaultAccess: number;
}

/** A session with its aggregates (list and detail views). */
export interface SessionListRow extends SessionRecord {
  readonly counts: SessionCounts;
  /** The launching connection's self-reported client (`mcp_connections`), `null` when unknown. */
  readonly client: SessionClientInfo | null;
}

// --- event log --------------------------------------------------------------------------------

/** One row of the ordered event log (`events`). `seq` is assigned on append. */
export interface EventRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly sessionId: string | null;
  readonly tenantId: string | null;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly occurredAt: number;
  readonly traceId: string | null;
  readonly payload: JsonObject;
}

/** Input for {@link EventRecord} (no `seq`). */
export type NewEvent = Omit<EventRecord, 'seq'>;

// --- typed fact tables ------------------------------------------------------------------------

/** A recorded tool invocation (`tool_calls`). */
export interface ToolCallRecord {
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly connectionId: string | null;
  readonly tool: string;
  readonly tabId: string | null;
  readonly args: JsonObject;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultText: string | null;
  readonly resultSizeBytes: number;
  readonly durationMs: number;
  readonly ts: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly seq: number;
}

/** A page visit (`pages`). */
export interface PageRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string | null;
  readonly domain: string;
  readonly category: PageCategory;
  readonly ts: number;
}

/** A screenshot file reference (`screenshots`); `eventId` is the owning tool call. */
export interface ScreenshotRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly kind: ScreenshotKind;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly ts: number;
}

/** A vault fill audit row (`vault_access`). */
export interface VaultAccessRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly toolEventId: string | null;
  readonly entryName: string;
  readonly handle: string | null;
  readonly result: VaultAccessResult;
  readonly reason: string | null;
  readonly evaluateEnabled: boolean;
  readonly pageUrl: string;
  readonly originCheck: OriginCheck;
  readonly principalId: string | null;
  readonly details: JsonObject | null;
  readonly ts: number;
}

/** A blocked URL attempt (`blocked_requests`). */
export interface BlockedRequestRecord {
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly toolEventId: string | null;
  readonly url: string;
  readonly domain: string | null;
  readonly pattern: string;
  readonly source: BlockSource;
  readonly tool: string | null;
  readonly ts: number;
}

// --- operator requests ------------------------------------------------------------------------

/** An attention or vault-confirm request (`operator_requests`, D-15). */
export interface OperatorRequestRecord {
  readonly requestId: string;
  readonly kind: OperatorRequestKind;
  readonly sessionId: string;
  readonly owner: string;
  readonly reason: string;
  readonly mode: AttentionMode | null;
  readonly entryName: string | null;
  readonly tool: string | null;
  readonly toolEventId: string | null;
  readonly pageUrl: string | null;
  readonly options: JsonObject | null;
  readonly idempotencyKey: string | null;
  readonly status: OperatorRequestStatus;
  readonly message: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly createdAt: number;
  readonly deadlineAt: number | null;
  readonly resolvedAt: number | null;
}

/** Input for a new operator request: always inserted as `pending`. */
export type NewOperatorRequest = Omit<
  OperatorRequestRecord,
  'status' | 'message' | 'resolvedBy' | 'resolutionReason' | 'resolvedAt'
>;

/** An operator audit row (`operator_actions`). */
export interface OperatorActionRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly principalId: string;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly details: JsonObject | null;
  readonly occurredAt: number;
}

/** Input for {@link OperatorActionRecord} (no `seq`). */
export type NewOperatorAction = Omit<OperatorActionRecord, 'seq'>;
