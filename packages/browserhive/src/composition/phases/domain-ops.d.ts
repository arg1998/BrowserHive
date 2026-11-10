/** @module composition/phases/domain-ops — recorder, notifications (with the channel registry and the delivery outbox), preferences, retention/outbox/backup schedulers and the startup reconcile pass (spec 03 §7–9, spec 10 §3). */
import type { ServerConfig } from '@browserhive/contracts/config';
import type { DatabaseHandle, SqliteMaintenanceService } from '@browserhive/core/persistence';
import type {
  ChannelRenderer,
  DiscordSetup,
  NotificationSnapshots,
  TelegramSetup,
  UrlProbe,
} from '@browserhive/core/ports/notification-channel';
import type {
  AnalyticsQueries,
  Clock,
  DegradationService,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
  Redactor,
  Repositories,
  UnitOfWork,
  WriteQueue,
} from '@browserhive/core/runtime';
import {
  ArtifactOutboxSweeper,
  BackupScheduler,
  RetentionScheduler,
} from '@browserhive/core/runtime';
import {
  type ActionCounter,
  type ActionExecutor,
  type ChannelAdapterFactory,
  ChannelRegistry,
  ChannelService,
  type DeliveryCounter,
  NotificationActionListeners,
  NotificationActionService,
  NotificationOutbox,
  NotificationService,
  type OperatorRequestBroker,
  PreferenceService,
  PublicUrlChecker,
  Recorder,
  type ReportCounter,
  ReportScheduler,
  ReportService,
  ReportSettingsStore,
} from '@browserhive/core/server';
/** Inputs of {@link buildOps}. */
export interface OpsInput {
  readonly config: Readonly<ServerConfig>;
  readonly repos: Repositories;
  readonly queue: WriteQueue;
  readonly handle: DatabaseHandle;
  readonly analytics: AnalyticsQueries;
  readonly maintenance: SqliteMaintenanceService;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly degradations: DegradationService;
  /** Transaction boundary for a notification and its outbox rows (D-34). */
  readonly uow: UnitOfWork;
  /** The process environment: channel secrets are read by variable name (D-33). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Registers a resolved channel secret with the redactor. */
  readonly registerSecret: (value: string) => void;
  /** Base URL of the local dashboard for notification links until `publicUrl` (D-37). */
  readonly dashboardUrl: () => string;
  /** `browserhive.notifications.deliveries` (a no-op without telemetry). */
  readonly deliveryCounter?: DeliveryCounter;
  /** Platform adapter factories by channel kind (`@browserhive/core/notifications`). */
  readonly channelFactories?: ReadonlyMap<string, ChannelAdapterFactory>;
  /** The platform renderers (the preview uses the adapters' own). */
  readonly renderers: ReadonlyMap<string, ChannelRenderer>;
  /** Screenshot seam (D-36); late-bound because it needs the sessions. */
  readonly snapshots?: NotificationSnapshots;
  readonly telegram?: TelegramSetup;
  /** The Discord bot-mode setup calls (D-38). */
  readonly discord?: DiscordSetup;
  /** What an act-button press may run (D-41): the same services as the dashboard's routes. */
  readonly actionExecutors?: ReadonlyMap<string, ActionExecutor>;
  /** Counts act-button presses (spec 10 §7). */
  readonly actionCounter?: ActionCounter;
  /** One-shot URL probe of the `publicUrl` check. */
  readonly probe: UrlProbe;
  /** Random per start (`GET /health`). */
  readonly instanceId: string;
  /** Live sessions and `maxSessions` now (the anomaly check's capacity, D-44). */
  readonly capacity: () => {
    readonly live: number;
    readonly max: number;
  };
  /** Counts scheduled report decisions (spec 10 §7). */
  readonly reportCounter?: ReportCounter;
  /** The host's IANA zone (the default of every channel's reports); default the runtime's. */
  readonly hostZone?: () => string;
}
/** Built operations services (not started; `wire-observers` starts them). */
export interface OpsParts {
  readonly recorder: Recorder;
  readonly notifications: NotificationService;
  /** Configured external channels (loaded by `build-domain`). */
  readonly channels: ChannelRegistry;
  /** The delivery outbox worker (started by `wire-observers`). */
  readonly notificationOutbox: NotificationOutbox;
  /** The channels API (spec 03 §4.8.1). */
  readonly channelService: ChannelService;
  /** Act buttons: tokens, presses and the audit (D-41). */
  readonly actions: NotificationActionService;
  /** The press listeners (started by `wire-observers`). */
  readonly actionListeners: NotificationActionListeners;
  /** Digests and anomaly alerts (started by `wire-observers`, D-43, D-44). */
  readonly reports: ReportScheduler;
  /** The in-app report settings (loaded by `wire-observers` before the scheduler starts, D-45). */
  readonly reportSettings: ReportSettingsStore;
  /** The Reports tab's reads and settings (D-45). */
  readonly reportService: ReportService;
  /** The `publicUrl` check (spec 08 §5.8). */
  readonly publicUrl: PublicUrlChecker;
  readonly preferences: PreferenceService;
  readonly retention: RetentionScheduler;
  readonly outbox: ArtifactOutboxSweeper;
  readonly backups: BackupScheduler;
}
/** Builds the operations services. */
export declare function buildOps(input: OpsInput): OpsParts;
/**
 * Startup reconcile: sessions left open by a previous run close as `interrupted`, orphaned
 * operator requests are rejected, stale MCP connection rows close. Never throws.
 */
export declare function reconcile(
  input: Pick<OpsInput, 'repos' | 'clock' | 'logger' | 'degradations'> & {
    readonly broker: OperatorRequestBroker;
    /** `<data-dir>/templates`: Chromium a killed daemon left on a template profile holds its lock (spec 13 §3.1). */
    readonly templatesDir?: string;
  },
): Promise<void>;
//# sourceMappingURL=domain-ops.d.ts.map
