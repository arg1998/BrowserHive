/** @module ports/persistence/enums — closed value sets stored in CHECK-constrained columns (spec 03 §7). */

/*
 * One source for the SQL `CHECK (col IN (...))` lists, the row parsers and the record types.
 * When `@browserhive/contracts/enums` lands, these tuples must stay byte-identical to the zod
 * enums there (a lint test in contracts is the intended guard).
 */

/** Who a principal is (D-09). */
export const PRINCIPAL_KINDS = ['operator', 'agent', 'service'] as const;
/** Element of {@link PRINCIPAL_KINDS}. */
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Secret kinds stored hashed in `credentials`. */
export const CREDENTIAL_KINDS = ['password', 'api_token'] as const;
/** Element of {@link CREDENTIAL_KINDS}. */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Audit event types in `auth_events`. */
export const AUTH_EVENT_TYPES = [
  'login_success',
  'login_failure',
  'lockout',
  'logout',
  'password_changed',
  'token_issued',
  'token_revoked',
  'grant_issued',
  'session_revoked',
  'unauthorized',
] as const;
/** Element of {@link AUTH_EVENT_TYPES}. */
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/** MCP transports recorded on `mcp_connections`. */
export const MCP_TRANSPORTS = ['http', 'stdio'] as const;
/** Element of {@link MCP_TRANSPORTS}. */
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** Browser engines (v1: chromium only). */
export const SESSION_ENGINES = ['chromium'] as const;
/** Element of {@link SESSION_ENGINES}. */
export type SessionEngine = (typeof SESSION_ENGINES)[number];

/** Browser channels a session can launch on. */
export const SESSION_CHANNELS = ['chromium', 'chrome', 'edge'] as const;
/** Element of {@link SESSION_CHANNELS}. */
export type SessionChannel = (typeof SESSION_CHANNELS)[number];

/** Session storage persistence modes. */
export const PERSISTENCE_MODES = ['memory', 'persistent', 'storage-state'] as const;
/** Element of {@link PERSISTENCE_MODES}. */
export type PersistenceMode = (typeof PERSISTENCE_MODES)[number];

/** Session lifecycle states (D-21). */
export const SESSION_STATES = [
  'reserved',
  'launching',
  'live',
  'paused',
  'draining',
  'closed',
  'crashed',
] as const;
/** Element of {@link SESSION_STATES}. */
export type SessionState = (typeof SESSION_STATES)[number];

/** Why a session closed. */
export const CLOSED_REASONS = [
  'user',
  'operator',
  'lease_expired',
  'crash',
  'shutdown',
  'interrupted',
  'launch_failed',
] as const;
/** Element of {@link CLOSED_REASONS}. */
export type ClosedReason = (typeof CLOSED_REASONS)[number];

/** Who caused an event-log entry. */
export const ACTOR_KINDS = ['agent', 'operator', 'system'] as const;
/** Element of {@link ACTOR_KINDS}. */
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** URL classification of a visited page. */
export const PAGE_CATEGORIES = ['public', 'ip', 'local', 'ftp', 'other'] as const;
/** Element of {@link PAGE_CATEGORIES}. */
export type PageCategory = (typeof PAGE_CATEGORIES)[number];

/** Origin of a screenshot row. */
export const SCREENSHOT_KINDS = ['tool', 'trace'] as const;
/** Element of {@link SCREENSHOT_KINDS}. */
export type ScreenshotKind = (typeof SCREENSHOT_KINDS)[number];

/** Outcome of a vault fill attempt. */
export const VAULT_ACCESS_RESULTS = [
  'success',
  'origin_mismatch',
  'auth_failed',
  'blocked',
  'denied',
] as const;
/** Element of {@link VAULT_ACCESS_RESULTS}. */
export type VaultAccessResult = (typeof VAULT_ACCESS_RESULTS)[number];

/** Origin check verdict on a vault fill. */
export const ORIGIN_CHECKS = ['pass', 'fail', 'skipped'] as const;
/** Element of {@link ORIGIN_CHECKS}. */
export type OriginCheck = (typeof ORIGIN_CHECKS)[number];

/** Where a blocked URL was intercepted. */
export const BLOCK_SOURCES = ['tool', 'request'] as const;
/** Element of {@link BLOCK_SOURCES}. */
export type BlockSource = (typeof BLOCK_SOURCES)[number];

/** Operator request kinds (D-15). */
export const OPERATOR_REQUEST_KINDS = ['attention', 'vault_confirm'] as const;
/** Element of {@link OPERATOR_REQUEST_KINDS}. */
export type OperatorRequestKind = (typeof OPERATOR_REQUEST_KINDS)[number];

/** Attention modes. */
export const ATTENTION_MODES = ['takeover', 'notify'] as const;
/** Element of {@link ATTENTION_MODES}. */
export type AttentionMode = (typeof ATTENTION_MODES)[number];

/** Operator request statuses; `pending` is the only open state. */
export const OPERATOR_REQUEST_STATUSES = [
  'pending',
  'resolved',
  'rejected',
  'timeout',
  'cancelled',
] as const;
/** Element of {@link OPERATOR_REQUEST_STATUSES}. */
export type OperatorRequestStatus = (typeof OPERATOR_REQUEST_STATUSES)[number];

/** Vault group policy access modes. */
export const VAULT_ACCESS_MODES = ['manual', 'allow_all', 'reject_all'] as const;
/** Element of {@link VAULT_ACCESS_MODES}. */
export type VaultAccessMode = (typeof VAULT_ACCESS_MODES)[number];

/** Notification types (D-16). */
export const NOTIFICATION_TYPES = ['attention', 'error', 'vault', 'lifecycle', 'system'] as const;
/** Element of {@link NOTIFICATION_TYPES}. */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Severity of a `system_events` row. */
export const SYSTEM_EVENT_SEVERITIES = ['info', 'warn', 'error'] as const;
/** Element of {@link SYSTEM_EVENT_SEVERITIES}. */
export type SystemEventSeverity = (typeof SYSTEM_EVENT_SEVERITIES)[number];

/** Artifact kinds queued for deletion in `artifact_outbox`. */
export const ARTIFACT_KINDS = ['trace', 'screenshot', 'session_dir', 'backup'] as const;
/** Element of {@link ARTIFACT_KINDS}. */
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
