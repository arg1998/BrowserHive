/** @module app/notifications/notification-service.test — producer rule table, de-dup, tool-error grouping, inbox API and events. */

import { describe, expect, it } from 'bun:test';
import { Notification } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryNotificationRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { NotificationChannel } from '../../ports/notification-channel.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { NotificationService } from './notification-service.ts';
import { draftFor, type ProducedEvent } from './producers.ts';
import {
  attentionCreated,
  SESSION,
  sessionClosed,
  systemDegraded,
  toolCalled,
  vaultConfirmCreated,
} from './test-fixtures.ts';

function setup(channels: NotificationChannel[] = []) {
  const clock = new FakeClock();
  const repo = new InMemoryNotificationRepository();
  const bus = new RecordingEventBus<DomainEvents>();
  const service = new NotificationService({
    repo,
    bus,
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
    channels,
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

  it('isolates a failing external channel', async () => {
    const sent: string[] = [];
    const { repo, service } = setup([
      { name: 'broken', send: () => Promise.reject(new Error('down')) },
      { name: 'ok', send: (n) => void sent.push(n.title) },
    ]);
    await service.produce(sessionClosed('crash'));
    expect(repo.rows.size).toBe(1);
    expect(sent).toEqual(['Session crashed']);
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
