/** @module app/notifications/redaction.property.test — the redaction invariant for notifications (spec 10 §9, D-32): a sentinel secret registered in the `SecretRegistry` and routed through every producer input never appears in the stored message, the in-app row or payload, the channel delivery, or the delivery log. Seeded generator, 1 000 cases. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createRedactor, SecretRegistry } from '../../kernel/redact.ts';
import { ChannelSendError } from '../../ports/notification-channel.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { ChannelRegistry } from './channel-registry.ts';
import { createLocalLinkBuilder } from './links.ts';
import { NotificationService } from './notification-service.ts';
import { NotificationOutbox } from './outbox.ts';
import type { ProducedEvent } from './producers.ts';
import {
  attentionCreated,
  attentionResolved,
  systemDegraded,
  toolCalled,
  vaultConfirmCreated,
} from './test-fixtures.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function sentinelOf(next: () => number): string {
  const length = 12 + Math.floor(next() * 20);
  let out = 'zq';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

/** Embeds `secret` in random filler text. */
function around(next: () => number, secret: string): string {
  const pad = (n: number) => 'lorem ipsum '.repeat(n).slice(0, n);
  return `${pad(Math.floor(next() * 40))}${secret}${pad(Math.floor(next() * 40))}`;
}

/** Every documented producer input that carries free text, with the sentinel routed into it. */
function events(next: () => number, secret: string): ProducedEvent[] {
  const path = next() < 0.5;
  const text = around(next, secret);
  const picks: ProducedEvent[][] = [
    [
      attentionCreated('a-000000000001', next() < 0.5 ? 'takeover' : 'notify', {
        reason: text,
        page_url: path ? `https://example.com/${secret}/login?q=${secret}` : 'https://example.com/',
        tool: path ? `tool-${secret}`.slice(0, 60) : null,
      }),
      attentionResolved('a-000000000001', 'resolved'),
    ],
    [vaultConfirmCreated('a-000000000002', text)],
    [toolCalled(1, { ok: false, code: text })],
    [
      (() => {
        const e = systemDegraded('error');
        if (e.name !== 'system.degraded') return e;
        return {
          ...e,
          payload: {
            ...e.payload,
            event: { ...e.payload.event, message: text, code: `C_${secret}` },
          },
        };
      })(),
    ],
    [
      {
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
          last_error: text,
          at: 1,
        },
      },
    ],
  ];
  return picks[Math.floor(next() * picks.length)] ?? [];
}

async function runCase(seed: number): Promise<{ leaks: string[]; rows: number; calls: number }> {
  const next = rng(seed);
  const secret = sentinelOf(next);
  const clock = new FakeClock();
  const registry = new SecretRegistry({ now: () => clock.now() });
  registry.add(secret);
  const redactor = createRedactor(registry);
  const repos = new InMemoryRepositories();
  const uow = new InMemoryUnitOfWork(repos);
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const fake = new FakeChannel();
  // Platform errors echo what they were sent; the delivery log must not keep the secret.
  if (next() < 0.5) fake.script(new ChannelSendError('rejected', `bad request near ${secret}`));
  await repos.notificationChannels.upsert(channelRecord({ rules: { content: 'full' } }));
  const channels = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    factories: new Map([['fake', () => fake]]),
  });
  await channels.load();
  const outbox = new NotificationOutbox({
    uow,
    repos,
    registry: channels,
    links: createLocalLinkBuilder(() => 'http://127.0.0.1:9876'),
    clock,
    logger,
    bus,
    redactor,
  });
  const service = new NotificationService({
    repo: repos.notifications,
    bus,
    clock,
    ids,
    logger,
    uow,
    outbox: { plan: (m, now) => outbox.plan(m, now), kick: () => undefined },
    redactor,
  });
  for (const event of events(next, secret)) await service.produce(event);
  await outbox.tick();
  const leaks: string[] = [];
  const check = (where: string, value: unknown) => {
    if (JSON.stringify(value).includes(secret)) leaks.push(`${where} (seed ${seed})`);
  };
  check('notification row', [...repos.notifications.rows.values()]);
  check(
    'in-app payload',
    bus.published.filter((p) => p.name.startsWith('notification.')),
  );
  check('channel delivery', fake.calls);
  check('delivery log', repos.notificationDeliveries.rows);
  check('channel row', [...repos.notificationChannels.rows.values()]);
  return { leaks, rows: repos.notifications.rows.size, calls: fake.calls.length };
}

describe('notification redaction invariant', () => {
  it('a registered sentinel never leaves through a notification (1 000 cases)', async () => {
    const leaks: string[] = [];
    let rows = 0;
    let calls = 0;
    for (let seed = 1; seed <= 1_000; seed++) {
      const result = await runCase(seed);
      leaks.push(...result.leaks);
      rows += result.rows;
      calls += result.calls;
    }
    expect(leaks).toEqual([]);
    // Not vacuous: notifications were stored and delivered in most cases.
    expect(rows).toBeGreaterThan(900);
    expect(calls).toBeGreaterThan(500);
  });
});
