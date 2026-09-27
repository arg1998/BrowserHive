/** @module composition/phases/domain-ops — recorder, notifications (with the channel registry and the delivery outbox), preferences, retention/outbox/backup schedulers and the startup reconcile pass (spec 03 §7–9, spec 10 §3). */

import type { ServerConfig } from '@browserhive/contracts/config';
import type { DatabaseHandle, SqliteMaintenanceService } from '@browserhive/core/persistence';
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
  type ChannelAdapterFactory,
  ChannelRegistry,
  createLocalLinkBuilder,
  type DeliveryCounter,
  NotificationOutbox,
  NotificationService,
  PreferenceService,
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
  /** Platform adapter factories by channel kind; none ship yet. */
  readonly channelFactories?: ReadonlyMap<string, ChannelAdapterFactory>;
}

/** Built operations services (not started; `wire-observers` starts them). */
export interface OpsParts {
  readonly recorder: Recorder;
  readonly notifications: NotificationService;
  /** Configured external channels (loaded by `build-domain`). */
  readonly channels: ChannelRegistry;
  /** The delivery outbox worker (started by `wire-observers`). */
  readonly notificationOutbox: NotificationOutbox;
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
  const notificationOutbox = new NotificationOutbox({
    uow: input.uow,
    repos,
    registry: channels,
    links: createLocalLinkBuilder(input.dashboardUrl),
    clock,
    logger,
    bus,
    redactor: input.redactor,
    jitter: Math.random,
    ...(input.deliveryCounter !== undefined && { counter: input.deliveryCounter }),
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
    }),
    channels,
    notificationOutbox,
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
