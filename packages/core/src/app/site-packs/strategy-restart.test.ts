/** @module app/site-packs/strategy-restart.test — a BrowserHive restart never refills a write budget or resets a spacing (D53, owner decision 2026-11-20): each "boot" builds a new store over the same repository, restores it and builds the strategy anew, on a fake clock. Mid-budget the remaining budget stays; the next launch still waits for its turn; a session's first action still dwells; `ramp-up` progress (the template's age) is unchanged; state whose window ended restores empty; a crash keeps the budgets written at once. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { InMemoryStrategyStateRepository } from '../../../test/helpers/in-memory-strategy-state-repo.ts';
import { PacksLookup, strategyPack } from '../../../test/helpers/packs-lookup.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { PACE_PERIOD_MS } from '../../domain/site-packs/pace.ts';
import type { EffectivePack } from '../../ports/site-packs.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { AdmissionStrategies } from '../templates/admission-strategies.ts';
import { WritePacer } from './pacer.ts';
import { persistedDwell, SiteDwell } from './strategies/dwell.ts';
import { StrategyState } from './strategy-state.ts';
import { effective, lookupOf } from './strategy-test-packs.ts';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One BrowserHive process over a shared repository. */
async function boot(repo: InMemoryStrategyStateRepository, clock: FakeClock) {
  const bus = new RecordingEventBus<DomainEvents>();
  const state = new StrategyState({
    repo,
    clock,
    logger: createCollectingLogger(),
    bus,
    schedule: () => () => undefined,
  });
  await state.restore();
  return { state, bus };
}

