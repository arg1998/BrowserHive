/** @module app/notifications/notification-service.test — producer rule table, de-dup, tool-error grouping, inbox API and events. */

import { describe, expect, it } from 'bun:test';
import { Notification } from '@browserhive/contracts/http';
import { NotificationMessage } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryNotificationRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { NotificationService } from './notification-service.ts';
import { draftFor, type ProducedEvent } from './producers.ts';
import {
  attentionCreated,
  attentionResolved,
  SESSION,
  sessionClosed,
  systemDegraded,
  systemRecovered,
  toolCalled,
  vaultConfirmCreated,
  vaultConfirmResolved,
} from './test-fixtures.ts';

function setup() {
  const clock = new FakeClock();
  const repo = new InMemoryNotificationRepository();
  const bus = new RecordingEventBus<DomainEvents>();
  const service = new NotificationService({
    repo,
    bus,
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
  });
  return { clock, repo, bus, service };
}

describe('producer rules', () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      ProducedEvent,
      {
        type: string;
        title: string;
        body: string | null;
        target: string | null;
        sessionId?: string;
      } | null,
    ]
  > = [
    [
      'attention with mode',
      attentionCreated('a-000000000001', 'takeover'),
      {
        type: 'attention',
        title: 'Attention requested',
        body: 'captcha · takeover — agent blocked, lease frozen',
        target: `/sessions/${SESSION}?live=1&takeover=1`,
      },
    ],
    [
      'attention without mode',
      attentionCreated('a-000000000002', null),
      {
        type: 'attention',
        title: 'Attention requested',
        body: 'captcha — agent blocked, lease frozen',
        target: `/sessions/${SESSION}?live=1`,
      },
    ],
    [
      'session crash',
      sessionClosed('crash'),
      {
        type: 'error',
        title: 'Session crashed',
        body: 'reason: crash',
        target: `/sessions/${SESSION}`,
      },
    ],
    [
      'lease expired',
      sessionClosed('lease_expired'),
      {
        type: 'lifecycle',
        title: 'Session reaped (lease expired)',
        body: 'reason: lease_expired',
        target: `/sessions/${SESSION}`,
      },
    ],
    ['clean user close is silent', sessionClosed('user'), null],
    ['shutdown close is silent', sessionClosed('shutdown'), null],
    ['successful tool is silent', toolCalled(1, { ok: true }), null],
    [
      'tool error with code',
      toolCalled(2, { ok: false }),
      {
        type: 'error',
        title: 'shop · 1 tool error',
        body: 'navigate · NAVIGATION_TIMEOUT (1200 ms)',
        target: `/sessions/${SESSION}?kinds=tool&errors_only=1`,
        sessionId: SESSION,
      },
    ],
    [
      'tool error without code',
      toolCalled(3, { ok: false, code: null }),
      {
        type: 'error',
        title: 'shop · 1 tool error',
        body: 'navigate · failed (1200 ms)',
        target: `/sessions/${SESSION}?kinds=tool&errors_only=1`,
        sessionId: SESSION,
      },
    ],
    [
      'caller mistake without a session is silent',
      toolCalled(4, { ok: false, code: 'INVALID_ARGUMENTS', sessionId: null }),
      null,
    ],
    [
      'other failure without a session is grouped under No session',
      toolCalled(5, {
        ok: false,
        tool: 'launch_session',
        code: 'BROWSER_NOT_INSTALLED',
        sessionId: null,
      }),
      {
        type: 'error',
        title: 'No session · 1 tool error',
        body: 'launch_session · BROWSER_NOT_INSTALLED (1200 ms)',
        target: null,
      },
    ],
    [
      'vault confirm',
      vaultConfirmCreated('a-000000000003', 'github'),
      {
        type: 'vault',
        title: 'Vault fill awaiting confirm',
        body: 'entry github — approve or deny the release',
        target: '/vault?tab=confirm',
      },
    ],
    [
      'error degradation',
      systemDegraded('error'),
      {
        type: 'system',
        title: 'retention sweep failed',
        body: 'RETENTION_FAILED',
        target: '/system',
      },
    ],
    ['warn degradation is silent', systemDegraded('warn'), null],
  ];
  for (const [name, event, expected] of cases) {
    it(name, () => {
      const draft = draftFor(event);
      if (expected === null) expect(draft).toBeNull();
      else expect(draft).toMatchObject(expected);
    });
  }
});

