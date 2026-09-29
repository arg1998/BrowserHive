/** @module test/notifications/renderer-redaction.property.test — the redaction invariant extended to the platform renderers (spec 10 §9): a sentinel registered in the `SecretRegistry` and routed through every producer input never appears in any renderer's request (paths, headers, bodies, at every content level, with public and local links) nor in the generic webhook body a real transport posts. The in-app, stored-message and delivery-log sinks stay covered by `app/notifications/redaction.property.test.ts`; this suite lives under `test/` because it joins app and infra, which the layer rules keep apart in `src/`. Seeded, 300 cases. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { restrictContent } from '../../src/app/notifications/content-level.ts';
import { degrade } from '../../src/app/notifications/degrade.ts';
import { decodeMessage } from '../../src/app/notifications/message.ts';
import { NotificationService } from '../../src/app/notifications/notification-service.ts';
import type { ProducedEvent } from '../../src/app/notifications/producers.ts';
import {
  attentionCreated,
  systemDegraded,
  toolCalled,
  vaultConfirmCreated,
} from '../../src/app/notifications/test-fixtures.ts';
import {
  CHANNEL_RENDERERS,
  createWebhookChannel,
  WEBHOOK_CAPABILITIES,
} from '../../src/infra/notifications/index.ts';
import { createRedactor, SecretRegistry } from '../../src/kernel/redact.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { FakePlatforms } from '../helpers/fake-platforms.ts';
import { InMemoryRepositories } from '../helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { LOCAL_LINKS, PUBLIC_LINKS, platformRecord } from './helpers.ts';

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
  let out = 'zq';
  const length = 12 + Math.floor(next() * 20);
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

function events(next: () => number, secret: string): ProducedEvent[] {
  const text = `before ${secret} after`;
  const picks: (() => ProducedEvent)[] = [
    () =>
      attentionCreated('a-000000000001', next() < 0.5 ? 'takeover' : 'notify', {
        reason: text,
        page_url: `https://example.com/${secret}/login?q=${secret}`,
        tool: `tool-${secret}`.slice(0, 60),
      }),
    () => vaultConfirmCreated('a-000000000002', text),
    () => toolCalled(1, { ok: false, code: text }),
    () => {
      const e = systemDegraded('error');
      if (e.name !== 'system.degraded') return e;
      return {
        ...e,
        payload: {
          ...e.payload,
          event: { ...e.payload.event, message: text, code: `C_${secret}` },
        },
      };
    },
  ];
  const pick = picks[Math.floor(next() * picks.length)] ?? picks[0];
  return pick === undefined ? [] : [pick()];
}

const LEVELS: readonly NotificationContentLevel[] = ['counts', 'titles', 'full'];

let fakes: FakePlatforms;
beforeAll(() => {
  fakes = new FakePlatforms().start();
});
afterAll(async () => {
  await fakes.stop();
});

describe('renderer redaction invariant', () => {
  it('a registered sentinel never reaches a platform request or a webhook body (300 cases)', async () => {
    const leaks: string[] = [];
    let rendered = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed);
      const secret = sentinelOf(next);
      const clock = new FakeClock();
      const registry = new SecretRegistry({ now: () => clock.now() });
      registry.add(secret);
      const redactor = createRedactor(registry);
      const repos = new InMemoryRepositories();
      const service = new NotificationService({
        repo: repos.notifications,
        bus: new RecordingEventBus<DomainEvents>(),
        clock,
        ids: new FakeIdGenerator(),
        logger: new CollectingLogger(),
        redactor,
      });
      for (const event of events(next, secret)) await service.produce(event);
      for (const row of repos.notifications.rows.values()) {
        const message = decodeMessage(row.messageJson);
        if (message === null) continue;
        for (const [kind, renderer] of CHANNEL_RENDERERS) {
          for (const mode of kind === 'discord' ? ['webhook', 'bot'] : [null]) {
            const capabilities = renderer.capabilities(mode);
            for (const level of LEVELS) {
              for (const links of [PUBLIC_LINKS, LOCAL_LINKS]) {
                const requests = renderer.render(
                  {
                    message: degrade(restrictContent(message, level), capabilities),
                    links,
                    replyTo: null,
                  },
                  {
                    mode,
                    target: { chat_id: '1', topic: 't' },
                    op: 'send',
                    ref: null,
                    actToken: () => 'bh1:x',
                  },
                );
                rendered++;
                if (JSON.stringify(requests).includes(secret)) {
                  leaks.push(`${kind}/${mode ?? '-'}/${level} (seed ${seed})`);
                }
              }
            }
          }
        }
        if (seed % 30 === 0) {
          const before = fakes.of('webhook').length;
          const channel = createWebhookChannel(
            platformRecord('webhook', { target: { url: fakes.webhookUrl } }),
            { url: null, secret: 's'.repeat(24) },
          );
          await channel.send({
            message: degrade(message, WEBHOOK_CAPABILITIES),
            links: PUBLIC_LINKS,
            replyTo: null,
          });
          const posted = fakes.of('webhook').slice(before);
          if (posted.length !== 1 || posted.some((r) => r.raw.includes(secret))) {
            leaks.push(`webhook body (seed ${seed})`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(rendered).toBeGreaterThan(300 * 20);
  });
});
