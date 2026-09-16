/** @module composition/phases/domain-ops — recorder, notifications, preferences, retention/outbox/backup schedulers and the startup reconcile pass (spec 03 §7–9, spec 10 §3). */

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
import { NotificationService, PreferenceService, Recorder } from '@browserhive/core/server';

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
}

/** Built operations services (not started; `wire-observers` starts them). */
export interface OpsParts {
  readonly recorder: Recorder;
  readonly notifications: NotificationService;
  readonly preferences: PreferenceService;
  readonly retention: RetentionScheduler;
  readonly outbox: ArtifactOutboxSweeper;
  readonly backups: BackupScheduler;
}

/** Builds the operations services. */
export function buildOps(input: OpsInput): OpsParts {
  const { config, repos, bus, clock, ids, logger, degradations } = input;
  const fs = createNodeFileSystem();
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
    notifications: new NotificationService({ repo: repos.notifications, bus, clock, ids, logger }),
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
