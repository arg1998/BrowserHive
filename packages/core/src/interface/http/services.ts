/** @module interface/http/services — the narrow dependency record every route handler receives (spec 03 §1.2); the composition root adapts real services onto these structural types. */

import type { ClosedReason, Transport } from '@browserhive/contracts/enums';
import type {
  BootPhase,
  HealthCheckState,
  HealthStatus,
  RealtimeConnection,
  SystemInfo,
} from '@browserhive/contracts/http';
import type { LiveInput } from '@browserhive/contracts/ws';
import type { AttentionService } from '../../app/attention/attention-service.ts';
import type { AuthService } from '../../app/auth/auth-service.ts';
import type { ConfigView } from '../../app/config/provenance-view.ts';
import type { DomainEvents } from '../../app/events/catalog.ts';
import type { SessionDirLayout } from '../../app/sessions/profile-dir.ts';
import type { SessionService } from '../../app/sessions/session-service.ts';
import type { VaultAdmin } from '../../app/vault/vault-admin.ts';
import type { VaultService } from '../../app/vault/vault-service.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import type { Desktop } from '../../ports/desktop.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { AnalyticsQueries } from '../../ports/persistence/analytics.ts';
import type { NotificationListQuery, Page } from '../../ports/persistence/queries.ts';
import type { IdempotencyRecord, NotificationRecord } from '../../ports/persistence/records.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { ArtifactFiles } from '../../ports/static-assets.ts';

/** The live-session facts the routes read (a structural slice of `SessionService`). */
export type SessionsPort = Pick<SessionService, 'peek' | 'listAll' | 'close' | 'summary'>;

/** The operator side of attention (a structural slice of `AttentionService`). */
export type AttentionPort = Pick<
  AttentionService,
  'openCount' | 'history' | 'facets' | 'resolve' | 'reject' | 'isInputPermitted'
>;

/** Bindings/policies administration (a structural slice of `VaultAdmin`). */
export type VaultAdminPort = Pick<
  VaultAdmin,
  | 'listBindings'
  | 'putBinding'
  | 'deleteBinding'
  | 'putPolicy'
  | 'exportDocument'
  | 'importDocument'
  | 'tester'
>;

/** The vault facade (a structural slice of `VaultService`) plus its admin half. */
export type VaultPort = Pick<
  VaultService,
  | 'configured'
  | 'overview'
  | 'status'
  | 'unlock'
  | 'lock'
  | 'sync'
  | 'groups'
  | 'items'
  | 'accessLog'
  | 'confirms'
  | 'resolveConfirm'
> & { readonly admin: VaultAdminPort };

/** Operator authentication operations (a structural slice of `AuthService`). */
export type AuthPort = Pick<
  AuthService,
  | 'login'
  | 'logout'
  | 'me'
  | 'listSessions'
  | 'revokeSession'
  | 'revokeAllSessions'
  | 'changePassword'
  | 'createToken'
  | 'listTokens'
  | 'revokeToken'
  | 'createGrant'
  | 'touchSession'
>;

/** Blocklist facts and the reload verb (D-22); adapted from `BlocklistService`. */
export interface BlocklistPort {
  readonly configured: boolean;
  readonly path: string | null;
  /** Loaded patterns with their source line numbers. */
  patterns(): readonly { readonly pattern: string; readonly line: number }[];
  /** Lines the parser skipped. */
  skipped(): readonly { readonly line: number; readonly text: string; readonly reason: string }[];
  /** Epoch ms of the last successful load, or `null`. */
  loadedAt(): number | null;
  /** Re-reads the file; throws `BLOCKLIST_LOAD_FAILED` and keeps the old rules on failure. */
  reload(): Promise<{ readonly patterns: number; readonly skipped: number }>;
}

/** In-app notifications (the `app/notifications` service, built concurrently; structural). */
export interface NotificationsPort {
  list(query: NotificationListQuery): Promise<Page<NotificationRecord>>;
  unreadCount(): Promise<number>;
  markRead(notificationId: string): Promise<boolean>;
  markAllRead(): Promise<number>;
  dismiss(notificationId: string): Promise<boolean>;
  dismissAll(): Promise<number>;
}

/** Per-operator preferences (the `app/notifications` preference service; structural). */
export interface PreferencesPort {
  list(principal: string): Promise<{
    readonly preferences: Readonly<Record<string, unknown>>;
    readonly updatedAt: number | null;
  }>;
  replaceAll(
    principal: string,
    values: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly updatedAt: number }>;
}

/** One log record as the ring buffer holds it (wire-shaped, extra fields allowed). */
export interface LogRecordLike {
  readonly ts: number;
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly msg: string;
  readonly module: string;
  readonly [field: string]: unknown;
}

/** A stored ring entry. */
export interface LogEntry {
  readonly seq: number;
  readonly record: LogRecordLike;
}

