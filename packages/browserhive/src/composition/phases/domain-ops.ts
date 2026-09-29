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
  createNodeFileSystem,
  RetentionScheduler,
  reconcileOnStartup,
  retentionPolicyFromConfig,
} from '@browserhive/core/runtime';
import type { OperatorRequestBroker } from '@browserhive/core/server';
import {
  type ActionCounter,
  type ActionExecutor,
  type ChannelAdapterFactory,
  ChannelRegistry,
  ChannelService,
  type DeliveryCounter,
  imageVariants,
  linkBuilderFor,
  NotificationActionListeners,
  NotificationActionService,
  NotificationOutbox,
  NotificationService,
  PreferenceService,
  PublicUrlChecker,
  Recorder,
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
  /** The `publicUrl` check (spec 08 §5.8). */
  readonly publicUrl: PublicUrlChecker;
  readonly preferences: PreferenceService;
  readonly retention: RetentionScheduler;
  readonly outbox: ArtifactOutboxSweeper;
  readonly backups: BackupScheduler;
}

/** Builds the operations services. */
export function buildOps(input: OpsInput): OpsParts {
  const { config, repos, bus, clock, ids, logger, degradations } = input;
  const fs = createNodeFileSystem();
  const channels = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    env: (name) => input.env[name],
    registerSecret: input.registerSecret,
    ...(input.channelFactories !== undefined && { factories: input.channelFactories }),
  });
  const links = linkBuilderFor(config.publicUrl, input.dashboardUrl);
  // The feed is late-bound: the channel service is built after the outbox that reports to it.
  let feed: ChannelService | undefined;
  const actions = new NotificationActionService({
    repos,
    registry: channels,
    clock,
    ids,
    logger,
    executors: input.actionExecutors ?? new Map(),
    bus,
    redactor: input.redactor,
    ...(input.actionCounter !== undefined && { counter: input.actionCounter }),
  });
  const actionListeners = new NotificationActionListeners({
    registry: channels,
    handler: (press) => actions.press(press),
    logger,
    onStatus: (channelId) => feed?.scheduleChannel(channelId),
  });
  const notificationOutbox = new NotificationOutbox({
    uow: input.uow,
    repos,
    registry: channels,
    links,
    clock,
    logger,
    bus,
    redactor: input.redactor,
    jitter: Math.random,
    ...(input.deliveryCounter !== undefined && { counter: input.deliveryCounter }),
    onDeliveryChange: (channelId, notificationId) =>
      feed?.onDeliveryChange(notificationId, channelId),
    actions,
  });
  const channelService = new ChannelService({
    repos,
    uow: input.uow,
    registry: channels,
    renderers: input.renderers,
    links,
    clock,
    ids,
    logger,
    bus,
    env: (name) => input.env[name],
    registerSecret: input.registerSecret,
    redactor: input.redactor,
    ...(input.telegram !== undefined && { telegram: input.telegram }),
    ...(input.discord !== undefined && { discord: input.discord }),
    connection: (channelId) => actionListeners.status(channelId),
    actions,
  });
  feed = channelService;
  const publicUrl = new PublicUrlChecker({
    publicUrl: config.publicUrl,
    localUrl: input.dashboardUrl,
    instanceId: input.instanceId,
    probe: input.probe,
    clock,
  });
  return {
    recorder: new Recorder({
      bus,
      queue: input.queue,
      logger,
      redactor: input.redactor,
      config: {
        recordToolResults: config.recordToolResults,
        urlQueryAllowlist: config.urlQueryAllowlist,
      },
    }),
    notifications: new NotificationService({
      repo: repos.notifications,
      bus,
      clock,
      ids,
      logger,
      uow: input.uow,
      outbox: notificationOutbox,
      redactor: input.redactor,
      onDeliveryChange: (notificationId) => channelService.onDeliveryChange(notificationId),
      ...(input.snapshots !== undefined && {
        screenshots: {
          enabled: config.recordToolResults !== 'none',
          snapshots: input.snapshots,
          variants: (category) =>
            imageVariants(
              channels.channels().map((c) => c.record),
              category,
            ),
        },
      }),
    }),
    channels,
    notificationOutbox,
    channelService,
    actions,
    actionListeners,
    publicUrl,
    preferences: new PreferenceService({ repo: repos.preferences, clock, logger }),
    retention: new RetentionScheduler({
      maintenance: input.maintenance,
      policy: retentionPolicyFromConfig(config),
      clock,
      logger,
      degradations,
      bus,
      outbox: repos.artifactOutbox,
    }),
    outbox: new ArtifactOutboxSweeper({ outbox: repos.artifactOutbox, fs, logger, degradations }),
    backups: new BackupScheduler({
      maintenance: input.maintenance,
      fs,
      backupsDir: input.handle.backupsDir,
      clock,
      logger,
    }),
  };
}

/**
 * Startup reconcile: sessions left open by a previous run close as `interrupted`, orphaned
 * operator requests are rejected, stale MCP connection rows close. Never throws.
 */
export async function reconcile(
  input: Pick<OpsInput, 'repos' | 'clock' | 'logger' | 'degradations'> & {
    readonly broker: OperatorRequestBroker;
  },
): Promise<void> {
  const result = await reconcileOnStartup({
    sessions: input.repos.sessions,
    operatorRequests: input.broker,
    mcpConnections: input.repos.mcpConnections,
    degradations: input.degradations,
    clock: input.clock,
    logger: input.logger,
  });
  if ((result.sessionsClosed ?? 0) > 0 || (result.requestsRejected ?? 0) > 0) {
    input.logger.info('startup reconciled', {
      sessions_closed: result.sessionsClosed,
      requests_rejected: result.requestsRejected,
      connections_closed: result.connectionsClosed,
    });
  }
}
