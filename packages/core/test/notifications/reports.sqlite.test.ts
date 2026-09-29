/** @module test/notifications/reports.sqlite.test — scheduled reports end to end on SQLite through each real adapter against the platform fakes (spec 03 §9.7, D-43, D-44): recorded activity → the report facts → the anomaly alert (send, then the silent "back to normal" edit) and the daily digest (send) → the platform requests; an empty day is logged `suppressed: empty` and never reaches the platform. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { NotificationOutbox } from '../../src/app/notifications/outbox.ts';
import { createReportFacts } from '../../src/app/notifications/report-facts.ts';
import { ReportScheduler } from '../../src/app/notifications/report-scheduler.ts';
import { channelFactories } from '../../src/infra/notifications/index.ts';
import type { NotificationChannelRecord } from '../../src/ports/persistence/records.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { FAKE_TG_TOKEN, FakePlatforms, type RecordedRequest } from '../helpers/fake-platforms.ts';
import { sessionRecord, toolCallRecord } from '../persistence/helpers.ts';
import { openMemory, type TestDb } from '../persistence/setup.ts';
import { PUBLIC_LINKS, platformRecord, SAMPLE_IMAGES } from './helpers.ts';

const HOUR = 3_600_000;
/** 28 Sep 2026 12:00 UTC. */
const START = Date.UTC(2026, 8, 28, 12);
/** The digest time on 29 Sep (09:00 UTC). */
const NINE = Date.UTC(2026, 8, 29, 9);

let t: TestDb;
let fakes: FakePlatforms;
beforeEach(async () => {
  t = await openMemory();
  t.clock.set(START);
  fakes = new FakePlatforms().start();
});
afterEach(async () => {
  await fakes.stop();
  await t.close();
});

const RULES = {
  time_zone: 'UTC',
  digest: { every: 'day' as const, at: '09:00' },
  anomaly: { error_rate: 20, min_calls: 10 },
};

/** A busy, failing hour before START (the anomaly) inside the digest window. */
async function activity(): Promise<void> {
  await t.repos.sessions.insert(sessionRecord({ createdAt: START - 2 * HOUR }));
  for (let i = 0; i < 20; i++) {
    await t.repos.toolCalls.insert(
      toolCallRecord({
        eventId: `e-${i}`,
        seq: i + 1,
        ts: START - 30 * 60_000 + i * 1000,
        tool: i % 2 === 0 ? 'navigate' : 'click',
        durationMs: 100 + i * 50,
        ...(i % 2 === 0 && { ok: false, errorCode: 'NAVIGATION_TIMEOUT', errorMessage: 'slow' }),
      }),
    );
  }
}

async function wire(record: NotificationChannelRecord, env: Record<string, string>) {
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  await t.repos.notificationChannels.upsert({ ...record, rules: { ...record.rules, ...RULES } });
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
  });
  await registry.load();
  const outbox = new NotificationOutbox({
    uow: t.uow,
    repos: t.repos,
    registry,
    links: PUBLIC_LINKS,
    clock: t.clock,
    logger,
  });
  const reports = new ReportScheduler({
    registry,
    facts: createReportFacts({
      analytics: t.analytics,
      repos: t.repos,
      capacity: () => ({ live: 1, max: 10 }),
    }),
    uow: t.uow,
    repos: t.repos,
    outbox: { plan: (m, now, to) => outbox.plan(m, now, to), kick: () => undefined },
    clock: t.clock,
    ids,
    logger,
    hostZone: () => 'UTC',
  });
  return { outbox, reports };
}

async function episode(w: Awaited<ReturnType<typeof wire>>): Promise<string[][]> {
  await w.reports.tick(); // the anomaly check fires; the digest schedule arms
  await w.outbox.tick();
  t.clock.set(NINE + 30_000); // the next morning: the failures are out of the last hour
  await w.reports.tick(); // the digest, and the anomaly back to normal
  await w.outbox.tick();
  t.clock.advance(5_000);
  await w.outbox.tick();
  const log = await t.repos.notificationDeliveries.list({});
  return log.reverse().map((d) => [d.op, String(d.revision), d.status, d.reason ?? '']);
}

