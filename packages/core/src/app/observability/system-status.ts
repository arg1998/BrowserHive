/** @module app/observability/system-status — composes the `GET /api/v1/system` payload from narrow structural sources and publishes `system.status` on change, debounced (spec 03 §4.7). */

import type { RetentionStatus, SystemInfo } from '@browserhive/contracts/http';
import { SystemInfo as SystemInfoSchema } from '@browserhive/contracts/http';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SchemaMigrationRecord, SystemEventRecord } from '../../ports/persistence/records.ts';
import type { DomainEventName, DomainEvents } from '../events/catalog.ts';
import { toSystemEvent } from './degradations.ts';
import type { TimerScheduler } from './log-persist-sink.ts';

/** Lifecycle as reported on the `system` topic. */
export type LifecycleStatus = DomainEvents['system.status']['status'];

/** Debounce window for `system.status` publications. */
export const DEFAULT_STATUS_DEBOUNCE_MS = 250;

/** Bus events after which the payload is considered changed. */
export const STATUS_CHANGING_EVENTS: readonly DomainEventName[] = [
  'session.opened',
  'session.closed',
  'session.removed',
  'attention.created',
  'attention.resolved',
  'system.degraded',
  'system.recovered',
  'system.capacity',
  'retention.completed',
  'blocklist.reloaded',
];

/** Everything `/system` reports, as narrow structural slices of the owning services. */
export interface SystemStatusSources {
  readonly version: string;
  /** Runtime/engine versions resolved once at boot. */
  readonly runtime: SystemInfo['runtime'];
  readonly dataDir: string;
  /** Open MCP Streamable HTTP sessions; absent under stdio. */
  readonly mcp?: { connections(): number };
  readonly transport: SystemInfo['transport'];
  readonly host: string;
  readonly port: number;
  readonly admin: boolean;
  /** `auth` config key. */
  readonly authMode: SystemInfo['auth_mode'];
  readonly startedAt: number;
  readonly allowEvaluate: boolean;
  /** `SessionService.serverStatus()` slice. */
  readonly sessions: {
    serverStatus(): {
      readonly count: number;
      readonly limit: number | null;
      readonly driver: string;
      readonly persistenceMode: string;
    };
  };
  /** Whether `maxSessions` came from config or the RAM derivation. */
  readonly capacitySource: SystemInfo['capacity']['max_source'];
  /** `AttentionService.openCount()`; absent under stdio. */
  readonly attention?: { openCount(): number };
  /** WS hub counters; absent under stdio. */
  readonly realtime?: { connections(): number; activeScreencasts(): number };
  readonly stealth: SystemInfo['stealth'];
  /** Browsers on this host and the sandbox state (detected once, verdicts live). */
  readonly browser?: { snapshot(): Promise<NonNullable<SystemInfo['browser']>> };
  readonly vault: SystemInfo['vault'];
  readonly blocklist?: {
    readonly configured: boolean;
    readonly path: string | null;
    patterns(): number;
  };
  /** `RetentionScheduler.status()`. */
  readonly retention: { status(): RetentionStatus };
  readonly storage: {
    databaseSize(): Promise<number>;
    readonly schemaVersion: number;
    readonly minReaderVersion: number;
    migrations(): Promise<readonly SchemaMigrationRecord[]>;
    readonly queue: { readonly droppedWrites: number; readonly depth: number };
    lastBackupAt(): number | null;
    backupsCount(): number;
  };
  readonly otel: SystemInfo['otel'];
  /** `DegradationService` slice. */
  readonly degradations: {
    open(): Promise<readonly SystemEventRecord[]>;
    hasOpen(severity?: 'info' | 'warn' | 'error'): boolean;
  };
}

/** Dependencies of {@link SystemStatusService}. */
export interface SystemStatusServiceDeps {
  readonly sources: SystemStatusSources;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly debounceMs?: number;
  readonly scheduler?: TimerScheduler;
}

const realScheduler: TimerScheduler = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    const maybe: { unref?: () => void } = timer;
    maybe.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Builds the `SystemInfo` payload on demand and publishes `system.status` (debounced) whenever
 * the lifecycle changes or a status-changing bus event arrives. `degraded` is derived: the
 * lifecycle is `ready` and an unresolved `error` degradation exists.
 */