describe('NotificationService producers', () => {
  it('persists, publishes notification.created with a schema-valid DTO, and de-dups replays', async () => {
    const { repo, bus, service } = setup();
    service.start();
    const event = attentionCreated('a-000000000001', 'notify');
    bus.publish('attention.created', event.payload as DomainEvents['attention.created']);
    bus.publish('attention.created', event.payload as DomainEvents['attention.created']);
    await service.idle();
    expect(repo.rows.size).toBe(1);
    const created = bus.published.filter((p) => p.name === 'notification.created');
    expect(created).toHaveLength(1);
    const payload = created[0]?.payload as DomainEvents['notification.created'];
    expect(Notification.safeParse(payload.notification).success).toBe(true);
    service.stop();
  });

  it('folds tool errors into one row per session and publishes notification.updated', async () => {
    const { clock, repo, bus, service } = setup();
    const [first] = await service.produce(toolCalled(1, { ok: false }));
    await clock.advance(40_000);
    await service.produce(
      toolCalled(2, { ok: false, tool: 'click', code: 'ELEMENT_NOT_ACTIONABLE' }),
    );
    await clock.advance(40_000);
    const [third] = await service.produce(toolCalled(3, { ok: false, tool: 'scroll' }));
    await service.produce(toolCalled(4, { ok: false, sessionId: 'other-a1b2c3d4' }));
    await service.produce(toolCalled(5, { ok: false, code: 'INVALID_ARGUMENTS', sessionId: null }));
    expect(repo.rows.size).toBe(2);
    expect(third).toMatchObject({
      notification_id: first?.notification_id,
      title: 'shop · 3 tool errors',
      body: 'scroll · NAVIGATION_TIMEOUT (1200 ms)',
      session_id: SESSION,
      session_slug: 'shop',
      count: 3,
      created_at: first?.created_at,
      updated_at: (first?.created_at ?? 0) + 80_000,
      read_at: null,
    });
    expect(Notification.safeParse(third).success).toBe(true);
    expect(bus.names().filter((n) => n === 'notification.created')).toHaveLength(2);
    const updates = bus.published.filter((p) => p.name === 'notification.updated');
    expect(updates).toHaveLength(2);
    const last = updates[1]?.payload as DomainEvents['notification.updated'] | undefined;
    expect(last?.notification.count).toBe(3);
  });

  it('starts a new group row once the old one is read, dismissed, idle or old', async () => {
    const { clock, repo, service } = setup();
    const [a] = await service.produce(toolCalled(1, { ok: false }));
    if (a === undefined) throw new Error('no notification');
    await service.markRead(a.notification_id);
    const [b] = await service.produce(toolCalled(2, { ok: false }));
    expect(b?.notification_id).not.toBe(a.notification_id);
    if (b === undefined) throw new Error('no notification');
    await service.dismiss(b.notification_id);
    const [c] = await service.produce(toolCalled(3, { ok: false }));
    expect(c?.count).toBe(1);
    await clock.advance(5 * 60_000);
    const [d] = await service.produce(toolCalled(4, { ok: false }));
    expect(d?.notification_id).not.toBe(c?.notification_id);
    for (let i = 0; i < 16; i++) {
      await clock.advance(4 * 60_000);
      await service.produce(toolCalled(10 + i, { ok: false }));
    }
    // The group closes 60 min after d was created, so the failure at +60 min starts a new row.
    const rows = [...repo.rows.values()].sort((x, y) => x.createdAt - y.createdAt);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1, 15, 2]);
  });

  it('fans out to every recipient inbox', async () => {
    const { repo, bus, clock } = setup();
    const service = new NotificationService({
      repo,
      bus,
      clock,
      ids: new FakeIdGenerator(),
      logger: new CollectingLogger(),
      recipients: () => ['p-000000000001', 'p-000000000002'],
    });
    const created = await service.produce(sessionClosed('crash'));
    expect(created.map((n) => n.principal_id)).toEqual(['p-000000000001', 'p-000000000002']);
  });
});

describe('NotificationService inbox', () => {
  it('unread count, markRead, markAllRead, dismiss, dismissAll publish state events', async () => {
    const { bus, service } = setup();
    const [a] = await service.produce(sessionClosed('crash', 1));
    await service.produce(sessionClosed('crash', 2));
    await service.produce(sessionClosed('crash', 3));
    expect(await service.unreadCount(null)).toBe(3);
    if (a === undefined) throw new Error('no notification');

    const read = await service.markRead(a.notification_id);
    expect(read?.read_at).not.toBeNull();
    expect(await service.unreadCount(null)).toBe(2);
    expect(bus.names().filter((n) => n === 'notification.read')).toHaveLength(1);
    expect(await service.markRead('n-unknown00000')).toBeNull();

    expect(await service.markAllRead(null)).toBe(2);
    expect(await service.unreadCount(null)).toBe(0);
    expect(bus.names().filter((n) => n === 'notification.read')).toHaveLength(3);

    const dismissed = await service.dismiss(a.notification_id);
    expect(dismissed?.dismissed_at).not.toBeNull();
    expect(await service.dismissAll(null)).toBe(2);
    expect(bus.names().filter((n) => n === 'notification.dismissed')).toHaveLength(3);
    expect(bus.names().filter((n) => n === 'notification.updated')).toHaveLength(6);

    const page = await service.list({ read: 'read' });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((n) => Notification.safeParse(n).success)).toBe(true);
  });
});

