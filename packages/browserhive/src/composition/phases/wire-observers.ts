/** @module composition/phases/wire-observers — phase 5: recorder projection, notification producers, system status publisher, maintenance schedulers, lease sweeper, OTel metrics consumers. */

import { createRequire } from 'node:module';
import { listBackups } from '@browserhive/core/persistence';
import { serializeError } from '@browserhive/core/runtime';
import { pinnedPlaywrightVersion, SystemStatusService } from '@browserhive/core/server';
import { wireMetrics } from '../adapters/metrics.ts';
import { type BootContext, part } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';

/** Version of the optional `patchright` package, or `null` when it cannot be resolved. */
export function patchrightVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifest: unknown = require('patchright/package.json');
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      return typeof manifest.version === 'string' ? manifest.version : null;
    }
  } catch {
    // Optional dependency absent.
  }
  return null;
}

/** Phase `wire-observers`. */
export async function wireObserversPhase(ctx: BootContext): Promise<PhaseHandle> {
  ctx.health.enter('wire-observers');
  const { config } = ctx;
  const { logger, telemetry } = part(ctx.observability, 'observability');
  const storage = part(ctx.storage, 'storage');
  const domain = part(ctx.domain, 'domain');
  const repos = storage.uow.repos;

  const status = new SystemStatusService({
    bus: domain.bus,
    clock: ctx.clock,
    logger,
    sources: {
      version: ctx.input.appVersion,
      runtime: {
        bun: Bun.version,
        sqlite: storage.sqliteVersion,
        playwright: pinnedPlaywrightVersion(),
        patchright: patchrightVersion(),
        chromium: domain.chromiumVersion,
      },
      dataDir: config.dataDir,
      mcp: { connections: () => ctx.listeners?.mcpConnections() ?? 0 },
      transport: ctx.transport,
      host: config.host,
      get port() {
        return ctx.listeners?.port ?? config.port;
      },
      admin: config.admin,
      authMode: config.auth,
      startedAt: ctx.startedAt,
      allowEvaluate: config.allowEvaluate,
      sessions: domain.sessions,
      capacitySource:
        ctx.input.resolved.provenance.maxSessions.source === 'derived' ? 'derived' : 'config',
      ...(domain.attention !== null && { attention: domain.attention }),
      realtime: {
        connections: () => ctx.listeners?.realtime?.connections() ?? 0,
        activeScreencasts: () => ctx.listeners?.realtime?.activeScreencasts() ?? 0,
      },
      stealth: {
        profile: config.stealth,
        driver: domain.driverName(),
        fingerprint: config.fingerprint,
        humanize: config.humanize,
        captcha: config.captcha,
      },
      vault: {
        enabled: domain.vaultBackend !== 'off',
        backend: domain.vaultBackend === 'off' ? null : domain.vaultBackend,
      },
      blocklist: {
        configured: domain.blocklist.configured,
        path: config.blocklist ?? null,
        patterns: () => domain.blocklist.stats().patterns,
      },
      retention: domain.retention,
      storage: {
        databaseSize: () => storage.analytics.databaseSize(),
        schemaVersion: storage.handle.schemaVersion,
        minReaderVersion: storage.handle.minReaderVersion,
        migrations: () => repos.schemaMigrations.list(),
        queue: storage.queue,
        lastBackupAt: () => domain.backups.lastBackupAt(),
        backupsCount: () => listBackups(storage.handle.backupsDir).length,
      },
      otel: {
        enabled: config.otel,
        endpoint: config.otel ? config.otelEndpoint : null,
        protocol: config.otel ? config.otelProtocol : null,
      },
      degradations: domain.degradations,
    },
  });

  domain.recorder.start();
  domain.notifications.start();
  status.start();
  domain.retention.start();
  domain.outbox.start();
  domain.backups.start();
  void domain.backups
    .refreshLastBackup()
    .catch((err: unknown) => logger.warn('backup scan failed', { err: serializeError(err) }));
  domain.sweeper.start();
  const unwireMetrics = telemetry.enabled
    ? wireMetrics(telemetry.instruments, domain.bus, {
        queue: storage.queue,
        analytics: storage.analytics,
      })
    : () => undefined;
  ctx.observers = { status };

  return {
    async stop() {
      unwireMetrics();
      domain.sweeper.stop();
      domain.backups.stop();
      domain.outbox.stop();
      domain.retention.stop();
      status.stop();
      domain.notifications.stop();
    },
  };
}
