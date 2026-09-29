/** @module test/notifications/report-redaction.property.test — the redaction invariant over scheduled reports (spec 10 §9, D-43, D-44): a sentinel registered in the `SecretRegistry` and planted in every string a digest or an anomaly alert copies from the database (error codes, tool names, blocklist patterns and domains, harness slugs, degradation codes and messages, session slugs) never appears in the stored message, the delivery rows, or any renderer's request at any content level. Seeded, 120 cases. */

import { describe, expect, it } from 'bun:test';
import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { degrade } from '../../src/app/notifications/degrade.ts';
import { decodeMessage } from '../../src/app/notifications/message.ts';
import { ReportScheduler } from '../../src/app/notifications/report-scheduler.ts';
import type { AnomalyFacts, DigestFacts } from '../../src/app/notifications/reports.ts';
import { planDeliveries } from '../../src/app/notifications/routing.ts';
import { sampleAnomalyFacts, sampleDigestFacts } from '../../src/app/notifications/samples.ts';
import { CHANNEL_RENDERERS } from '../../src/infra/notifications/index.ts';
import { createRedactor, SecretRegistry } from '../../src/kernel/redact.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../helpers/fake-channel.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { PUBLIC_LINKS } from './helpers.ts';

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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function sentinelOf(next: () => number): string {
  let out = 'zq';
  const length = 12 + Math.floor(next() * 12);
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

function digestFacts(until: number, secret: string): DigestFacts {
  const base = sampleDigestFacts(until, { every: 'day', at: '09:00' });
  return {
    ...base,
    blocked: {
      count: 3,
      topPattern: { pattern: `*.${secret}.example`, count: 2 },
      topDomain: { domain: `${secret}.example.net`, count: 2 },
    },
    slowest: { tool: `tool_${secret}`, p95Ms: 1200, previousP95Ms: 900 },
    topErrors: [{ errorCode: `E_${secret}`, tool: `t_${secret}`, count: 3, sessions: 1 }],
    degradations: [
      {
        code: `D_${secret}`,
        severity: 'error',
        message: `failed at ${secret} now`,
        since: until - 60_000,
      },
    ],
    harnesses: [{ harness: `h-${secret}`.slice(0, 32), sessions: 1, toolCalls: 3, errors: 1 }],
  };
}

function anomalyFacts(now: number, secret: string): AnomalyFacts {
  return {
    ...sampleAnomalyFacts(now),
    attentionWaiting: [{ sessionSlug: `s-${secret}`, waitedMs: 60 * 60_000 }],
    degradations: [{ code: `D_${secret}`, message: `failed at ${secret}`, since: now - 60_000 }],
  };
}

const LEVELS: readonly NotificationContentLevel[] = ['counts', 'titles', 'full'];

describe('report redaction invariant', () => {
  it('a registered sentinel never reaches a stored report, a delivery row or a renderer (120 cases)', async () => {
    const leaks: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const next = rng(seed);
      const secret = sentinelOf(next);
      const level = LEVELS[seed % LEVELS.length] ?? 'full';
      const clock = new FakeClock(Date.UTC(2026, 8, 29, 7, 30));
      const secrets = new SecretRegistry({ now: () => clock.now() });
      secrets.add(secret);
      const redactor = createRedactor(secrets);
      const repos = new InMemoryRepositories();
      const ids = new FakeIdGenerator();
      const logger = new CollectingLogger();
      const channelId = 'nc-000000000001';
      await repos.notificationChannels.upsert(
        channelRecord({
          rules: { content: level, anomaly: {}, digest: { every: 'day', at: '09:00' } },
        }),
      );
      const registry = new ChannelRegistry({
        repo: repos.notificationChannels,
        clock,
        ids,
        logger,
        factories: new Map([['fake', () => new FakeChannel(channelId, capabilities())]]),
      });
      await registry.load();
      const scheduler = new ReportScheduler({
        registry,
        facts: {
          digest: async (w) => digestFacts(w.until, secret),
          anomaly: async (now) => anomalyFacts(now, secret),
        },
        uow: new InMemoryUnitOfWork(repos),
        repos,
        outbox: {
          plan: (m, now, to) => planDeliveries(m, registry.channels(), now, to),
          kick: () => undefined,
        },
        clock,
        ids,
        logger,
        hostZone: () => 'UTC',
        redactor,
      });
      const record = registry.get(channelId)?.record;
      if (record === undefined) throw new Error('no channel');
      await scheduler.tick(); // the anomaly check fires; the digest arms
      const manual = await scheduler.manualDigest(record);
      const messages = [
        manual.message,
        ...[...repos.notifications.rows.values()].flatMap((r) => {
          const m = decodeMessage(r.messageJson);
          return m === null ? [] : [m];
        }),
      ];
      const stored = JSON.stringify([...repos.notifications.rows.values()]);
      const rows = JSON.stringify(repos.notificationDeliveries.rows);
      if (stored.includes(secret)) leaks.push(`stored (seed ${seed})`);
      if (rows.includes(secret)) leaks.push(`deliveries (seed ${seed})`);
      for (const message of messages) {
        for (const [kind, renderer] of CHANNEL_RENDERERS) {
          const caps = renderer.capabilities({ mode: null, target: {}, secretRefs: {}, rules: {} });
          const requests = renderer.render(
            { message: degrade(message, caps), links: PUBLIC_LINKS, replyTo: null },
            {
              mode: kind === 'discord' ? 'webhook' : null,
              target: { chat_id: '1', topic: 't' },
              op: 'send',
              ref: null,
              actToken: () => 'bh1:x',
            },
          );
          checked++;
          if (JSON.stringify(requests).includes(secret)) {
            leaks.push(`${kind}/${message.kind}/${level} (seed ${seed})`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(120 * 8);
  });
});