/** Ring-buffer filters (mirrors `infra/logging/ring-buffer.ts` `LogQuery`). */
export interface LogQueryLike {
  readonly cursor?: number;
  readonly order?: 'asc' | 'desc';
  readonly afterSeq?: number;
  readonly level?: readonly LogRecordLike['level'][];
  readonly module?: readonly string[];
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly q?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
}

/** The in-process log ring buffer (`GET /logs`, `logs` topic); `createRingBuffer()` fits. */
export interface LogsPort {
  readonly latestSeq: number;
  query(query?: LogQueryLike): {
    readonly items: readonly LogEntry[];
    readonly nextCursor: number | null;
  };
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

/** Runtime log-level control (`PATCH /system/log-level`); injected by the composition root. */
export interface LogLevelController {
  /** Applies a spec (`info,sessions=debug`); returns the normalised spec now in force. */
  set(spec: string): string;
}

/** Static facts about the running server used outside `/system` (health, trace, status page). */
export interface SystemFacts {
  readonly version: string;
  readonly transport: Transport;
  readonly startedAt: number;
  /** `trace` config key (trace descriptors report `enabled`). */
  readonly traceEnabled: boolean;
}

/** The system surface (`GET /system/config` and the facts above). */
export interface SystemPort {
  facts(): SystemFacts;
  /** The resolved config with provenance (`configView()` from `app/config`). */
  configView(): ConfigView;
}

/** `GET /system` payload source: `SystemStatusService` (`app/observability/system-status.ts`). */
export interface SystemStatusPort {
  snapshot(): Promise<SystemInfo>;
}

/** Phase-driven readiness snapshot (`GET /health`); the composition root owns the phase. */
export interface HealthProbe {
  snapshot(): {
    readonly status: HealthStatus;
    readonly phase: BootPhase;
    readonly checks: {
      readonly db: HealthCheckState;
      readonly browser: HealthCheckState;
      readonly listeners: HealthCheckState;
    };
  };
}

/** Live-view verbs shared by REST (`/viewport`, `/input`) and WS (implemented by `LiveView`). */
export interface LiveControlPort {
  /** Resizes the active page; never attention-gated (D-10). */
  setViewport(
    sessionId: string,
    width: number,
    height: number,
  ): Promise<{ readonly width: number; readonly height: number }>;
  /** Dispatches one input via CDP; the caller has already checked the attention gate. */
  sendInput(sessionId: string, input: LiveInput): Promise<void>;
}

/** Realtime introspection the REST layer surfaces (`/system/realtime`, `has_live_viewers`). */
export interface RealtimeIntrospection {
  connections(): readonly RealtimeConnection[];
  activeScreencasts(): number;
  hasViewers(sessionId: string): boolean;
}

/** Idempotent-replay store for bulk endpoints (a structural slice of `IdempotencyRepository`). */
export interface IdempotencyStore {
  get(key: string, principalId: string, route: string): Promise<IdempotencyRecord | null>;
  put(record: IdempotencyRecord): Promise<boolean>;
}

/** Repositories the routes read directly (closed sessions and fact tables). */
export type RepositoryPorts = Pick<
  Repositories,
  | 'sessions'
  | 'toolCalls'
  | 'pages'
  | 'screenshots'
  | 'blocklistAudit'
  | 'systemEvents'
  | 'operatorActions'
>;

/** Session closing verb used by terminate/delete/bulk. */
export type CloseSession = (sessionId: string, reason: ClosedReason) => Promise<boolean>;

/** Events the REST layer publishes itself (archive/unarchive/delete). */
export type HttpEvents = Pick<DomainEvents, 'session.removed'>;

/** The MCP Streamable HTTP entry point (`interface/mcp/transports/http.ts`, built concurrently). */
export type McpRequestHandler = (
  request: Request,
  principal: RequestPrincipal,
) => Promise<Response>;

/** The narrow record handlers receive (spec 03 §1.2). */
export interface HttpServices {
  readonly sessions: SessionsPort;
  readonly repos: RepositoryPorts;
  readonly analytics: AnalyticsQueries;
  readonly attention: AttentionPort;
  readonly vault: VaultPort;
  readonly auth: AuthPort;
  readonly blocklist: BlocklistPort;
  readonly notifications: NotificationsPort;
  readonly preferences: PreferencesPort;
  readonly logs: LogsPort;
  readonly logLevel: LogLevelController;
  readonly system: SystemPort;
  readonly systemStatus: SystemStatusPort;
  readonly health: HealthProbe;
  readonly files: ArtifactFiles;
  readonly desktop: Desktop;
  readonly sessionDirs: SessionDirLayout;
  readonly live: LiveControlPort;
  readonly realtime: RealtimeIntrospection;
  readonly idempotency: IdempotencyStore;
  readonly events: EventPublisher<HttpEvents>;
  /** Mints `e-<ulid>` ids for operator audit rows. */
  readonly ids: Pick<IdGenerator, 'eventId'>;
  /** Whether the Playwright trace viewer bundle is servable. */
  readonly traceViewerAvailable: boolean;
}
