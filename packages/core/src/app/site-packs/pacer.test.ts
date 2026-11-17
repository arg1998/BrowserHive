/** @module app/site-packs/pacer.test — `pace-writes` and `ramp-up` on a fake clock (spec 13 §9.4, lead decision 5): only `write` guards of a pack selecting the strategy with a pace rule naming the guard are paced; one budget per (template, pack, rule) shared by the template's sessions; held writes reserve their token (released ones give it back); a young template's budget is lowered by its enabled sites' smallest ramp factor; a deleted template's buckets go (review PR #84 L5). */

import { describe, expect, test } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { PACE_PERIOD_MS } from '../../domain/site-packs/pace.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { GuardRuleInfo } from '../../ports/site-guards.ts';
import type { EffectivePack } from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { WritePacer } from './pacer.ts';
import { effective, lookupOf } from './strategy-test-packs.ts';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function paced(limit: number, per: 'minute' | 'hour' = 'minute', extra = {}): EffectivePack {
  return effective({
    strategies: [{ id: 'pace-writes', params: {} }],
    pacing: {
      rules: [
        {
          id: 'invites',
          guard: 'invite',
          per,
          limit,
          kind: 'vendor',
          source: { url: 'https://example.org/limits', kind: 'vendor' },
        },
      ],
      min_launch_gap_s: 0,
    },
    ...extra,
  });
}

const INFO: Record<string, GuardRuleInfo> = {
  'linkedin.com#invite': {
    ruleId: 'linkedin.com#invite',
    packId: 'linkedin.com',
    guardId: 'invite',
    guardKind: 'write',
    siteTitle: 'LinkedIn',
  },
  'linkedin.com#settings-post': {
    ruleId: 'linkedin.com#settings-post',
    packId: 'linkedin.com',
    guardId: 'settings-post',
    guardKind: 'account',
    siteTitle: 'LinkedIn',
  },
};

function world(
  pack: EffectivePack,
  options: { createdAt?: number; sites?: TemplateSiteRecord[]; random?: number } = {},
) {
  const clock = new FakeClock(T0);
  const bus = new RecordingEventBus<DomainEvents>();
  const sites = options.sites ?? [
    templateSiteRecord({ siteId: 'linkedin.com', packId: 'linkedin.com' }),
  ];
  const pacer = new WritePacer({
    describe: (id) => INFO[id] ?? null,
    lookup: lookupOf(pack),
    templates: {
      get: async () => templateRecord({ createdAt: options.createdAt ?? T0 - 90 * DAY }),
    },
    sites: { list: async () => sites },
    clock,
    random: () => options.random ?? 0,
    bus,
    logger: createCollectingLogger(),
  });
  const pace = (templateId = 'tpl-a', ruleId = 'linkedin.com#invite') =>
    pacer.pace({ templateId, ruleId });
  const removed = (templateId: string) =>
    bus.publish('template.removed', {
      type: 'template.removed',
      template_id: templateId,
    } as unknown as DomainEvents['template.removed']);
  return { clock, pacer, pace, removed };
}