describe('NotificationService contract and revisions', () => {
  it('stores the first revision of the message with the row and serves the classification', async () => {
    const { repo, service } = setup();
    const [dto] = await service.produce(attentionCreated('a-000000000001', 'takeover'));
    expect(dto).toMatchObject({
      kind: 'attention.requested',
      category: 'needs-you',
      severity: 'warn',
      state: 'open',
      revision: 1,
      thread: 'attention:a-000000000001',
    });
    const row = repo.rows.get(dto?.notification_id ?? '');
    const message = NotificationMessage.parse(JSON.parse(row?.messageJson ?? 'null'));
    expect(message).toMatchObject({
      id: dto?.notification_id,
      revision: 1,
      alert: true,
      title: dto?.title,
    });
    expect(message.summary).toBe(dto?.body ?? '');
  });

  it('revises the request notification when it resolves; title, body and updated_at stay', async () => {
    const { clock, repo, bus, service } = setup();
    const [created] = await service.produce(attentionCreated('a-000000000001', 'takeover'));
    await clock.advance(130_000);
    const [revised] = await service.produce(attentionResolved('a-000000000001', 'resolved'));
    expect(revised).toMatchObject({
      notification_id: created?.notification_id,
      state: 'resolved',
      revision: 2,
      title: created?.title,
      body: created?.body,
      updated_at: created?.updated_at,
    });
    const message = NotificationMessage.parse(
      JSON.parse(repo.rows.get(created?.notification_id ?? '')?.messageJson ?? 'null'),
    );
    expect(message).toMatchObject({ revision: 2, state: 'resolved', alert: false, actions: [] });
    const updates = bus.published.filter((p) => p.name === 'notification.updated');
    expect(updates).toHaveLength(1);
    // A replayed resolution and a later terminal status change nothing.
    expect(await service.produce(attentionResolved('a-000000000001', 'resolved'))).toEqual([]);
    expect(await service.produce(attentionResolved('a-000000000001', 'timeout'))).toEqual([]);
  });

  it('revises vault confirmations and recovered degradations', async () => {
    const { service } = setup();
    await service.produce(vaultConfirmCreated('a-000000000003', 'github'));
    const [vault] = await service.produce(vaultConfirmResolved('a-000000000003', 'rejected'));
    expect(vault).toMatchObject({ kind: 'vault.confirm', state: 'resolved', revision: 2 });
    await service.produce(systemDegraded('error'));
    const [system] = await service.produce(systemRecovered());
    expect(system).toMatchObject({ kind: 'system.degraded', state: 'resolved', revision: 2 });
  });

  it('a resolution without a notification (or of a row from before v5) fabricates nothing', async () => {
    const { repo, service } = setup();
    expect(await service.produce(attentionResolved('a-000000000009', 'resolved'))).toEqual([]);
    await repo.insert({
      notificationId: 'n-legacy000001',
      principalId: null,
      type: 'attention',
      title: 'Attention requested',
      body: null,
      sessionId: SESSION,
      target: null,
      sourceEventId: 'a-000000000008',
      createdAt: 1,
      updatedAt: 1,
      count: 1,
      groupKey: null,
      readAt: null,
      dismissedAt: null,
      kind: 'attention.requested',
      category: 'needs-you',
      severity: 'warn',
      state: 'open',
      revision: 1,
      thread: 'attention:a-000000000008',
      messageJson: null,
    });
    const [legacy] = await service.produce(attentionResolved('a-000000000008', 'timeout'));
    expect(legacy).toMatchObject({ state: 'expired', revision: 2 });
    expect(repo.rows.get('n-legacy000001')?.messageJson).toBeNull();
  });

  it('grows a tool-error group as silent revisions of one message', async () => {
    const { clock, repo, service } = setup();
    const [a] = await service.produce(toolCalled(1, { ok: false }));
    await clock.advance(1_000);
    const [b] = await service.produce(toolCalled(2, { ok: false }));
    expect(b).toMatchObject({ notification_id: a?.notification_id, revision: 2, count: 2 });
    const message = NotificationMessage.parse(
      JSON.parse(repo.rows.get(a?.notification_id ?? '')?.messageJson ?? 'null'),
    );
    expect(message).toMatchObject({ revision: 2, alert: false, title: 'shop · 2 tool errors' });
  });

  it('the breaker notice is an in-app system notification', async () => {
    const { service } = setup();
    const [notice] = await service.produce({
      name: 'notification.channel.changed',
      at: 1,
      payload: {
        type: 'notification.channel.changed',
        channel_id: 'nc-1',
        name: 'phone',
        kind: 'telegram',
        status: 'broken',
        previous_status: 'active',
        failure_count: 5,
        last_error: 'unavailable: down',
        at: 1,
      },
    });
    expect(notice).toMatchObject({ type: 'system', kind: 'channel.broken', severity: 'error' });
  });
});

