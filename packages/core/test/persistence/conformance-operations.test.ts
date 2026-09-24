/** @module test/persistence/conformance-operations.test — operator requests/actions, notifications, preferences, system events, idempotency, outbox, migrations. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import type {
  NewOperatorRequest,
  NotificationRecord,
} from '../../src/ports/persistence/records.ts';
import { sessionRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
  await t.repos.principals.insert({
    principalId: 'local',
    kind: 'operator',
    display: 'Op',
    tenantId: null,
    mustChangePassword: false,
    createdAt: 1,
    updatedAt: 1,
    disabledAt: null,
  });
});
afterEach(async () => {
  await t.close();
});

const request: NewOperatorRequest = {
  requestId: 'a-000000000001',
  kind: 'attention',
  sessionId: 'shop-a1b2c3d4',
  owner: 'local',
  reason: 'captcha',
  mode: 'takeover',
  entryName: null,
  tool: 'navigate',
  toolEventId: null,
  pageUrl: 'https://x/',
  options: { min_wait_ms: 1 },
  idempotencyKey: 'k1',
  createdAt: 10,
  deadlineAt: 100,
};

describe('OperatorRequestRepository', () => {
  it('inserts pending, dedupes on idempotency key, resolves once', async () => {
    await t.repos.operatorRequests.insert(request);
    await t.repos.operatorRequests.insert({ ...request, requestId: 'a-000000000002' });
    expect((await t.repos.operatorRequests.open()).map((r) => r.requestId)).toEqual([
      'a-000000000001',
    ]);
    expect(
      (await t.repos.operatorRequests.getByIdempotencyKey('shop-a1b2c3d4', 'k1'))?.requestId,
    ).toBe('a-000000000001');
    expect(await t.repos.operatorRequests.countOpen('attention')).toBe(1);
    expect(await t.repos.operatorRequests.countOpen('vault_confirm')).toBe(0);
    expect(
      await t.repos.operatorRequests.resolve('a-000000000001', {
        status: 'resolved',
        at: 40,
        message: 'done',
        resolvedBy: 'local',
      }),
    ).toBe(true);
    expect(
      await t.repos.operatorRequests.resolve('a-000000000001', { status: 'rejected', at: 41 }),
    ).toBe(false);
    const got = await t.repos.operatorRequests.get('a-000000000001');
    expect(got).toEqual({
      ...request,
      status: 'resolved',
      message: 'done',
      resolvedBy: 'local',
      resolutionReason: null,
      resolvedAt: 40,
      sessionSlug: 'shop',
      waitedMs: 30,
    });
    expect((await t.repos.operatorRequests.open()).length).toBe(0);
  });

  it('lists history with filters and sort keys', async () => {
    await t.repos.operatorRequests.insert(request);
    await t.repos.operatorRequests.insert({
      ...request,
      requestId: 'a-000000000002',
      idempotencyKey: null,
      kind: 'vault_confirm',
      mode: null,
      entryName: 'github',
      createdAt: 20,
    });
    await t.repos.operatorRequests.resolve('a-000000000001', { status: 'timeout', at: 110 });
    expect(
      (await t.repos.operatorRequests.listHistory({ statuses: ['timeout'] })).items.map(
        (r) => r.requestId,
      ),
    ).toEqual(['a-000000000001']);
    expect(
      (await t.repos.operatorRequests.listHistory({ kind: 'vault_confirm' })).items[0]?.entryName,
    ).toBe('github');
    expect((await t.repos.operatorRequests.listHistory({ modes: ['takeover'] })).items.length).toBe(
      1,
    );
    expect(
      (await t.repos.operatorRequests.listHistory({ sort: 'waited_ms', dir: 'desc' })).items.map(
        (r) => r.waitedMs,
      ),
    ).toEqual([100, null]);
    expect((await t.repos.operatorRequests.listHistory({ q: 'captcha', total: true })).total).toBe(
      2,
    );
  });

  it('counts status and mode facets disjunctively', async () => {
    const add = (id: string, mode: 'takeover' | 'notify', createdAt: number) =>
      t.repos.operatorRequests.insert({
        ...request,
        requestId: id,
        idempotencyKey: null,
        mode,
        createdAt,
      });
    await add('a-000000000001', 'takeover', 10);
    await add('a-000000000002', 'notify', 20);
    await add('a-000000000003', 'takeover', 30);
    await add('a-000000000004', 'takeover', 40);
    await t.repos.operatorRequests.insert({
      ...request,
      requestId: 'a-000000000005',
      idempotencyKey: null,
      kind: 'vault_confirm',
      mode: null,
      entryName: 'github',
    });
    await t.repos.operatorRequests.resolve('a-000000000001', { status: 'resolved', at: 50 });
    await t.repos.operatorRequests.resolve('a-000000000002', { status: 'rejected', at: 50 });
    await t.repos.operatorRequests.resolve('a-000000000003', { status: 'resolved', at: 50 });

    const all = await t.repos.operatorRequests.facets({ kind: 'attention' });
    expect(all.statuses).toEqual([
      { value: 'pending', count: 1 },
      { value: 'rejected', count: 1 },
      { value: 'resolved', count: 2 },
    ]);
    expect(all.modes).toEqual([
      { value: 'notify', count: 1 },
      { value: 'takeover', count: 3 },
    ]);
    // Selecting a status narrows the mode counts but not the other status counts.
    const narrowed = await t.repos.operatorRequests.facets({
      kind: 'attention',
      statuses: ['resolved'],
    });
    expect(narrowed.statuses.map((f) => f.count)).toEqual([1, 1, 2]);
    expect(narrowed.modes).toEqual([{ value: 'takeover', count: 2 }]);
  });

  it('cascades with the session', async () => {
    await t.repos.operatorRequests.insert(request);
    await t.repos.sessions.delete('shop-a1b2c3d4', 'sessions/shop-a1b2c3d4');
    expect(await t.repos.operatorRequests.get('a-000000000001')).toBeNull();
  });
});

describe('OperatorActionRepository', () => {
  it('appends and lists', async () => {
    expect(
      await t.repos.operatorActions.append({
        eventId: 'oa-1',
        principalId: 'local',
        action: 'archive',
        resourceKind: 'session',
        resourceId: 's',
        details: null,
        occurredAt: 1,
      }),
    ).toBe(1);
    expect(
      await t.repos.operatorActions.append({
        eventId: 'oa-1',
        principalId: 'local',
        action: 'archive',
        resourceKind: 'session',
        resourceId: 's',
        details: null,
        occurredAt: 1,
      }),
    ).toBe(1);
    expect((await t.repos.operatorActions.list({ types: ['archive'] })).items.length).toBe(1);
    expect((await t.repos.operatorActions.list({ principalId: 'nobody' })).items.length).toBe(0);
  });
});

describe('NotificationRepository and PreferenceRepository', () => {
  const notification: NotificationRecord = {
    notificationId: 'n-1',
    principalId: 'local',
    type: 'attention',
    title: 'Attention requested',
    body: null,
    sessionId: 'shop-a1b2c3d4',
    target: '/sessions/x',
    sourceEventId: null,
    createdAt: 1,
    updatedAt: 1,
    count: 1,
    groupKey: null,
    readAt: null,
    dismissedAt: null,
  };

  it('lists inbox, counts unread, marks read and dismisses', async () => {
    await t.repos.notifications.insert(notification);
    await t.repos.notifications.insert({
      ...notification,
      notificationId: 'n-2',
      type: 'error',
      createdAt: 2,
      updatedAt: 2,
    });
    await t.repos.notifications.insert({
      ...notification,
      notificationId: 'n-3',
      principalId: null,
      createdAt: 3,
      updatedAt: 3,
    });
    expect(await t.repos.notifications.unreadCount('local')).toBe(2);
    expect(await t.repos.notifications.unreadCount(null)).toBe(1);
    expect(
      (await t.repos.notifications.list({ principalId: 'local', limit: 1 })).items.map(
        (n) => n.notificationId,
      ),
    ).toEqual(['n-2']);
    expect((await t.repos.notifications.list({ types: ['error'] })).items.length).toBe(1);
    expect(await t.repos.notifications.markRead('n-1', 5)).toBe(true);
    expect(await t.repos.notifications.markRead('n-1', 6)).toBe(false);
    expect(
      (await t.repos.notifications.list({ principalId: 'local', read: 'unread' })).items.map(
        (n) => n.notificationId,
      ),
    ).toEqual(['n-2']);
    expect(await t.repos.notifications.markAllRead('local', 7)).toBe(1);
    expect(await t.repos.notifications.dismiss('n-1', 8)).toBe(true);
    expect((await t.repos.notifications.list({ principalId: 'local' })).items.length).toBe(1);
    expect(await t.repos.notifications.dismissAll('local', 9)).toBe(1);
    expect(await t.repos.notifications.get('n-1')).toMatchObject({ readAt: 5, dismissedAt: 8 });
  });

  it('grows an open group row and orders by updated_at', async () => {
    const group = 'tool-errors:shop-a1b2c3d4';
    await t.repos.notifications.insert({ ...notification, type: 'error', groupKey: group });
    await t.repos.notifications.insert({
      ...notification,
      notificationId: 'n-2',
      createdAt: 5,
      updatedAt: 5,
    });
    expect(await t.repos.notifications.findOpenGroup('local', 'tool-errors:other')).toBeNull();
    expect(await t.repos.notifications.findOpenGroup(null, group)).toBeNull();
    expect((await t.repos.notifications.findOpenGroup('local', group))?.notificationId).toBe('n-1');
    const patch = {
      title: 'shop · 2 tool errors',
      body: 'click · X (1 ms)',
      target: '/sessions/shop-a1b2c3d4?kinds=tool&errors_only=1',
      sourceEventId: 'e-2',
      count: 2,
      updatedAt: 9,
    };
    expect(await t.repos.notifications.updateGroup('n-1', patch)).toMatchObject({
      ...patch,
      createdAt: 1,
      groupKey: group,
    });
    const ids = async (query: object) =>
      (await t.repos.notifications.list({ principalId: 'local', ...query })).items.map(
        (n) => n.notificationId,
      );
    expect(await ids({})).toEqual(['n-1', 'n-2']);
    expect(await ids({ sort: 'created_at' })).toEqual(['n-2', 'n-1']);
    expect(await ids({ since: 6 })).toEqual(['n-1']);
    expect(await ids({ sort: 'created_at', since: 6 })).toEqual([]);
    const first = await t.repos.notifications.list({ principalId: 'local', limit: 1 });
    const next = await t.repos.notifications.list({
      principalId: 'local',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(next.items.map((n) => n.notificationId)).toEqual(['n-2']);
    expect(await t.repos.notifications.markRead('n-1', 10)).toBe(true);
    expect(await t.repos.notifications.findOpenGroup('local', group)).toBeNull();
    expect(await t.repos.notifications.updateGroup('n-1', { ...patch, count: 3 })).toBeNull();
    expect((await t.repos.notifications.get('n-1'))?.count).toBe(2);
  });

  it('nulls the session reference when the session is deleted', async () => {
    await t.repos.notifications.insert(notification);
    await t.repos.sessions.delete('shop-a1b2c3d4', 'sessions/shop-a1b2c3d4');
    expect((await t.repos.notifications.get('n-1'))?.sessionId).toBeNull();
  });

  it('stores preferences as JSON and replaces the map', async () => {
    await t.repos.preferences.set('local', 'theme', 'dark', 1);
    await t.repos.preferences.set('local', 'views', [{ name: 'a' }], 2);
    expect((await t.repos.preferences.get('local', 'views'))?.value).toEqual([{ name: 'a' }]);
    await t.repos.preferences.replaceAll('local', { theme: 'light', pageSize: 25 }, 3);
    expect((await t.repos.preferences.list('local')).map((p) => [p.key, p.value])).toEqual([
      ['pageSize', 25],
      ['theme', 'light'],
    ]);
    expect(await t.repos.preferences.remove('local', 'theme')).toBe(true);
    expect(await t.repos.preferences.remove('local', 'theme')).toBe(false);
  });
});

describe('SystemEventRepository', () => {
  it('aggregates repeats by code and details, resolves, lists', async () => {
    const first = await t.repos.systemEvents.record({
      eventId: 'se-1',
      code: 'RETENTION_FAILED',
      severity: 'warn',
      message: 'm',
      details: { step: 'logs' },
      at: 1,
    });
    const again = await t.repos.systemEvents.record({
      eventId: 'se-2',
      code: 'RETENTION_FAILED',
      severity: 'error',
      message: 'm2',
      details: { step: 'logs' },
      at: 2,
    });
    const other = await t.repos.systemEvents.record({
      eventId: 'se-3',
      code: 'RETENTION_FAILED',
      severity: 'warn',
      message: 'm',
      details: { step: 'pages' },
      at: 3,
    });
    expect(again).toMatchObject({
      seq: first.seq,
      count: 2,
      lastSeenAt: 2,
      severity: 'error',
      message: 'm2',
    });
    expect(other.seq).not.toBe(first.seq);
    expect((await t.repos.systemEvents.open()).length).toBe(2);
    expect(await t.repos.systemEvents.resolve('RETENTION_FAILED', 4)).toBe(2);
    expect((await t.repos.systemEvents.open()).length).toBe(0);
    expect(
      (await t.repos.systemEvents.list({ severities: ['error'] })).items.map((e) => e.eventId),
    ).toEqual(['se-1']);
  });
});

describe('IdempotencyRepository and ArtifactOutboxRepository', () => {
  it('keeps the first response and prunes', async () => {
    expect(
      await t.repos.idempotency.put({
        key: 'k',
        principalId: 'local',
        route: 'r',
        response: { n: 1 },
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await t.repos.idempotency.put({
        key: 'k',
        principalId: 'local',
        route: 'r',
        response: { n: 2 },
        createdAt: 2,
      }),
    ).toBe(false);
    expect((await t.repos.idempotency.get('k', 'local', 'r'))?.response).toEqual({ n: 1 });
    expect(await t.repos.idempotency.get('k', 'other', 'r')).toBeNull();
    expect(await t.repos.idempotency.pruneOlderThan(10)).toBe(1);
  });

  it('queues, fails and removes artifacts', async () => {
    const id = await t.repos.artifactOutbox.enqueue({
      kind: 'trace',
      path: 'a/trace.zip',
      sessionId: null,
      enqueuedAt: 1,
    });
    await t.repos.artifactOutbox.markFailed(id, 'EBUSY');
    expect(await t.repos.artifactOutbox.pending(10)).toEqual([
      {
        outboxId: id,
        kind: 'trace',
        path: 'a/trace.zip',
        sessionId: null,
        enqueuedAt: 1,
        attempts: 1,
        lastError: 'EBUSY',
      },
    ]);
    expect(await t.repos.artifactOutbox.count()).toBe(1);
    await t.repos.artifactOutbox.remove(id);
    expect(await t.repos.artifactOutbox.count()).toBe(0);
  });
});

describe('SchemaMigrationRepository', () => {
  it('lists applied migrations', async () => {
    expect((await t.repos.schemaMigrations.list()).map((m) => [m.version, m.name])).toEqual([
      [1, 'initial'],
      [2, 'notification-groups'],
      [3, 'harness-identity'],
    ]);
    expect(await t.repos.schemaMigrations.currentVersion()).toBe(SCHEMA_VERSION);
  });
});