const calls = (requests: readonly RecordedRequest[]) =>
  requests.map((r) => `${r.method} ${r.path}`);
const EPISODE = [
  ['send', '1', 'sent', ''], // anomaly alert
  ['send', '1', 'sent', ''], // digest
  ['edit', '2', 'sent', ''], // back to normal
];

describe('scheduled reports through the real adapters', () => {
  it('telegram: an anomaly alert with its table, the digest, then back to normal', async () => {
    await activity();
    const w = await wire(
      platformRecord('telegram', {
        target: { chat_id: '-100123' },
        secretRefs: { token: 'BH_TG_TOKEN' },
      }),
      { BH_TG_TOKEN: FAKE_TG_TOKEN },
    );
    expect(await episode(w)).toEqual(EPISODE);
    expect(calls(fakes.of('telegram'))).toEqual([
      'POST sendRichMessage',
      'POST sendRichMessage',
      'POST editMessageText',
    ]);
    const [alert, digest, normal] = fakes
      .of('telegram')
      .map((r) => r.json as { rich_message: { html: string }; disable_notification: boolean });
    expect(alert?.rich_message.html).toContain('Something looks off');
    expect(alert?.rich_message.html).toContain('<table bordered striped compact>');
    expect(digest?.rich_message.html).toContain('Daily digest · Tue 29 Sep');
    expect(digest?.rich_message.html).toContain('NAVIGATION_TIMEOUT');
    expect(normal?.rich_message.html).toContain('Back to normal');
  });

  it('discord: the same episode as embeds', async () => {
    await activity();
    const w = await wire(
      platformRecord('discord', { secretRefs: { webhook: 'BH_DISCORD_WEBHOOK' } }),
      {
        BH_DISCORD_WEBHOOK: fakes.discordWebhook,
      },
    );
    expect(await episode(w)).toEqual(EPISODE);
    expect(calls(fakes.of('discord'))).toEqual(['POST ', 'POST ', 'PATCH messages/101']);
    const digest = fakes.of('discord')[1]?.json as {
      embeds: { title: string; description: string }[];
    };
    expect(digest.embeds[0]?.title).toContain('Daily digest');
    expect(digest.embeds[0]?.description).toContain('Tool calls per hour');
  });

  it('ntfy: the same episode as plain notifications, replaced by sequence id', async () => {
    await activity();
    const w = await wire(
      platformRecord('ntfy', { target: { server: fakes.ntfyServer, topic: 'bh-reports' } }),
      {},
    );
    expect(await episode(w)).toEqual(EPISODE);
    const bodies = fakes.of('ntfy').map((r) => r.json as { title: string; sequence_id: string });
    expect(bodies.map((b) => b.title)).toEqual([
      'Something looks off: 50% of tool calls failed in the last hour',
      'Daily digest · Tue 29 Sep',
      'Back to normal',
    ]);
    expect(bodies[2]?.sequence_id).toBe(bodies[0]?.sequence_id);
  });

  it('webhook: the contract with the report window and the chart as data', async () => {
    await activity();
    const w = await wire(platformRecord('webhook', { target: { url: fakes.webhookUrl } }), {});
    expect(await episode(w)).toEqual(EPISODE);
    const digest = fakes.of('webhook')[1]?.json as {
      message: {
        kind: string;
        report: { window: { since: number; until: number } };
        blocks: { type: string }[];
      };
    };
    expect(digest.message.kind).toBe('digest.daily');
    expect(digest.message.report.window).toEqual({ since: NINE - 24 * HOUR, until: NINE });
    expect(digest.message.blocks.some((b) => b.type === 'chart')).toBe(true);
  });

  it('an empty day is logged suppressed: empty and never reaches the platform', async () => {
    const w = await wire(platformRecord('webhook', { target: { url: fakes.webhookUrl } }), {});
    await w.reports.tick();
    t.clock.set(NINE + 30_000);
    await w.reports.tick();
    await w.outbox.tick();
    const log = await t.repos.notificationDeliveries.list({});
    expect(log.map((d) => [d.status, d.reason])).toEqual([['suppressed', 'empty']]);
    expect(fakes.of('webhook')).toHaveLength(0);
  });
});