describe('NotificationService startup catch-up', () => {
  it('revises notifications of requests settled while nothing listened', async () => {
    const { repo, service } = setup();
    const [attention] = await service.produce(attentionCreated('a-000000000001', 'takeover'));
    const [vault] = await service.produce(vaultConfirmCreated('a-000000000002', 'github'));
    await service.produce(attentionCreated('a-000000000003', 'notify'));
    const settled = new Map([
      [
        'a-000000000001',
        {
          status: 'rejected' as const,
          resolvedBy: 'system',
          createdAt: 1,
          resolvedAt: 61_001,
          waitedMs: 61_000,
        },
      ],
      [
        'a-000000000002',
        { status: 'timeout' as const, resolvedBy: null, createdAt: 1, resolvedAt: 5, waitedMs: 4 },
      ],
      [
        'a-000000000003',
        {
          status: 'pending' as const,
          resolvedBy: null,
          createdAt: 1,
          resolvedAt: null,
          waitedMs: null,
        },
      ],
    ]);
    expect(await service.reconcileRequests({ get: async (id) => settled.get(id) ?? null })).toBe(2);
    expect(repo.rows.get(attention?.notification_id ?? '')).toMatchObject({
      state: 'resolved',
      revision: 2,
    });
    expect(repo.rows.get(vault?.notification_id ?? '')).toMatchObject({
      state: 'expired',
      revision: 2,
    });
    // Already settled rows are left alone on the next start.
    expect(await service.reconcileRequests({ get: async (id) => settled.get(id) ?? null })).toBe(0);
  });
});

describe('screenshots (D-36)', () => {
  function shotSetup(options: {
    readonly enabled?: boolean;
    readonly variants?: { masked: boolean; unmasked: boolean };
    readonly slow?: boolean;
  }) {
    const repo = new InMemoryNotificationRepository();
    const calls: string[] = [];
    const service = new NotificationService({
      repo,
      bus: new RecordingEventBus<DomainEvents>(),
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: new CollectingLogger(),
      screenshots: {
        enabled: options.enabled ?? true,
        timeoutMs: 20,
        variants: () => options.variants ?? { masked: true, unmasked: true },
        snapshots: {
          capture: async (sessionId, { masked }) => {
            calls.push(`capture:${sessionId}:${masked ? 'masked' : 'plain'}`);
            if (options.slow === true) await new Promise((r) => setTimeout(r, 200));
            return { ref: masked ? 'nimg-mask' : 'nimg-plain', capturedAt: 7 };
          },
          lastFrame: async (sessionId) => {
            calls.push(`last:${sessionId}`);
            return { ref: 'nimg-last', capturedAt: 3 };
          },
        },
      },
    });
    const images = (id: string) => {
      const message = NotificationMessage.parse(JSON.parse(repo.rows.get(id)?.messageJson ?? '{}'));
      return message.blocks.flatMap((b) => (b.type === 'image' ? [[b.ref, b.masked]] : []));
    };
    return { service, calls, images };
  }

  it('captures the variants the channels want for an attention request', async () => {
    const { service, calls, images } = shotSetup({});
    const [dto] = await service.produce(attentionCreated('a-000000000001', 'takeover'));
    expect(calls).toEqual([`capture:${SESSION}:plain`, `capture:${SESSION}:masked`]);
    expect(images(dto?.notification_id ?? '')).toEqual([
      ['nimg-plain', false],
      ['nimg-mask', true],
    ]);
  });

  it('uses the last stored frame for a crash, never masked', async () => {
    const { service, calls, images } = shotSetup({ variants: { masked: true, unmasked: false } });
    const [dto] = await service.produce(sessionClosed('crash'));
    expect(calls).toEqual([`last:${SESSION}`]);
    expect(images(dto?.notification_id ?? '')).toEqual([['nimg-last', false]]);
  });

  it('captures nothing when no channel wants it, when disabled, or when it times out', async () => {
    const none = shotSetup({ variants: { masked: false, unmasked: false } });
    await none.service.produce(attentionCreated('a-000000000001', 'notify'));
    expect(none.calls).toEqual([]);
    const off = shotSetup({ enabled: false });
    await off.service.produce(vaultConfirmCreated('a-000000000009', 'github'));
    expect(off.calls).toEqual([]);
    const slow = shotSetup({ slow: true, variants: { masked: false, unmasked: true } });
    const [dto] = await slow.service.produce(attentionCreated('a-000000000002', 'notify'));
    expect(slow.images(dto?.notification_id ?? '')).toEqual([]);
  });
});
