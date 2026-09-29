/** @module test/notifications/full-path.sqlite.test — the whole notification path through each real adapter on SQLite against the platform fakes (spec 09 §3.2, D-34, D-35): bus event → row and outbox job in one transaction → send → attention resolved → silent edit → TTL delete; secrets read through the registry and registered with the redactor. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { NotificationService } from '../../src/app/notifications/notification-service.ts';
import { NotificationOutbox } from '../../src/app/notifications/outbox.ts';
import { attentionCreated, attentionResolved } from '../../src/app/notifications/test-fixtures.ts';
import { channelFactories } from '../../src/infra/notifications/index.ts';
import type { NotificationChannelRecord } from '../../src/ports/persistence/records.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { FAKE_TG_TOKEN, FakePlatforms, type RecordedRequest } from '../helpers/fake-platforms.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { sessionRecord } from '../persistence/helpers.ts';
import { openMemory, type TestDb } from '../persistence/setup.ts';
import { PUBLIC_LINKS, platformRecord, SAMPLE_IMAGES } from './helpers.ts';

let t: TestDb;
let fakes: FakePlatforms;
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
  fakes = new FakePlatforms().start();
});
afterEach(async () => {
  await fakes.stop();
  await t.close();
});

const RULES = { content: 'full' as const, ttl_ms: { 'needs-you': 3_600_000 } };

async function wire(record: NotificationChannelRecord, env: Record<string, string>) {
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const registered: string[] = [];
  await t.repos.notificationChannels.upsert(record);
  const registry = new ChannelRegistry({
    repo: t.repos.notificationChannels,
    clock: t.clock,
    ids,
    logger,
    factories: channelFactories({
      images: SAMPLE_IMAGES,
      apiBases: { telegram: fakes.telegramBase },
    }),
    env: (name) => env[name],
    registerSecret: (value) => registered.push(value),
  });
  await registry.load();
  const outbox = new NotificationOutbox({
    uow: t.uow,
    repos: t.repos,
    registry,
    links: PUBLIC_LINKS,
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
  return { outbox, service, registry, registered };
}

async function lifecycle(w: Awaited<ReturnType<typeof wire>>): Promise<string[][]> {
  await w.service.produce(attentionCreated('a-000000000001', 'takeover', { reason: 'captcha' }));
  await w.outbox.tick();
  t.clock.advance(5_000);
  await w.service.produce(attentionResolved('a-000000000001', 'resolved'));
  await w.outbox.tick();
  t.clock.advance(3_600_000);
  await w.outbox.tick();
  const log = await t.repos.notificationDeliveries.list({});
  return log.map((d) => [d.op, String(d.revision), d.status, d.reason ?? '']);
}

const calls = (requests: readonly RecordedRequest[]) =>
  requests.map((r) => `${r.method} ${r.path}`);

describe('full notification path through the real adapters', () => {
  it('telegram: send, silent edit, TTL delete', async () => {
    const w = await wire(
      platformRecord('telegram', {
        target: { chat_id: '-100123' },
        secretRefs: { token: 'BH_TG_TOKEN' },
        rules: RULES,
      }),
      { BH_TG_TOKEN: FAKE_TG_TOKEN },
    );
    expect(w.registered).toContain(FAKE_TG_TOKEN);
    const log = await lifecycle(w);
    expect(calls(fakes.of('telegram'))).toEqual([
      'POST sendRichMessage',
      'POST editMessageText',
      'POST deleteMessage',
    ]);
    expect(log).toEqual([
      ['delete', '2', 'sent', ''],
      ['edit', '2', 'sent', ''],
      ['send', '1', 'sent', ''],
    ]);
    const edit = fakes.of('telegram')[1]?.json as {
      rich_message: { html: string };
      message_id: number;
    };
    expect(edit.message_id).toBe(101);
    expect(edit.rich_message.html).toContain('Resolved by local');
  });

  it('discord: send, edit, TTL delete', async () => {
    const w = await wire(
      platformRecord('discord', { secretRefs: { webhook: 'BH_DISCORD_WEBHOOK' }, rules: RULES }),
      { BH_DISCORD_WEBHOOK: fakes.discordWebhook },
    );
    const log = await lifecycle(w);
    expect(calls(fakes.of('discord'))).toEqual([
      'POST ',
      'PATCH messages/101',
      'DELETE messages/101',
    ]);
    expect(log.map((l) => l[2])).toEqual(['sent', 'sent', 'sent']);
  });

  it('ntfy: publish, replace by sequence id, delete', async () => {
    const w = await wire(
      platformRecord('ntfy', {
        target: { server: fakes.ntfyServer, topic: 'bh-alerts' },
        rules: RULES,
      }),
      {},
    );
    const log = await lifecycle(w);
    const requests = fakes.of('ntfy');
    expect(calls(requests)).toEqual([
      'POST /',
      'POST /',
      `DELETE /bh-alerts/${String((requests[0]?.json as { sequence_id: string } | undefined)?.sequence_id)}`,
    ]);
    expect((requests[1]?.json as { priority: number } | undefined)?.priority).toBe(2);
    expect(log.map((l) => l[2])).toEqual(['sent', 'sent', 'sent']);
    expect(fakes.ntfyTopic('bh-alerts').at(-1)?.['event']).toBe('message_delete');
  });

  it('webhook: posts both revisions; deletes are unsupported', async () => {
    const w = await wire(
      platformRecord('webhook', { target: { url: fakes.webhookUrl }, rules: RULES }),
      {},
    );
    const log = await lifecycle(w);
    expect(fakes.of('webhook').map((r) => (r.json as { op: string }).op)).toEqual(['send', 'edit']);
    expect(log).toEqual([
      ['delete', '2', 'suppressed', 'delete_unsupported'],
      ['edit', '2', 'sent', ''],
      ['send', '1', 'sent', ''],
    ]);
  });

  it('a missing variable leaves the channel without an adapter, and its jobs say why', async () => {
    const w = await wire(
      platformRecord('telegram', {
        target: { chat_id: '1' },
        secretRefs: { token: 'BH_TG_TOKEN' },
        rules: RULES,
      }),
      {},
    );
    expect(w.registry.channels()[0]?.adapter).toBeNull();
    await w.service.produce(attentionCreated('a-000000000001', 'takeover'));
    const [job] = await t.repos.notificationDeliveries.list({});
    expect([job?.status, job?.reason]).toEqual(['suppressed', 'no_adapter']);
  });
});