function paced(limit: number, extra: Record<string, unknown> = {}): EffectivePack {
  return effective({
    strategies: [{ id: 'pace-writes', params: {} }],
    pacing: {
      rules: [
        {
          id: 'invites',
          guard: 'invite',
          per: 'hour',
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

function pacerOf(
  pack: EffectivePack,
  clock: FakeClock,
  world: { state: StrategyState; bus: RecordingEventBus<DomainEvents> },
  createdAt = T0 - 90 * DAY,
) {
  const pacer = new WritePacer({
    describe: (id) =>
      id === 'linkedin.com#invite'
        ? {
            ruleId: id,
            packId: 'linkedin.com',
            guardId: 'invite',
            guardKind: 'write',
            siteTitle: 'LinkedIn',
          }
        : null,
    lookup: lookupOf(pack),
    templates: { get: async () => templateRecord({ createdAt }) },
    sites: {
      list: async () => [templateSiteRecord({ siteId: 'linkedin.com', packId: 'linkedin.com' })],
    },
    clock,
    random: () => 0,
    bus: world.bus,
    logger: createCollectingLogger(),
    state: world.state,
  });
  return async () =>
    (await pacer.pace({ templateId: 'tpl-a', ruleId: 'linkedin.com#invite' })).kind;
}

describe('pace-writes across a restart', () => {
  it('keeps the remaining budget mid-window', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const first = await boot(repo, clock);
    const pace = pacerOf(paced(3), clock, first);
    expect([await pace(), await pace()]).toEqual(['pass', 'pass']);
    await first.state.stop();

    await clock.advance(60_000);
    const second = await boot(repo, clock);
    const again = pacerOf(paced(3), clock, second);
    // One write of three was left (plus a minute's refill, under a token): the next is refused.
    expect(await again()).toBe('pass');
    expect(await again()).toBe('refuse');
  });

  it('a crash keeps the budget: tokens are written at once, without a clean stop', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const pace = pacerOf(paced(1), clock, await boot(repo, clock));
    expect(await pace()).toBe('pass');
    await settle(); // no stop(): the process dies here
    const again = pacerOf(paced(1), clock, await boot(repo, clock));
    expect(await again()).toBe('refuse');
  });

  it('a window that ended restores empty: the full budget is back', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const first = await boot(repo, clock);
    const pace = pacerOf(paced(2), clock, first);
    await pace();
    await pace();
    await first.state.stop();
    await clock.advance(PACE_PERIOD_MS.hour);
    const second = await boot(repo, clock);
    expect(
      second.state.get('pace-writes', {
        templateId: 'tpl-a',
        packId: 'linkedin.com',
        scopeKey: 'invites',
      }),
    ).toBeUndefined();
    const again = pacerOf(paced(2), clock, second);
    expect([await again(), await again(), await again()]).toEqual(['pass', 'pass', 'refuse']);
  });

  it('ramp-up progress is the template age: a restart neither restarts nor skips the ramp', async () => {
    const ramp = paced(10, {
      strategies: [
        { id: 'pace-writes', params: {} },
        { id: 'ramp-up', params: { days: 10, start_fraction: 0.2 } },
      ],
    });
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    // Day 5 of 10: 10 × 0.6 = 6 writes per hour.
    const createdAt = T0 - 5 * DAY;
    const first = await boot(repo, clock);
    const pace = pacerOf(ramp, clock, first, createdAt);
    for (let i = 0; i < 4; i++) expect(await pace()).toBe('pass');
    await first.state.stop();
    const again = pacerOf(ramp, clock, await boot(repo, clock), createdAt);
    expect([await again(), await again(), await again()]).toEqual(['pass', 'pass', 'refuse']);
  });
});

describe('launch-spacing across a restart', () => {
  const lookup = new PacksLookup([
    strategyPack('site-a.test', {
      strategies: [{ id: 'launch-spacing', params: { min_gap_s: 15, jitter_pct: 0 } }],
    }),
  ]);
  const sites = [templateSiteRecord({ siteId: 'site-a.test' })];
  const admission = (clock: FakeClock, state: StrategyState) =>
    new AdmissionStrategies({
      clock,
      logger: createCollectingLogger(),
      lookup: () => lookup,
      state,
    });

  it('the next launch after a restart still waits for its turn', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const template = templateRecord();
    const first = await boot(repo, clock);
    expect(admission(clock, first.state).reserveTurn(template, sites, 50_000)).toBe(0);
    await first.state.stop();

    await clock.advance(5_000);
    const second = await boot(repo, clock);
    expect(admission(clock, second.state).reserveTurn(template, sites, 50_000)).toBe(10_000);
  });

  it('a turn that came while BrowserHive was down restores empty', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const first = await boot(repo, clock);
    admission(clock, first.state).reserveTurn(templateRecord(), sites, 50_000);
    await first.state.stop();
    await clock.advance(16_000);
    const second = await boot(repo, clock);
    expect(admission(clock, second.state).reserveTurn(templateRecord(), sites, 50_000)).toBe(0);
  });
});

describe('human-dwell across a restart', () => {
  const params = { minMs: 2_000, maxMs: 2_000 };
  const templateOf = (sessionId: string) => (sessionId.startsWith('s-') ? 'tpl-a' : null);

  it("a session's first action after a restart dwells from the last action before it", async () => {
    const repo = new InMemoryStrategyStateRepository();
    const clock = new FakeClock(T0);
    const first = await boot(repo, clock);
    const dwell = new SiteDwell(() => 0, persistedDwell(first.state, templateOf));
    dwell.record('s-1', 'site-a.test', T0);
    await first.state.stop();

    await clock.advance(500);
    const second = await boot(repo, clock);
    const after = new SiteDwell(() => 0, persistedDwell(second.state, templateOf));
    // A new session of the same template: 1.5 s of the 2 s dwell are left.
    expect(after.waitMs('s-2', 'site-a.test', params, clock.now())).toBe(1_500);
    // Another site, or a session of no template, does not wait.
    expect(after.waitMs('s-2', 'site-b.test', params, clock.now())).toBe(0);
    expect(after.waitMs('x-1', 'site-a.test', params, clock.now())).toBe(0);
  });

  it('within one process a first action still does not wait (unchanged)', async () => {
    const clock = new FakeClock(T0);
    const { state } = await boot(new InMemoryStrategyStateRepository(), clock);
    const dwell = new SiteDwell(() => 0, persistedDwell(state, templateOf));
    dwell.record('s-1', 'site-a.test', T0);
    expect(dwell.waitMs('s-2', 'site-a.test', params, T0)).toBe(0);
    expect(dwell.waitMs('s-1', 'site-a.test', params, T0)).toBe(2_000);
  });
});
