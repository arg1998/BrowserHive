/** @module test/persistence/conformance-sessions.test — SessionRepository, UnitOfWork rollback, cascade. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import { pageRecord, screenshotRecord, sessionRecord, toolCallRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
});
afterEach(async () => {
  await t.close();
});

describe('SessionRepository', () => {
  it('inserts idempotently and round-trips a record with counts', async () => {
    const record = sessionRecord({ identity: { ua: 'x' }, config: { a: 1 } });
    await t.repos.sessions.insert(record);
    await t.repos.sessions.insert({ ...record, slug: 'changed' });
    const got = await t.repos.sessions.get(record.sessionId);
    expect(got).toEqual({
      ...record,
      counts: { toolCalls: 0, errors: 0, pages: 0, blocked: 0, attentionOpen: 0, vaultAccess: 0 },
    });
    expect(await t.repos.sessions.get('missing')).toBeNull();
  });

  it('updates, closes once, archives and reconciles', async () => {
    await t.repos.sessions.insert(sessionRecord());
    expect(
      await t.repos.sessions.update('shop-a1b2c3d4', { lastUrl: 'https://a/', state: 'paused' }),
    ).toBe(true);
    expect(await t.repos.sessions.update('shop-a1b2c3d4', {})).toBe(false);
    expect((await t.repos.sessions.get('shop-a1b2c3d4'))?.lastUrl).toBe('https://a/');
    expect(await t.repos.sessions.markClosed('shop-a1b2c3d4', 5, 'user')).toBe(true);
    expect(await t.repos.sessions.markClosed('shop-a1b2c3d4', 6, 'crash')).toBe(false);
    const closed = await t.repos.sessions.get('shop-a1b2c3d4');
    expect(closed?.closedAt).toBe(5);
    expect(closed?.state).toBe('closed');
    expect(await t.repos.sessions.archive('shop-a1b2c3d4', 7)).toBe(true);
    expect(await t.repos.sessions.archive('shop-a1b2c3d4', 8)).toBe(false);
    expect(await t.repos.sessions.unarchive('shop-a1b2c3d4')).toBe(true);
    await t.repos.sessions.insert(sessionRecord({ sessionId: 'open-00000001' }));
    expect(await t.repos.sessions.reconcileOpen(9, 'interrupted')).toBe(1);
    expect((await t.repos.sessions.get('open-00000001'))?.closedReason).toBe('interrupted');
  });

  it('lists with filters, facets, keyset pagination and totals', async () => {
    for (let i = 0; i < 7; i++) {
      await t.repos.sessions.insert(
        sessionRecord({
          sessionId: `s${i}-0000000${i}`,
          slug: `s${i}`,
          owner: i % 2 === 0 ? 'alice' : 'bob',
          channel: i < 3 ? 'chrome' : 'chromium',
          createdAt: 1_000 + i,
          closedAt: i === 6 ? 2_000 : null,
          state: i === 6 ? 'closed' : 'live',
          archivedAt: i === 5 ? 3_000 : null,
        }),
      );
    }
    const first = await t.repos.sessions.list({ limit: 2, total: true });
    expect(first.items.map((s) => s.slug)).toEqual(['s6', 's4']);
    expect(first.total).toBe(6);
    const second = await t.repos.sessions.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((s) => s.slug)).toEqual(['s3', 's2']);
    const third = await t.repos.sessions.list({ limit: 2, cursor: second.nextCursor });
    expect(third.items.map((s) => s.slug)).toEqual(['s1', 's0']);
    expect(third.nextCursor).toBeNull();
    expect((await t.repos.sessions.list({ view: 'live' })).items.length).toBe(5);
    expect((await t.repos.sessions.list({ view: 'closed' })).items.map((s) => s.slug)).toEqual([
      's6',
    ]);
    expect((await t.repos.sessions.list({ archived: 'only' })).items.map((s) => s.slug)).toEqual([
      's5',
    ]);
    expect((await t.repos.sessions.list({ archived: 'include' })).items.length).toBe(7);
    expect((await t.repos.sessions.list({ owner: 'bob' })).items.length).toBe(2);
    expect((await t.repos.sessions.list({ channels: ['chrome'] })).items.length).toBe(3);
    expect((await t.repos.sessions.list({ q: 's1' })).items.map((s) => s.slug)).toEqual(['s1']);
    expect(
      (await t.repos.sessions.list({ sort: 'slug', dir: 'asc', limit: 3 })).items.map(
        (s) => s.slug,
      ),
    ).toEqual(['s0', 's1', 's2']);
    const facets = await t.repos.sessions.facets({});
    expect(facets.owners).toEqual([
      { value: 'alice', count: 4 },
      { value: 'bob', count: 2 },
    ]);
    expect(facets.states).toEqual([
      { value: 'closed', count: 1 },
      { value: 'live', count: 5 },
    ]);
  });

  it('keeps pagination stable when rows are inserted between pages', async () => {
    for (let i = 0; i < 4; i++)
      await t.repos.sessions.insert(
        sessionRecord({ sessionId: `p${i}-0000000${i}`, slug: `p${i}`, createdAt: 100 + i }),
      );
    const page1 = await t.repos.sessions.list({ limit: 2, sort: 'created_at' });
    await t.repos.sessions.insert(
      sessionRecord({ sessionId: 'new-00000009', slug: 'new', createdAt: 999 }),
    );
    const page2 = await t.repos.sessions.list({
      limit: 2,
      sort: 'created_at',
      cursor: page1.nextCursor,
    });
    expect([...page1.items, ...page2.items].map((s) => s.slug)).toEqual(['p3', 'p2', 'p1', 'p0']);
  });

  it('rejects a cursor from another resource', async () => {
    const page = await t.repos.sessions.list({});
    void page;
    let error: unknown;
    try {
      await t.repos.sessions.list({
        cursor: Buffer.from(JSON.stringify({ r: 'pages', k: 1, id: 'x' })).toString('base64url'),
      });
    } catch (e) {
      error = e;
    }
    expect(isAppError(error, 'VALIDATION_FAILED')).toBe(true);
  });

  it('deletes with cascade and enqueues the session directory', async () => {
    await t.repos.sessions.insert(sessionRecord());
    await t.repos.toolCalls.insert(toolCallRecord());
    await t.repos.screenshots.insert(screenshotRecord());
    await t.repos.pages.insert(pageRecord());
    const result = await t.repos.sessions.delete('shop-a1b2c3d4', 'sessions/shop-a1b2c3d4');
    expect(result.rows).toBe(4);
    expect(result.paths).toEqual(['sessions/shop-a1b2c3d4']);
    expect(await t.repos.toolCalls.get(toolCallRecord().eventId)).toBeNull();
    expect(await t.repos.screenshots.get(toolCallRecord().eventId)).toBeNull();
    expect((await t.repos.artifactOutbox.pending(10)).map((a) => a.path)).toEqual([
      'sessions/shop-a1b2c3d4',
    ]);
    expect(await t.repos.sessions.delete('shop-a1b2c3d4', 'x')).toEqual({ rows: 0, paths: [] });
  });

  it('counts children on the list row', async () => {
    await t.repos.sessions.insert(sessionRecord());
    await t.repos.toolCalls.insert(toolCallRecord());
    await t.repos.toolCalls.insert(
      toolCallRecord({ eventId: 'e-2', ok: false, errorCode: 'X', seq: 2 }),
    );
    await t.repos.pages.insert(pageRecord());
    const pending = {
      sessionId: 'shop-a1b2c3d4',
      owner: 'local',
      reason: 'r',
      entryName: null,
      tool: null,
      toolEventId: null,
      pageUrl: null,
      options: null,
      idempotencyKey: null,
      createdAt: 10,
      deadlineAt: null,
    } as const;
    // Only pending `attention` requests count as open attention; a vault confirm does not.
    await t.repos.operatorRequests.insert({
      ...pending,
      requestId: 'a-000000000001',
      kind: 'attention',
      mode: 'takeover',
    });
    await t.repos.operatorRequests.insert({
      ...pending,
      requestId: 'a-000000000002',
      kind: 'vault_confirm',
      mode: null,
    });
    const row = await t.repos.sessions.get('shop-a1b2c3d4');
    expect(row?.counts).toEqual({
      toolCalls: 2,
      errors: 1,
      pages: 1,
      blocked: 0,
      attentionOpen: 1,
      vaultAccess: 0,
    });
  });
});

describe('UnitOfWork', () => {
  it('commits on return and rolls back on throw', async () => {
    await t.uow.transaction(async (r) => {
      await r.sessions.insert(sessionRecord({ sessionId: 'tx-00000001' }));
    });
    expect(await t.repos.sessions.get('tx-00000001')).not.toBeNull();
    let error: unknown;
    try {
      await t.uow.transaction(async (r) => {
        await r.sessions.insert(sessionRecord({ sessionId: 'tx-00000002' }));
        throw new Error('boom');
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(await t.repos.sessions.get('tx-00000002')).toBeNull();
  });
});
