/** @module infra/persistence/log-rows.test — `SqliteLogRepository` inserts through the write queue's transaction. */

import { afterEach, describe, expect, it } from 'bun:test';
import { openMemory, type TestDb } from '../../../test/persistence/setup.ts';
import { LOG_INSERT_CHUNK, type NewLogRecordRow, SqliteLogRepository } from './log-rows.ts';
import { SqliteWriteQueue } from './write-queue.ts';

function row(i: number): NewLogRecordRow {
  return {
    ts: 1_700_000_000_000 + i,
    level: i % 2 === 0 ? 'info' : 'warn',
    module: 'sessions',
    msg: 'session opened',
    traceId: null,
    spanId: null,
    requestId: `r-${i}`,
    sessionId: null,
    principal: 'local',
    fields: i === 0 ? { tool: 'navigate', size: 3 } : null,
  };
}

describe('SqliteLogRepository', () => {
  let db: TestDb | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('inserts batches larger than one chunk and keeps fields as JSON', async () => {
    db = await openMemory();
    const store = new SqliteLogRepository(db.handle.db);
    const rows = Array.from({ length: LOG_INSERT_CHUNK + 7 }, (_, i) => row(i));
    await store.insertMany(rows);
    await store.insertMany([]);
    expect(await store.count()).toBe(LOG_INSERT_CHUNK + 7);
    const first = await db.handle.db
      .selectFrom('logs')
      .selectAll()
      .orderBy('seq', 'asc')
      .executeTakeFirstOrThrow();
    expect(first.fields_json).toBe('{"tool":"navigate","size":3}');
    expect(first.request_id).toBe('r-0');
  });

  it('is bound into the repository bundle so queue jobs write inside the drain transaction', async () => {
    db = await openMemory();
    const store = new SqliteLogRepository(db.handle.db);
    const queue = new SqliteWriteQueue({ uow: db.uow, logger: db.logger });
    expect(queue.enqueue('logs.insert', (repos) => repos.logs.insertMany([row(1), row(2)]))).toBe(
      true,
    );
    await queue.drain();
    expect(await store.count()).toBe(2);
    expect(queue.droppedWrites).toBe(0);
    await queue.close();
  });
});
