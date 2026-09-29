/** @module test/persistence/conformance-notifications.test — one suite over the SQLite notification outbox repositories and their in-memory doubles (channels, deliveries, channel messages, thread lookup, revise), so the doubles the app tests use behave like the real thing (spec 09). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  NewNotificationDelivery,
  NotificationRecord,
} from '../../src/ports/persistence/records.ts';
import type { Repositories } from '../../src/ports/persistence/unit-of-work.ts';
import { channelRecord } from '../helpers/fake-channel.ts';
import { InMemoryRepositories } from '../helpers/in-memory-repos.ts';
import { sessionRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

type Repos = Pick<
  Repositories,
  | 'notifications'
  | 'notificationChannels'
  | 'notificationDeliveries'
  | 'notificationChannelMessages'
>;

function notification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    notificationId: 'n-000000000001',
    principalId: null,
    type: 'attention',
    title: 'Attention requested',
    body: null,
    sessionId: null,
    target: null,
    sourceEventId: 'a-000000000001',
    createdAt: 10,
    updatedAt: 10,
    count: 1,
    groupKey: null,
    readAt: null,
    dismissedAt: null,
    kind: 'attention.requested',
    category: 'needs-you',
    severity: 'warn',
    state: 'open',
    revision: 1,
    thread: 'attention:a-000000000001',
    messageJson: '{"schema":1}',
    ...overrides,
  };
}

function job(overrides: Partial<NewNotificationDelivery> = {}): NewNotificationDelivery {
  return {
    channelId: 'nc-000000000001',
    notificationId: 'n-000000000001',
    revision: 1,
    op: 'send',
    status: 'pending',
    reason: null,
    nextAttemptAt: 100,
    createdAt: 100,
    ...overrides,
  };
}

const adapters: ReadonlyArray<
  readonly [string, () => Promise<{ repos: Repos; close(): Promise<void> }>]
> = [
  [
    'sqlite',
    async () => {
      const t: TestDb = await openMemory();
      await t.repos.sessions.insert(sessionRecord());
      return { repos: t.repos, close: () => t.close() };
    },
  ],
  ['in-memory', async () => ({ repos: new InMemoryRepositories(), close: async () => undefined })],
];

for (const [name, open] of adapters) {
  describe(`notification outbox repositories (${name})`, () => {
    let r: Repos;
    let close: () => Promise<void>;
    beforeEach(async () => {
      const opened = await open();
      r = opened.repos;
      close = opened.close;
      await r.notifications.insert(notification());
      await r.notificationChannels.upsert(channelRecord());
    });
    afterEach(async () => {
      await close();
    });

    it('finds the newest row of a thread and revises it without touching the inbox fields', async () => {
      await r.notifications.insert(
        notification({ notificationId: 'n-000000000002', createdAt: 20, updatedAt: 20 }),
      );
      expect(
        (await r.notifications.findLatestByThread(null, 'attention:a-000000000001'))
          ?.notificationId,
      ).toBe('n-000000000002');
      expect(
        await r.notifications.findLatestByThread('someone', 'attention:a-000000000001'),
      ).toBeNull();
      await r.notifications.markRead('n-000000000001', 30);
      const revised = await r.notifications.revise('n-000000000001', {
        state: 'resolved',
        severity: 'warn',
        revision: 2,
        messageJson: '{"schema":1,"revision":2}',
      });
      expect(revised).toMatchObject({
        state: 'resolved',
        revision: 2,
        title: 'Attention requested',
        updatedAt: 10,
        readAt: 30,
        messageJson: '{"schema":1,"revision":2}',
      });
      const kept = await r.notifications.revise('n-000000000001', {
        state: 'final',
        severity: 'info',
        revision: 3,
        messageJson: null,
      });
      expect(kept?.messageJson).toBe('{"schema":1,"revision":2}');
      expect(
        await r.notifications.revise('n-unknown00000', {
          state: 'final',
          severity: 'info',
          revision: 2,
          messageJson: null,
        }),
      ).toBeNull();
    });

    it('lists unsettled request notifications, oldest first', async () => {
      await r.notifications.insert(
        notification({ notificationId: 'n-000000000002', createdAt: 5, state: 'acted' }),
      );
      await r.notifications.insert(
        notification({ notificationId: 'n-000000000003', createdAt: 1, state: 'resolved' }),
      );
      await r.notifications.insert(
        notification({ notificationId: 'n-000000000004', kind: 'tool.errors', createdAt: 2 }),
      );
      expect(
        (await r.notifications.listUnsettled(['attention.requested'], 10)).map(
          (n) => n.notificationId,
        ),
      ).toEqual(['n-000000000002', 'n-000000000001']);
      expect(await r.notifications.listUnsettled([], 10)).toEqual([]);
    });

    it('channels: upsert keeps status and counters, breaker counters, status, name clash', async () => {
      expect(await r.notificationChannels.recordFailure('nc-000000000001', 5, 'down')).toBe(1);
      expect(await r.notificationChannels.recordFailure('nc-000000000001', 6, 'down again')).toBe(
        2,
      );
      await r.notificationChannels.upsert(
        channelRecord({ rules: { min_severity: 'error' }, updatedAt: 7 }),
      );
      expect(await r.notificationChannels.get('nc-000000000001')).toMatchObject({
        failureCount: 2,
        lastError: 'down again',
        lastFailureAt: 6,
        rules: { min_severity: 'error' },
        updatedAt: 7,
      });
      await r.notificationChannels.recordSuccess('nc-000000000001', 8);
      expect(await r.notificationChannels.get('nc-000000000001')).toMatchObject({
        failureCount: 0,
        lastOkAt: 8,
      });
      await r.notificationChannels.recordFailure('nc-000000000001', 9, 'x');
      expect(await r.notificationChannels.setStatus('nc-000000000001', 'broken', 10)).toBe(true);
      expect((await r.notificationChannels.get('nc-000000000001'))?.failureCount).toBe(1);
      await r.notificationChannels.setStatus('nc-000000000001', 'active', 11);
      expect(await r.notificationChannels.get('nc-000000000001')).toMatchObject({
        status: 'active',
        failureCount: 0,
      });
      expect((await r.notificationChannels.getByName('phone'))?.channelId).toBe('nc-000000000001');
      expect(await r.notificationChannels.recordFailure('nc-unknown', 1, 'x')).toBe(0);
      expect(await r.notificationChannels.setStatus('nc-unknown', 'paused', 1)).toBe(false);
      await expect(
        r.notificationChannels.upsert(channelRecord({ channelId: 'nc-other', name: 'phone' })),
      ).rejects.toThrow();
    });

    it('deliveries: idempotent enqueue, due order, claim once, finish, reschedule, annotate', async () => {
      expect(
        await r.notificationDeliveries.enqueue([
          job(),
          job(),
          job({ revision: 2, op: 'edit', nextAttemptAt: 50 }),
        ]),
      ).toBe(2);
      const due = await r.notificationDeliveries.due(100, 10);
      expect(due.map((d) => [d.op, d.revision])).toEqual([
        ['edit', 2],
        ['send', 1],
      ]);
      expect(await r.notificationDeliveries.due(49, 10)).toEqual([]);
      const send = due[1];
      if (send === undefined) throw new Error('no job');
      expect(await r.notificationDeliveries.claim(send.seq, 101)).toBe(true);
      expect(await r.notificationDeliveries.claim(send.seq, 101)).toBe(false);
      expect(await r.notificationDeliveries.get(send.seq)).toMatchObject({
        status: 'sending',
        attempts: 1,
        updatedAt: 101,
      });
      await r.notificationDeliveries.finish(send.seq, {
        status: 'retrying',
        reason: 'unavailable',
        lastError: 'unavailable: down',
        durationMs: 3,
        nextAttemptAt: 200,
        updatedAt: 104,
      });
      expect(await r.notificationDeliveries.get(send.seq)).toMatchObject({
        status: 'retrying',
        nextAttemptAt: 200,
        lastError: 'unavailable: down',
        durationMs: 3,
      });
      await r.notificationDeliveries.reschedule(send.seq, 300, 105);
      await r.notificationDeliveries.annotate(send.seq, 'backlog:3', 106);
      expect(await r.notificationDeliveries.get(send.seq)).toMatchObject({
        nextAttemptAt: 300,
        reason: 'backlog:3',
      });
      await r.notificationDeliveries.finish(send.seq, {
        status: 'sent',
        messageRef: { message_id: 7 },
        updatedAt: 310,
      });
      expect(await r.notificationDeliveries.get(send.seq)).toMatchObject({
        status: 'sent',
        messageRef: { message_id: 7 },
        nextAttemptAt: null,
      });
      // A terminal job is not rescheduled or annotated.
      await r.notificationDeliveries.reschedule(send.seq, 999, 311);
      expect((await r.notificationDeliveries.get(send.seq))?.nextAttemptAt).toBeNull();
    });

    it('deliveries: supersede, suppress a channel, recover sending, count, list, info backlog', async () => {
      await r.notificationDeliveries.enqueue([
        job(),
        job({ revision: 2, op: 'edit' }),
        job({ revision: 3, op: 'edit' }),
        job({ revision: 3, op: 'delete' }),
      ]);
      const [send, edit2, edit3] = await r.notificationDeliveries
        .list({ limit: 10 })
        .then((rows) => [...rows].reverse());
      if (send === undefined || edit2 === undefined || edit3 === undefined) throw new Error('rows');
      expect(
        await r.notificationDeliveries.supersede(
          'nc-000000000001',
          'n-000000000001',
          2,
          5,
          'covered',
          send.seq,
        ),
      ).toBe(1);
      expect((await r.notificationDeliveries.get(edit2.seq))?.status).toBe('superseded');
      expect((await r.notificationDeliveries.get(send.seq))?.status).toBe('pending');
      await r.notificationDeliveries.claim(send.seq, 6);
      expect(await r.notificationDeliveries.recoverSending(7)).toBe(1);
      expect(await r.notificationDeliveries.get(send.seq)).toMatchObject({
        status: 'retrying',
        nextAttemptAt: 7,
      });
      expect(await r.notificationDeliveries.count(['pending', 'retrying'])).toBe(3);
      expect(
        await r.notificationDeliveries.suppressChannel('nc-000000000001', 'channel_paused', 8),
      ).toBe(3);
      expect(await r.notificationDeliveries.count(['suppressed'])).toBe(3);
      expect(
        (await r.notificationDeliveries.list({ statuses: ['superseded'] })).map((d) => d.seq),
      ).toEqual([edit2.seq]);
      expect(
        (await r.notificationDeliveries.list({ beforeSeq: edit3.seq })).map((d) => d.seq),
      ).toEqual([edit2.seq, send.seq]);
      await r.notifications.insert(
        notification({ notificationId: 'n-info00000001', severity: 'info', thread: 't' }),
      );
      await r.notificationDeliveries.enqueue([job({ notificationId: 'n-info00000001' })]);
      expect(
        (await r.notificationDeliveries.pendingInfoSends('nc-000000000001')).map(
          (d) => d.notificationId,
        ),
      ).toEqual(['n-info00000001']);
    });

    it('deliveries: filter the log by op and notification kind; per-channel stats', async () => {
      await r.notifications.insert(
        notification({ notificationId: 'n-tool00000001', kind: 'tool.errors', thread: 'x' }),
      );
      await r.notificationDeliveries.enqueue([
        job(),
        job({ revision: 2, op: 'edit' }),
        job({ notificationId: 'n-tool00000001' }),
        job({ notificationId: 'n-tool00000001', revision: 2, op: 'edit', status: 'suppressed' }),
      ]);
      const rows = [...(await r.notificationDeliveries.list({ limit: 10 }))].reverse();
      const [send, edit, toolSend, toolEdit] = rows;
      if (
        send === undefined ||
        edit === undefined ||
        toolSend === undefined ||
        toolEdit === undefined
      )
        throw new Error('rows');
      expect((await r.notificationDeliveries.list({ ops: ['edit'] })).map((d) => d.seq)).toEqual([
        toolEdit.seq,
        edit.seq,
      ]);
      expect(
        (await r.notificationDeliveries.list({ kinds: ['tool.errors'] })).map(
          (d) => d.notificationId,
        ),
      ).toEqual(['n-tool00000001', 'n-tool00000001']);
      await r.notificationDeliveries.claim(send.seq, 200);
      await r.notificationDeliveries.finish(send.seq, { status: 'sent', updatedAt: 300 });
      await r.notificationDeliveries.claim(toolSend.seq, 200);
      await r.notificationDeliveries.finish(toolSend.seq, {
        status: 'dead',
        reason: 'auth',
        updatedAt: 400,
      });
      const stats = await r.notificationDeliveries.stats(250);
      expect(stats).toEqual([
        {
          channelId: 'nc-000000000001',
          sent: 1,
          failed: 1,
          suppressed: 0,
          pending: 1,
          lastAt: 400,
          lastStatus: 'dead',
        },
      ]);
      expect((await r.notificationDeliveries.stats(1_000))[0]).toMatchObject({
        sent: 0,
        failed: 0,
        pending: 1,
        lastAt: 400,
      });
    });

    it('channel messages: upsert, first of a thread, TTL due once, expiry and delete marks', async () => {
      const message = {
        channelId: 'nc-000000000001',
        notificationId: 'n-000000000001',
        thread: 'attention:a-000000000001',
        messageRef: { chat_id: 1, message_id: 2 },
        lastRevision: 1,
        sentAt: 10,
        updatedAt: 10,
        expiresAt: 50,
        deletedAt: null,
      };
      await r.notificationChannelMessages.upsert(message);
      await r.notifications.insert(notification({ notificationId: 'n-000000000002' }));
      await r.notificationChannelMessages.upsert({
        ...message,
        notificationId: 'n-000000000002',
        sentAt: 20,
        expiresAt: null,
      });
      expect(
        (
          await r.notificationChannelMessages.firstInThread(
            'nc-000000000001',
            'attention:a-000000000001',
          )
        )?.notificationId,
      ).toBe('n-000000000001');
      expect(await r.notificationChannelMessages.dueForDelete(49, 10)).toEqual([]);
      expect(
        (await r.notificationChannelMessages.dueForDelete(50, 10)).map((m) => m.notificationId),
      ).toEqual(['n-000000000001']);
      await r.notificationDeliveries.enqueue([job({ op: 'delete', revision: 1 })]);
      expect(await r.notificationChannelMessages.dueForDelete(50, 10)).toEqual([]);
      await r.notificationChannelMessages.setExpiry('nc-000000000001', 'n-000000000002', 60);
      expect(
        (await r.notificationChannelMessages.get('nc-000000000001', 'n-000000000002'))?.expiresAt,
      ).toBe(60);
      await r.notificationChannelMessages.markDeleted('nc-000000000001', 'n-000000000002', 61);
      expect(
        await r.notificationChannelMessages.get('nc-000000000001', 'n-000000000002'),
      ).toMatchObject({
        deletedAt: 61,
        updatedAt: 61,
      });
      expect(await r.notificationChannelMessages.dueForDelete(100, 10)).toEqual([]);
    });

    it('removing a channel removes its deliveries and messages', async () => {
      await r.notificationDeliveries.enqueue([job()]);
      await r.notificationChannelMessages.upsert({
        channelId: 'nc-000000000001',
        notificationId: 'n-000000000001',
        thread: 't',
        messageRef: { id: 1 },
        lastRevision: 1,
        sentAt: 1,
        updatedAt: 1,
        expiresAt: null,
        deletedAt: null,
      });
      expect(await r.notificationChannels.remove('nc-000000000001')).toBe(true);
      expect(await r.notificationDeliveries.list({})).toEqual([]);
      expect(
        await r.notificationChannelMessages.get('nc-000000000001', 'n-000000000001'),
      ).toBeNull();
      expect(await r.notificationChannels.remove('nc-000000000001')).toBe(false);
    });
  });
}
