/** @module public/runtime — `@browserhive/core/runtime`: kernel services, ports, logging, telemetry, auth and maintenance for the composition root and CLI commands; loads no browser, HTTP or MCP code. */

export { createAuthAudit } from '../app/auth/audit.ts';
export { type AuthService, createAuthService } from '../app/auth/auth-service.ts';
export { type Authenticator, createAuthenticator } from '../app/auth/authenticate.ts';
export type { AuthEvents } from '../app/auth/events.ts';
export { adminProviderChain, mcpProviderChain } from '../app/auth/providers/index.ts';
export { type AuthConfig, type AuthDeps, resolveAuthConfig } from '../app/auth/types.ts';
export { secretConfigLiterals } from '../app/config/secret-literals.ts';
export type { DomainEventName, DomainEvents } from '../app/events/catalog.ts';
export { ArtifactOutboxSweeper } from '../app/maintenance/artifact-outbox-sweeper.ts';
export { BackupScheduler } from '../app/maintenance/backup-scheduler.ts';
export {
  RetentionScheduler,
  retentionPolicyFromConfig,
} from '../app/maintenance/retention-scheduler.ts';
export { reconcileOnStartup } from '../app/maintenance/startup-reconcile.ts';
export { DegradationService } from '../app/observability/degradations.ts';
export { createLogPersistSink, LogPersistSink } from '../app/observability/log-persist-sink.ts';
export { createBunPasswordHasher } from '../infra/auth/bun-password-hasher.ts';
export { createCredentialsFile } from '../infra/auth/credentials-file.ts';
export { createWebCryptoRandom } from '../infra/auth/web-crypto-random.ts';
export { createSystemClock } from '../infra/clock/system-clock.ts';
export { createNodeFileSystem } from '../infra/fs/node-file-system.ts';
export { readHostMemory, readProcessMemory } from '../infra/host/memory.ts';
export { createNanoidIdGenerator } from '../infra/ids/nanoid-id-generator.ts';
export { resolveColor } from '../infra/logging/color.ts';
export { redirectConsoleToLogger } from '../infra/logging/console-redirect.ts';
export {
  formatLevelSpec,
  type LevelSpec,
  LOG_MODULES,
  parseLevelSpec,
} from '../infra/logging/level-spec.ts';
export { createLogger, type RootLogger } from '../infra/logging/logger.ts';
export { createRingBuffer, type LogRingBuffer } from '../infra/logging/ring-buffer.ts';
export type { LogSink } from '../infra/logging/sinks.ts';
export { createBunProcessRunner } from '../infra/process/bun-process-runner.ts';
export type { Instruments } from '../infra/telemetry/metrics.ts';
export { createOtelLogSink } from '../infra/telemetry/otel-log-sink.ts';
export { createTelemetry, type Telemetry } from '../infra/telemetry/telemetry.ts';
export { AppError, isAppError } from '../kernel/errors/app-error.ts';
export { serializeError } from '../kernel/errors/serialize-error.ts';
export { createRedactor, type Redactor, SecretRegistry } from '../kernel/redact.ts';
export type { Clock } from '../ports/clock.ts';
export type { Degradation, DegradationReporter } from '../ports/degradation-reporter.ts';
export type { EventBus, EventPublisher } from '../ports/event-bus.ts';
export type { FileSystem } from '../ports/file-system.ts';
export type { HostEnvironment } from '../ports/host-environment.ts';
export type { IdGenerator } from '../ports/id-generator.ts';
export type { LogFields, Logger, LogLevel } from '../ports/logger.ts';
export type { AnalyticsQueries } from '../ports/persistence/analytics.ts';
export { AUTH_EVENT_TYPES } from '../ports/persistence/enums.ts';
export type { NotificationRepository } from '../ports/persistence/notifications.ts';
export type { Repositories, UnitOfWork } from '../ports/persistence/unit-of-work.ts';
export type { WriteQueue } from '../ports/persistence/write-queue.ts';
export type { ProcessRunner } from '../ports/process-runner.ts';
