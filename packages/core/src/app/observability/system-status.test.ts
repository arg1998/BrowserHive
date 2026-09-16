/** @module app/observability/system-status.test — `/system` payload shape (contracts schema), derived degraded status, debounced `system.status`. */

import { describe, expect, it } from 'bun:test';
import { SystemInfo } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { SystemEventRecord } from '../../ports/persistence/records.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { TimerScheduler } from './log-persist-sink.ts';
import { SystemStatusService, type SystemStatusSources } from './system-status.ts';

class ManualTimers implements TimerScheduler {
  pending: (() => void)[] = [];
  setTimeout(fn: () => void) {
    this.pending.push(fn);
    return () => {
      this.pending = this.pending.filter((f) => f !== fn);
    };
  }
  fire() {
    const fns = this.pending;
    this.pending = [];
    for (const fn of fns) fn();
  }
}

function setup() {
  const clock = new FakeClock(10_000);
  const bus = new RecordingEventBus<DomainEvents>();
  const timers = new ManualTimers();
  const open: SystemEventRecord[] = [];
  const sources: SystemStatusSources = {
    version: '0.1.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 8787,
    admin: true,
    authMode: 'off',
    startedAt: 4_000,
    allowEvaluate: false,
    runtime: {
      bun: '1.4.2',
      sqlite: '3.53.2',
      playwright: '1.63.0',
      patchright: '1.63.0',
      chromium: null,
    },
    dataDir: '/data',
    mcp: { connections: () => 2 },
    sessions: {
      serverStatus: () => ({ count: 2, limit: 8, driver: 'playwright', persistenceMode: 'memory' }),
    },
    capacitySource: 'derived',
    attention: { openCount: () => 1 },
    realtime: { connections: () => 3, activeScreencasts: () => 1 },
    stealth: {
      profile: 'standard',
      driver: 'x',
      fingerprint: true,
      humanize: false,
      captcha: 'off',
    },
    vault: { enabled: false, backend: null },
    blocklist: { configured: true, path: '/b.txt', patterns: () => 12 },
    retention: {
      status: () => ({
        days: 7,
        bytes: 1024,
        last_run_at: null,
        last_result: null,
        next_run_at: null,
        pruned_rows: 0,
        artifacts_pending: 0,
      }),
    },
    storage: {
      databaseSize: async () => 4096,
      schemaVersion: 1,
      minReaderVersion: 1,
      migrations: async () => [
        { version: 1, name: 'initial', appliedAt: 1, durationMs: 5, appVersion: '0.1.0' },
      ],
      queue: { droppedWrites: 0, depth: 0 },
      lastBackupAt: () => null,
      backupsCount: () => 0,
    },
    otel: { enabled: false, endpoint: null, protocol: null },
    degradations: {
      open: async () => open,
      hasOpen: (severity) => open.some((r) => severity === undefined || r.severity === severity),
    },
  };
  const service = new SystemStatusService({
    sources,
    bus,
    clock,
    logger: new CollectingLogger(),
    scheduler: timers,
  });
  return { service, bus, timers, open };
}

describe('SystemStatusService', () => {
  it('snapshot parses with the contracts SystemInfo schema', async () => {
    const { service, open } = setup();
    open.push({
      seq: 1,
      eventId: 'e-1',
      code: 'RETENTION_FAILED',
      severity: 'warn',
      message: 'm',
      details: { step: 'x' },
      firstSeenAt: 1,
      lastSeenAt: 2,
      count: 2,
      resolvedAt: null,
    });
    const info = await service.snapshot();
    expect(SystemInfo.safeParse(info).success).toBe(true);
    expect(info).toMatchObject({
      uptime_ms: 6_000,
      capacity: { live: 2, max: 8, max_source: 'derived' },
      open_attention: 1,
      storage: { db_bytes: 4096 },
      stealth: { driver: 'playwright' },
      blocklist: { patterns: 12 },
    });
    expect(info.degradations[0]?.count).toBe(2);
  });

  it('debounces bus-triggered publications into one', () => {
    const { service, bus, timers } = setup();
    service.start();
    bus.publish('session.closed', {
      type: 'session.closed',
      session_id: 'shop-a1b2c3d4' as never,
      closed_at: 1,
      reason: 'user',
    });
    bus.publish('attention.resolved', {} as DomainEvents['attention.resolved']);
    expect(bus.names().filter((n) => n === 'system.status')).toHaveLength(0);
    expect(timers.pending).toHaveLength(1);
    timers.fire();
    expect(bus.names().filter((n) => n === 'system.status')).toHaveLength(1);
    service.stop();
  });

  it('derives degraded from an open error degradation once ready', () => {
    const { service, bus, open } = setup();
    expect(service.status()).toBe('starting');
    service.setLifecycle('ready');
    expect(service.status()).toBe('ready');
    open.push({
      seq: 1,
      eventId: 'e-1',
      code: 'UNHANDLED',
      severity: 'error',
      message: 'm',
      details: null,
      firstSeenAt: 1,
      lastSeenAt: 1,
      count: 1,
      resolvedAt: null,
    });
    expect(service.status()).toBe('degraded');
    const last = bus.published.at(-1)?.payload as DomainEvents['system.status'];
    expect(last.status).toBe('ready');
  });
});
