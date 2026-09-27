/** @module test/persistence/notification-outbox.sqlite.test — the full notification path on real SQLite with a fake platform (D-34, D-35): bus event → row + outbox job in one transaction → send → lifecycle revision → edit → TTL delete; and the breaker without a degradation. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { createLocalLinkBuilder } from '../../src/app/notifications/links.ts';
import { NotificationService } from '../../src/app/notifications/notification-service.ts';
import { NotificationOutbox } from '../../src/app/notifications/outbox.ts';
import { attentionCreated, attentionResolved } from '../../src/app/notifications/test-fixtures.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { channelRecord, FakeChannel } from '../helpers/fake-channel.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { sessionRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
});
afterEach(async () => {
  await t.close();
});

async function wire(rules = {}) {
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const fake = new FakeChannel();
  await t.repos.notificationChannels.upsert(channelRecord({ rules }));
  const registry = new ChannelRegistry({
    repo: t.repos.notificationChannels,
    clock: t.clock,
    ids,
    logger,
    factories: new Map([['fake', () => fake]]),
  });
  await registry.load();
  const outbox = new NotificationOutbox({
    uow: t.uow,
    repos: t.repos,
    registry,
    links: createLocalLinkBuilder(() => 'http://127.0.0.1:9876'),
    clock: t.clock,
    logger,
    bus,
  });
  const service = new NotificationService({
    repo: t.repos.notifications,
    bus,
    clock: t.clock,
    ids,
    logger,
    uow: t.uow,
    outbox: { plan: (m, now) => outbox.plan(m, now), kick: () => undefined },
  });
  return { bus, fake, outbox, service };
}

describe('notification outbox on SQLite', () => {
  it('sends, edits on resolution and deletes when the TTL is due', async () => {
    const w = await wire({ ttl_ms: { 'needs-you': 3_600_000 } });
    await w.service.produce(attentionCreated('a-000000000001', 'takeover'));
    const [job] = await t.repos.notificationDeliveries.list({});
    expect(job).toMatchObject({ op: 'send', status: 'pending', revision: 1 });
    await w.outbox.tick();
    t.clock.advance(5_000);
    await w.service.produce(attentionResolved('a-000000000001', 'resolved'));
    await w.outbox.tick();
    t.clock.advance(3_600_000);
    await w.outbox.tick();
    expect(w.fake.calls.map((c) => c.op)).toEqual(['send', 'edit', 'delete']);
    const log = await t.repos.notificationDeliveries.list({});
    expect(log.map((d) => [d.op, d.revision, d.status])).toEqual([
      ['delete', 2, 'sent'],
      ['edit', 2, 'sent'],
      ['send', 1, 'sent'],
    ]);
    const row = t.handle.raw
      .query<{ last_revision: number; deleted_at: number | null }, []>(
        'SELECT last_revision, deleted_at FROM notification_channel_messages',
      )
      .get();
    expect(row?.last_revision).toBe(2);
    expect(row?.deleted_at).not.toBeNull();
  });

  it('opens the breaker without raising a degradation', async () => {
    const w = await wire();
    w.fake.script(...Array.from({ length: 5 }, () => new Error('down')));
    await w.service.produce(attentionCreated('a-000000000001', 'takeover'));
    for (let i = 0; i < 5; i++) {
      await w.outbox.tick();
      t.clock.advance(20 * 60_000);
    }
    expect((await t.repos.notificationChannels.get('nc-000000000001'))?.status).toBe('broken');
    expect(w.bus.names()).not.toContain('system.degraded');
    const events = t.handle.raw.query('SELECT COUNT(*) AS n FROM system_events').get();
    expect(events).toEqual({ n: 0 });
  });
});