describe('WritePacer', () => {
  test('a write guard within budget passes; over it is held, then refused past 60 s', async () => {
    const { pace } = world(paced(2));
    expect((await pace()).kind).toBe('pass');
    expect((await pace()).kind).toBe('pass');
    const held = await pace();
    expect(held).toMatchObject({ kind: 'hold', holdMs: 30_000 });
    expect(await pace()).toMatchObject({ kind: 'hold', holdMs: 60_000 });
    expect(await pace()).toMatchObject({ kind: 'refuse', retryAfterMs: 90_000 });
  });

  test('the hold carries 0–20 % jitter', async () => {
    const { pace } = world(paced(1), { random: 0.5 });
    await pace();
    expect(await pace()).toMatchObject({ kind: 'hold', holdMs: 66_000 });
  });

  test('a released hold gives its token back', async () => {
    const { pace } = world(paced(2));
    await pace();
    await pace();
    const held = await pace();
    if (held.kind !== 'hold') throw new Error('expected a hold');
    held.release();
    held.release();
    expect(await pace()).toMatchObject({ kind: 'hold', holdMs: 30_000 });
  });

  test('budgets refill continuously and are per template', async () => {
    const { pace, clock } = world(paced(1));
    expect((await pace('tpl-a')).kind).toBe('pass');
    expect((await pace('tpl-b')).kind).toBe('pass');
    expect((await pace('tpl-a')).kind).toBe('hold');
    await clock.advance(2 * PACE_PERIOD_MS.minute);
    expect((await pace('tpl-a')).kind).toBe('pass');
  });

  test('not paced: another guard kind, an unknown rule, no strategy, no rule for the guard', async () => {
    expect((await world(paced(1)).pace('t', 'linkedin.com#settings-post')).kind).toBe('pass');
    expect((await world(paced(1)).pace('t', 'browserhive#x')).kind).toBe('pass');
    const noStrategy = world(paced(1, 'minute', { strategies: [] }));
    await noStrategy.pace();
    expect((await noStrategy.pace()).kind).toBe('pass');
    const otherGuard = world(
      effective({
        strategies: [{ id: 'pace-writes', params: {} }],
        pacing: { rules: [], min_launch_gap_s: 0 },
      }),
    );
    await otherGuard.pace();
    expect((await otherGuard.pace()).kind).toBe('pass');
  });

  test('ramp-up lowers a young template budget (smallest factor of the enabled sites)', async () => {
    const ramp = paced(10, 'hour', {
      strategies: [
        { id: 'pace-writes', params: {} },
        { id: 'ramp-up', params: { days: 10, start_fraction: 0.2 } },
      ],
    });
    // A new template: 10 × 0.2 = 2 writes per hour.
    const young = world(ramp, { createdAt: T0 });
    expect((await young.pace()).kind).toBe('pass');
    expect((await young.pace()).kind).toBe('pass');
    expect((await young.pace()).kind).toBe('refuse');
    // Past the ramp: the full 10.
    const old = world(ramp, { createdAt: T0 - 11 * DAY });
    for (let i = 0; i < 10; i++) expect((await old.pace()).kind).toBe('pass');
    expect((await old.pace()).kind).toBe('refuse');
    // A disabled site's ramp does not count.
    const disabled = world(ramp, {
      createdAt: T0,
      sites: [
        templateSiteRecord({ siteId: 'linkedin.com', packId: 'linkedin.com', enabled: false }),
      ],
    });
    for (let i = 0; i < 10; i++) expect((await disabled.pace()).kind).toBe('pass');
  });

  test('a template read that fails counts as no ramp', async () => {
    const clock = new FakeClock(T0);
    const pacer = new WritePacer({
      describe: (id) => INFO[id] ?? null,
      lookup: lookupOf(paced(1)),
      templates: { get: async () => Promise.reject(new Error('db down')) },
      sites: { list: async () => [] },
      clock,
      random: () => 0,
      bus: new RecordingEventBus<DomainEvents>(),
      logger: createCollectingLogger(),
    });
    expect((await pacer.pace({ templateId: 't', ruleId: 'linkedin.com#invite' })).kind).toBe(
      'pass',
    );
  });

  test("a deleted template's buckets go; other templates keep theirs", async () => {
    const { pace, pacer, removed } = world(paced(1, 'hour'));
    expect((await pace('tpl-a')).kind).toBe('pass');
    expect((await pace('tpl-b')).kind).toBe('pass');
    removed('tpl-a');
    expect((await pace('tpl-a')).kind).toBe('pass');
    expect((await pace('tpl-b')).kind).toBe('refuse');
    pacer.stop();
    removed('tpl-b');
    expect((await pace('tpl-b')).kind).toBe('refuse');
  });
});