export class SystemStatusService {
  private lifecycle: LifecycleStatus = 'starting';
  private unsubscribe: (() => void)[] = [];
  private cancelTimer: (() => void) | undefined;
  private lastPublished: LifecycleStatus | undefined;
  private readonly log: Logger;

  constructor(private readonly deps: SystemStatusServiceDeps) {
    this.log = deps.logger.child({ module: 'system.status' });
  }

  /** Subscribes to the status-changing events. Idempotent. */
  start(): void {
    if (this.unsubscribe.length > 0) return;
    for (const name of STATUS_CHANGING_EVENTS) {
      this.unsubscribe.push(this.deps.bus.subscribe(name, () => this.touch()));
    }
  }

  /** Unsubscribes and cancels a pending publication. */
  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** Sets the lifecycle (`starting → ready → stopping`) and publishes immediately. */
  setLifecycle(status: LifecycleStatus): void {
    this.lifecycle = status;
    this.publish();
  }

  /** The effective status right now. */
  status(): LifecycleStatus {
    if (this.lifecycle === 'ready' && this.deps.sources.degradations.hasOpen('error')) {
      return 'degraded';
    }
    return this.lifecycle;
  }

  /** Schedules a debounced `system.status` publication. */
  touch(): void {
    if (this.cancelTimer !== undefined) return;
    const scheduler = this.deps.scheduler ?? realScheduler;
    this.cancelTimer = scheduler.setTimeout(() => {
      this.cancelTimer = undefined;
      this.publish();
    }, this.deps.debounceMs ?? DEFAULT_STATUS_DEBOUNCE_MS);
  }

  /**
   * The full `GET /system` body, validated against the contracts schema.
   *
   * @returns The `SystemInfo` DTO.
   */
  async snapshot(): Promise<SystemInfo> {
    const s = this.deps.sources;
    const now = this.deps.clock.now();
    const server = s.sessions.serverStatus();
    const [dbBytes, migrations, degradations, browser] = await Promise.all([
      s.storage.databaseSize(),
      s.storage.migrations(),
      s.degradations.open(),
      s.browser?.snapshot(),
    ]);
    const info: SystemInfo = {
      version: s.version,
      runtime: s.runtime,
      data_dir: s.dataDir,
      mcp: { connections: s.mcp?.connections() ?? 0 },
      transport: s.transport,
      uptime_ms: Math.max(0, now - s.startedAt),
      started_at: s.startedAt,
      host: s.host,
      port: s.port,
      admin: s.admin,
      auth_mode: s.authMode,
      capacity: { live: server.count, max: server.limit, max_source: s.capacitySource },
      open_attention: s.attention?.openCount() ?? 0,
      active_screencasts: s.realtime?.activeScreencasts() ?? 0,
      realtime: { connections: s.realtime?.connections() ?? 0 },
      allow_evaluate: s.allowEvaluate,
      persistence_mode: server.persistenceMode,
      stealth: { ...s.stealth, driver: server.driver },
      ...(browser !== undefined && { browser }),
      vault: s.vault,
      blocklist: {
        configured: s.blocklist?.configured ?? false,
        path: s.blocklist?.path ?? null,
        patterns: s.blocklist?.patterns() ?? 0,
      },
      retention: s.retention.status(),
      storage: {
        db_bytes: dbBytes,
        schema_version: s.storage.schemaVersion,
        min_reader_version: s.storage.minReaderVersion,
        migrations: migrations.map((m) => ({
          version: m.version,
          name: m.name,
          applied_at: m.appliedAt,
          duration_ms: m.durationMs,
          app_version: m.appVersion,
        })),
        dropped_writes_total: s.storage.queue.droppedWrites,
        write_queue_depth: s.storage.queue.depth,
        last_backup_at: s.storage.lastBackupAt(),
        backups_count: s.storage.backupsCount(),
      },
      otel: s.otel,
      degradations: degradations.map(toSystemEvent),
      now,
    };
    return SystemInfoSchema.parse(info);
  }

  private publish(): void {
    const status = this.status();
    try {
      this.deps.bus.publish('system.status', {
        type: 'system.status',
        status,
        at: this.deps.clock.now(),
      });
      if (status !== this.lastPublished) this.log.info('system status', { status });
      this.lastPublished = status;
    } catch (err) {
      this.log.error('status publish failed', { err: serializeError(err) });
    }
  }
}
