/** @module app/observability/log-persist-sink.test — level filter, batching, timer flush, drop counting, never throws. */

import { describe, expect, it } from 'bun:test';
import type { WriteJob } from '../../ports/persistence/write-queue.ts';
import {
  createLogPersistSink,
  LogPersistSink,
  type NewLogRow,
  type TimerScheduler,
} from './log-persist-sink.ts';

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

function setup(options: { accept?: boolean; batchSize?: number; level?: 'info' | 'warn' } = {}) {
  const jobs: WriteJob[] = [];
  const rows: NewLogRow[] = [];
  const timers = new ManualTimers();
  const sink = new LogPersistSink({
    queue: {
      enqueue: (_op, job) => {
        if (options.accept === false) return false;
        jobs.push(job);
        return true;
      },
    },
    store: {
      insertMany: async (batch) => {
        rows.push(...batch);
      },
    },
    level: options.level ?? 'info',
    batchSize: options.batchSize ?? 3,
    scheduler: timers,
  });
  const run = async () => {
    for (const job of jobs.splice(0)) await job({} as never);
  };
  return { sink, jobs, rows, timers, run };
}

const rec = (level: string, n: number, extra: Record<string, unknown> = {}) => ({
  ts: n,
  level,
  msg: `m${n}`,
  module: 'sessions',
  session_id: 'shop-a1b2c3d4',
  ...extra,
});

describe('LogPersistSink', () => {
  it('filters by threshold and batches by size', async () => {
    const { sink, jobs, rows, run } = setup({ level: 'warn' });
    sink.write(rec('info', 1));
    sink.write(rec('debug', 2));
    sink.write(rec('warn', 3));
    sink.write(rec('error', 4, { tool: 'navigate' }));
    expect(jobs).toHaveLength(0);
    sink.write(rec('warn', 5));
    expect(jobs).toHaveLength(1);
    await run();
    expect(rows.map((r) => r.msg)).toEqual(['m3', 'm4', 'm5']);
    expect(rows[1]).toMatchObject({ sessionId: 'shop-a1b2c3d4', fields: { tool: 'navigate' } });
    expect(rows[0]?.fields).toBeNull();
    expect(sink.written).toBe(3);
  });

  it('flushes a partial batch on the timer and on flush()', async () => {
    const { sink, jobs, timers } = setup();
    sink.write(rec('info', 1));
    expect(timers.pending).toHaveLength(1);
    timers.fire();
    expect(jobs).toHaveLength(1);
    sink.write(rec('info', 2));
    await sink.flush();
    expect(jobs).toHaveLength(2);
  });

  it('counts drops for refused enqueues and a closed sink', async () => {
    const refused = setup({ accept: false, batchSize: 2 });
    refused.sink.write(rec('info', 1));
    refused.sink.write(rec('info', 2));
    expect(refused.sink.dropped).toBe(2);

    const closed = setup({ batchSize: 10 });
    closed.sink.write(rec('info', 1));
    await closed.sink.close();
    expect(closed.sink.written).toBe(1);
    closed.sink.write(rec('info', 99));
    expect(closed.sink.dropped).toBe(1);
  });

  it('never throws on a throwing queue or unserialisable fields', () => {
    const sink = new LogPersistSink({
      queue: {
        enqueue: () => {
          throw new Error('boom');
        },
      },
      store: { insertMany: async () => undefined },
      level: 'info',
      batchSize: 1,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => sink.write(rec('info', 1, { cyclic }))).not.toThrow();
    expect(sink.dropped).toBe(1);
  });

  it('createLogPersistSink returns null when off', () => {
    const deps = { queue: { enqueue: () => true }, store: { insertMany: async () => undefined } };
    expect(createLogPersistSink({ ...deps, level: 'off' })).toBeNull();
    expect(createLogPersistSink({ ...deps, level: 'warn' })).toBeInstanceOf(LogPersistSink);
  });
});
