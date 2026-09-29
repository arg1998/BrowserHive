/** @module test/persistence/conformance-actions.test — one suite over the SQLite act-button repositories and their in-memory doubles (tokens: insert, get, single claim, prune, channel cascade; the press audit: insert, filters, keyset, prune; the listener cursors), so the doubles the app tests use behave like the real thing (spec 09, D-41). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  NewNotificationAction,
  NotificationActionTokenRecord,
  NotificationRecord,
} from '../../src/ports/persistence/records.ts';
import type { Repositories } from '../../src/ports/persistence/unit-of-work.ts';
import { channelRecord } from '../helpers/fake-channel.ts';
import { InMemoryRepositories } from '../helpers/in-memory-repos.ts';
import { openMemory, type TestDb } from './setup.ts';

type Repos = Pick<
  Repositories,
  | 'notifications'
  | 'notificationChannels'
  | 'notificationActionTokens'
  | 'notificationActions'
  | 'notificationCursors'
>;

function notification(): NotificationRecord {
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
  };
}

function token(
  overrides: Partial<NotificationActionTokenRecord> = {},
): NotificationActionTokenRecord {
  return {
    tokenHash: 'a'.repeat(64),
    channelId: 'nc-000000000001',
    notificationId: 'n-000000000001',
    actionId: 'resolve',
    op: 'attention.resolve',
    args: { request_id: 'a-000000000001', decision: 'resolve', urgent: true, n: 2 },
    createdAt: 100,
    expiresAt: 1_000,
    usedAt: null,
    ...overrides,
  };
}

function press(overrides: Partial<NewNotificationAction> = {}): NewNotificationAction {
  return {
    at: 200,
    channelId: 'nc-000000000001',
    channelName: 'phone',
    channelKind: 'telegram',
    notificationId: 'n-000000000001',
    actionId: 'resolve',
    actionLabel: 'Mark resolved',
    op: 'attention.resolve',
    args: { request_id: 'a-000000000001', decision: 'resolve' },
    actor: 'telegram:42',
    actorName: 'Someone',
    outcome: 'done',
    detail: 'Marked resolved.',
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
      return { repos: t.repos, close: () => t.close() };
    },
  ],
  ['in-memory', async () => ({ repos: new InMemoryRepositories(), close: async () => undefined })],
];

for (const [name, open] of adapters) {
  describe(`act-button repositories (${name})`, () => {
    let r: Repos;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const opened = await open();
      r = opened.repos;
      close = opened.close;
      await r.notifications.insert(notification());
      await r.notificationChannels.upsert(
        channelRecord({ channelId: 'nc-000000000001', name: 'phone', kind: 'telegram' }),
      );
    });
    afterEach(async () => {
      await close();
    });

    it('stores a token by its hash and returns it with its args', async () => {
      await r.notificationActionTokens.insert([token(), token({ tokenHash: 'b'.repeat(64) })]);
      expect(await r.notificationActionTokens.get('a'.repeat(64))).toEqual(token());
      expect(await r.notificationActionTokens.get('c'.repeat(64))).toBeNull();
    });

    it('claims a token once', async () => {
      await r.notificationActionTokens.insert([token()]);
      expect(await r.notificationActionTokens.claim('a'.repeat(64), 300)).toBe(true);
      expect(await r.notificationActionTokens.claim('a'.repeat(64), 301)).toBe(false);
      expect((await r.notificationActionTokens.get('a'.repeat(64)))?.usedAt).toBe(300);
      expect(await r.notificationActionTokens.claim('c'.repeat(64), 302)).toBe(false);
    });

    it('prunes expired tokens and loses them with their channel', async () => {
      await r.notificationActionTokens.insert([
        token(),
        token({ tokenHash: 'b'.repeat(64), expiresAt: 5_000 }),
      ]);
      expect(await r.notificationActionTokens.prune(2_000)).toBe(1);
      expect(await r.notificationActionTokens.get('a'.repeat(64))).toBeNull();
      await r.notificationChannels.remove('nc-000000000001');
      expect(await r.notificationActionTokens.get('b'.repeat(64))).toBeNull();
    });

    it('audits presses newest first with filters and a keyset', async () => {
      const first = await r.notificationActions.insert(press());
      const second = await r.notificationActions.insert(
        press({ at: 210, outcome: 'not_allowed', actor: 'telegram:7', actorName: null }),
      );
      const third = await r.notificationActions.insert(
        press({ at: 220, channelId: 'nc-000000000002', channelName: 'team', notificationId: null }),
      );
      expect(second.seq).toBeGreaterThan(first.seq);
      expect((await r.notificationActions.list({})).map((a) => a.seq)).toEqual([
        third.seq,
        second.seq,
        first.seq,
      ]);
      expect(
        (await r.notificationActions.list({ channelId: 'nc-000000000001' })).map((a) => a.seq),
      ).toEqual([second.seq, first.seq]);
      expect(
        (await r.notificationActions.list({ outcomes: ['not_allowed'] })).map((a) => a.actor),
      ).toEqual(['telegram:7']);
      expect(
        (await r.notificationActions.list({ beforeSeq: second.seq, limit: 5 })).map((a) => a.seq),
      ).toEqual([first.seq]);
      expect((await r.notificationActions.list({ notificationId: 'n-000000000001' })).length).toBe(
        2,
      );
      expect(await r.notificationActions.get(first.seq)).toEqual({ ...press(), seq: first.seq });
      // The audit outlives its channel (no foreign key).
      await r.notificationChannels.remove('nc-000000000001');
      expect((await r.notificationActions.list({})).length).toBe(3);
      expect(await r.notificationActions.prune(215)).toBe(2);
    });

    it('keeps one cursor per key', async () => {
      expect(await r.notificationCursors.get('telegram:1')).toBeNull();
      await r.notificationCursors.set('telegram:1', '10', 1);
      await r.notificationCursors.set('telegram:1', '11', 2);
      expect(await r.notificationCursors.get('telegram:1')).toBe('11');
      await r.notificationCursors.remove('telegram:1');
      expect(await r.notificationCursors.get('telegram:1')).toBeNull();
    });
  });
}
