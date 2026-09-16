/** @module infra/persistence/write-queue.test — FIFO order, one transaction per drain, drop counting, close. */

import { describe, expect, it } from 'bun:test';
import { FakeLogger, sessionRecord } from '../../../test/persistence/helpers.ts';
import { openMemory } from '../../../test/persistence/setup.ts';
import { SqliteWriteQueue } from './write-queue.ts';

describe('SqliteWriteQueue', () => {
  it('drains enqueued jobs in order on a microtask and reads see them after drain', async () => {
    const t = await openMemory();
    const queue = new SqliteWriteQueue({ uow: t.uow, logger: t.logger });
    const order: string[] = [];
    expect(
      queue.enqueue('sessions.insert', async (r) => {
        order.push('a');
        await r.sessions.insert(sessionRecord({ sessionId: 'a-00000001', createdAt: 1 }));
      }),
    ).toBe(true);
    queue.enqueue('sessions.insert', async (r) => {
      order.push('b');
      await r.sessions.insert(sessionRecord({ sessionId: 'b-00000001', createdAt: 2 }));
    });
    expect(queue.depth).toBe(2);
    await queue.drain();
    expect(order).toEqual(['a', 'b']);
    expect(queue.depth).toBe(0);
    expect(
      (await t.repos.sessions.list({ sort: 'created_at', dir: 'asc' })).items.map(
        (s) => s.sessionId,
      ),
    ).toEqual(['a-00000001', 'b-00000001']);
    await queue.close();
    await t.close();
  });

  it('counts failed jobs as dropped and keeps draining the rest', async () => {
    const t = await openMemory();
    const queue = new SqliteWriteQueue({ uow: t.uow, logger: t.logger });
    queue.enqueue('bad', async (r) => {
      await r.screenshots.insert({
        eventId: 'orphan',
        sessionId: 'nope',
        path: 'p',
        kind: 'tool',
        contentType: 'image/png',
        width: 1,
        height: 1,
        sizeBytes: 1,
        ts: 1,
      });
    });
    queue.enqueue('good', async (r) => {
      await r.sessions.insert(sessionRecord());
    });
    await queue.drain();
    expect(queue.droppedWrites).toBe(1);
    expect(await t.repos.sessions.get('shop-a1b2c3d4')).not.toBeNull();
    expect(t.logger.records.some((r) => r.msg === 'write failed')).toBe(true);
    await t.close();
  });

  it('refuses writes when full or closed', async () => {
    const t = await openMemory();
    const queue = new SqliteWriteQueue({ uow: t.uow, logger: t.logger, maxDepth: 1 });
    expect(queue.enqueue('one', async () => undefined)).toBe(true);
    expect(queue.enqueue('two', async () => undefined)).toBe(false);
    expect(queue.droppedWrites).toBe(1);
    await queue.close();
    expect(queue.enqueue('late', async () => undefined)).toBe(false);
    expect(queue.droppedWrites).toBe(2);
    await queue.close();
    await t.close();
  });

  it('coalesces concurrent drains', async () => {
    const t = await openMemory();
    const logger = new FakeLogger();
    const queue = new SqliteWriteQueue({ uow: t.uow, logger, batchSize: 2 });
    for (let i = 0; i < 5; i++) {
      queue.enqueue('sessions.insert', async (r) => {
        await r.sessions.insert(sessionRecord({ sessionId: `s${i}-0000000${i}`, createdAt: i }));
      });
    }
    await Promise.all([queue.drain(), queue.drain(), queue.drain()]);
    expect(queue.depth).toBe(0);
    expect((await t.repos.sessions.list({})).items.length).toBe(5);
    await t.close();
  });
});
