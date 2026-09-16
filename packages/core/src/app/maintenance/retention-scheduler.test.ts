/** @module app/maintenance/retention-scheduler.test — tick isolation, RETENTION_FAILED raised then resolved, `/system.retention` status, retention.completed. */

import { describe, expect, it } from 'bun:test';
import { RetentionStatus } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { Degradation } from '../../ports/degradation-reporter.ts';
import type { RetentionResult } from '../../ports/persistence/maintenance.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { RetentionScheduler, retentionPolicyFromConfig } from './retention-scheduler.ts';
import { ManualIntervals, settle } from './test-support.ts';

function result(failures: RetentionResult['failures'] = [], pruned = 3): RetentionResult {
  return {
    startedAt: 0,
    durationMs: 1,
    prunedRows: { tool_calls: pruned, pages: 1 },
    artifactsEnqueued: 0,
    bytesBefore: 10,
    bytesAfter: 5,
    failures,
  };
}

function setup(sweep: () => Promise<RetentionResult>) {
  const clock = new FakeClock(1_000);
  const reported: Degradation[] = [];
  const recovered: string[] = [];
  const intervals = new ManualIntervals();
  const bus = new RecordingEventBus<DomainEvents>();
  const scheduler = new RetentionScheduler({
    maintenance: { retentionSweep: sweep },
    policy: retentionPolicyFromConfig({ retentionDays: 7, retentionBytes: 1 << 30 }),
    clock,
    logger: new CollectingLogger(),
    degradations: {
      report: (d) => void reported.push(d),
      recovered: (c) => void recovered.push(c),
    },
    bus,
    outbox: { count: async () => 4 },
    intervalMs: 60_000,
    scheduler: intervals,
  });
  return { clock, reported, recovered, intervals, bus, scheduler };
}

describe('retentionPolicyFromConfig', () => {
  it('fills the audit and notification defaults', () => {
    expect(retentionPolicyFromConfig({ retentionDays: 3, retentionBytes: 100 })).toEqual({
      retentionDays: 3,
      retentionBytes: 100,
      auditRetentionDays: 90,
      notificationSeenDays: 30,
      notificationDays: 90,
    });
  });
});

describe('RetentionScheduler', () => {
  it('a throwing sweep never kills the timer; degradation raised then resolved on success', async () => {
    let calls = 0;
    const { intervals, reported, recovered, scheduler } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('database is locked');
      return result();
    });
    scheduler.start();
    intervals.tick();
    await settle();
    expect(scheduler.lastRun?.outcome).toBe('failed');
    expect(reported).toEqual([
      expect.objectContaining({
        code: 'RETENTION_FAILED',
        severity: 'error',
        details: { step: 'sweep' },
      }),
    ]);
    expect(intervals.fns).toHaveLength(1);

    intervals.tick();
    await settle();
    expect(calls).toBe(2);
    expect(scheduler.lastRun?.outcome).toBe('ok');
    expect(scheduler.lastRun?.prunedRows).toBe(4);
    expect(recovered).toEqual(['RETENTION_FAILED']);
    scheduler.stop();
    expect(intervals.fns).toHaveLength(0);
  });

  it('per-item failures report one degradation per step and a partial outcome', async () => {
    const { reported, recovered, scheduler, bus } = setup(async () =>
      result([
        { step: 'screenshots', message: 'EACCES' },
        { step: 'vacuum', message: 'busy' },
      ]),
    );
    const run = await scheduler.tick();
    expect(run?.outcome).toBe('partial');
    expect(reported.map((d) => d.details)).toEqual([{ step: 'screenshots' }, { step: 'vacuum' }]);
    expect(recovered).toEqual([]);
    const completed = bus.published.find((p) => p.name === 'retention.completed')
      ?.payload as DomainEvents['retention.completed'];
    expect(completed).toMatchObject({ result: 'partial', severity: 'warn', pruned_rows: 4 });
  });

  it('status matches the contracts RetentionStatus and coalesces overlapping ticks', async () => {
    let release: () => void = () => undefined;
    const { scheduler, clock } = setup(
      () => new Promise((resolve) => (release = () => resolve(result()))),
    );
    scheduler.start();
    expect(scheduler.status()).toMatchObject({ last_run_at: null, next_run_at: 61_000 });
    const first = scheduler.tick();
    expect(await scheduler.tick()).toBeUndefined();
    release();
    await first;
    await clock.advance(5);
    const status = scheduler.status();
    expect(RetentionStatus.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({
      days: 7,
      last_result: 'ok',
      artifacts_pending: 4,
      pruned_rows: 4,
    });
  });
});
