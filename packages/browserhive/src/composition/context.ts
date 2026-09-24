/** @module composition/context — the mutable record the phases fill in, one part per phase (spec 01 §6). */

import type { ServerConfig } from '@browserhive/contracts/config';
import type {
  DatabaseHandle,
  SqliteMaintenanceService,
  SqliteUnitOfWork,
  SqliteWriteQueue,
} from '@browserhive/core/persistence';
import type {
  AnalyticsQueries,
  ArtifactOutboxSweeper,
  Authenticator,
  AuthService,
  BackupScheduler,
  Clock,
  DegradationService,
  DomainEvents,
  EventBus,
  IdGenerator,
  LogPersistSink,
  LogRingBuffer,
  Redactor,
  RetentionScheduler,
  RootLogger,
  SecretRegistry,
  Telemetry,
} from '@browserhive/core/runtime';
import { AppError } from '@browserhive/core/runtime';
import type {
  AttentionService,
  AuthStateStore,
  BlocklistService,
  LeaseSweeper,
  NotificationService,
  OperatorRequestBroker,
  PageActions,
  PreferenceService,
  Recorder,
  RuntimeFacts,
  SessionService,
  SystemStatusService,
  ToolDispatcher,
  VaultRedaction,
  VaultService,
} from '@browserhive/core/server';
import type { DegradationRelay } from './adapters/degradation-relay.ts';
import type { DataDirLayout } from './data-dir.ts';
import type { PhaseTracker } from './health.ts';
import type { DataDirLock } from './lock-file.ts';
import type { SandboxWiring } from './sandbox.ts';
import type { BootInput } from './types.ts';

/** Filled by `observability`. */
export interface ObservabilityPart {
  readonly logger: RootLogger;
  readonly ring: LogRingBuffer;
  readonly secrets: SecretRegistry;
  readonly redactor: Redactor;
  readonly telemetry: Telemetry;
  /** `json` or `pretty`, after `auto` was resolved. */
  readonly format: 'json' | 'pretty';
  readonly color: boolean;
}

/** Filled by `open-storage`. */
export interface StoragePart {
  readonly layout: DataDirLayout;
  readonly lock: DataDirLock;
  readonly handle: DatabaseHandle;
  readonly uow: SqliteUnitOfWork;
  readonly queue: SqliteWriteQueue;
  readonly analytics: AnalyticsQueries;
  readonly maintenance: SqliteMaintenanceService;
  readonly persistSink: LogPersistSink | null;
  /** `select sqlite_version()`. */
  readonly sqliteVersion: string;
}

/** Seed secrets shown once in the banner (never logged). */
export interface SeedNotice {
  readonly adminPassword: { readonly password: string; readonly path: string } | null;
  readonly agentToken: { readonly principalId: string; readonly token: string } | null;
}

/** Filled by `build-domain`. */
export interface DomainPart {
  readonly ids: IdGenerator;
  readonly bus: EventBus<DomainEvents>;
  readonly degradations: DegradationService;
  readonly driverName: () => 'patchright' | 'playwright';
  readonly browserInstalled: boolean;
  /** Version of the Chromium build `chromium` sessions launch; `null` when it is not installed. */
  readonly chromiumVersion: string | null;
  /** The sandbox policy and `/system`'s browser block. */
  readonly sandbox: SandboxWiring;
  readonly blocklist: BlocklistService;
  readonly authStates: AuthStateStore;
  readonly sessions: SessionService;
  readonly sweeper: LeaseSweeper;
  readonly broker: OperatorRequestBroker;
  readonly attention: AttentionService | null;
  readonly vault: VaultService;
  readonly vaultRedaction: VaultRedaction;
  readonly vaultBackend: 'off' | 'bitwarden';
  readonly auth: AuthService;
  readonly adminAuthenticator: Authenticator;
  readonly mcpAuthenticator: Authenticator;
  readonly notifications: NotificationService;
  readonly preferences: PreferenceService;
  readonly recorder: Recorder;
  readonly retention: RetentionScheduler;
  readonly outbox: ArtifactOutboxSweeper;
  readonly backups: BackupScheduler;
  readonly pageActions: PageActions;
  readonly runtime: RuntimeFacts;
  readonly dispatcher: ToolDispatcher;
  readonly seeds: SeedNotice;
}

/** Filled by `wire-observers`. */
export interface ObserversPart {
  readonly status: SystemStatusService;
}

/** Filled by `open-listeners`. */
export interface ListenersPart {
  /** `http://host:port` with the bound port; `null` under stdio. */
  readonly url: string | null;
  readonly port: number | null;
  /** Open MCP Streamable HTTP sessions (0 under stdio). */
  mcpConnections(): number;
  /** WS hub counters; absent under stdio. */
  readonly realtime?: { connections(): number; activeScreencasts(): number };
}

/** Boot-time record shared by every phase. */
export interface BootContext {
  readonly input: BootInput;
  readonly config: Readonly<ServerConfig>;
  readonly transport: 'http' | 'stdio';
  readonly clock: Clock;
  readonly health: PhaseTracker;
  readonly relay: DegradationRelay;
  /** Asks the server to stop with an exit code (stdio client gone, fatal storage error). */
  readonly requestStop: (exitCode: number) => void;
  /** Epoch ms of boot start. */
  readonly startedAt: number;
  observability?: ObservabilityPart;
  storage?: StoragePart;
  domain?: DomainPart;
  observers?: ObserversPart;
  listeners?: ListenersPart;
}

/** Returns a part filled by an earlier phase; a missing part is a composition bug. */
export function part<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'composition' },
      { message: `composition part '${name}' used before its phase ran` },
    );
  }
  return value;
}
