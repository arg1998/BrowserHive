/** @module app/site-packs/keeper.test — `keep-alive` on a fake clock (spec 13 §8.3, §9.4): the first visit one interval (± 20 %) after the site's last check, the keeper path on the probe host (else the probe path), a skip after an agent load within the interval, the visit recorded as a probe (always on the probe path, only when it told something on a keeper path), a stopped browser started only with a free slot, nothing for signed-out or challenged sites, other packs, disabled sites or a missing lookup (`sitePacks=false`). */

import { describe, expect, test } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHost } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import { SiteKeeper } from './keeper.ts';
import { effective, lookupOf } from './strategy-test-packs.ts';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function keeperPack(path?: string): EffectivePack {
  return effective({
    strategies: [{ id: 'keep-alive', params: { interval_h: 10 } }],
    ...(path !== undefined && { keeper: { interval_hours: 10, path } }),
  });
}

async function world(
  options: {
    pack?: EffectivePack;
    lookup?: SitePackLookup | null;
    site?: Partial<TemplateSiteRecord>;
    running?: boolean;
    slotFree?: boolean;
    verdict?: ProbeVerdict;
  } = {},
) {
  const clock = new FakeClock(T0);
  const repos = new InMemoryRepositories();
  const template = templateRecord();
  await repos.templates.insert(template);
  await repos.templateSites.upsert(
    templateSiteRecord({
      siteId: 'linkedin.com',
      packId: 'linkedin.com',
      health: {
        state: 'signed_in',
        reason: 'landmark',
        checkedAt: T0,
        changedAt: T0,
        consecutiveInconclusive: 0,
      },
      ...options.site,
    }),
  );
  const host = new FakeTemplateHost(TEMPLATE_ID);
  let running = options.running ?? true;
  const visits: { path: string | null; host: string }[] = [];
  const recorded: ProbeVerdict[] = [];
  const loads = new Map<string, number>();
  const started: string[] = [];
  const lookup =
    options.lookup === undefined ? lookupOf(options.pack ?? keeperPack()) : options.lookup;
  const keeper = new SiteKeeper({
    repos,
    lookup: () => lookup,
    visits: { lastLoad: (_t, domains) => loads.get(domains[0] ?? '') ?? null },
    hosts: {
      runningHost: () => (running ? host : null),
      withHost: async (t, fn) => {
        started.push(t.templateId);
        running = true;
        return await fn(host);
      },
      slotFree: () => options.slotFree ?? true,
    },
    visit: async (ctx, path) => {
      visits.push({ path, host: ctx.host?.hostId ?? '' });
      return options.verdict ?? { outcome: 'signed_in', reason: 'landmark', finalUrl: null };
    },
    record: async (_t, _site, verdict) => void recorded.push(verdict),
    clock,
    random: () => 0.5,
    logger: createCollectingLogger(),
  });
  return { clock, keeper, visits, recorded, loads, started };
}

describe('SiteKeeper', () => {
  test('visits the probe path one interval after the last check and records it as a probe', async () => {
    const w = await world();
    await w.keeper.tick();
    expect(w.visits).toEqual([]);
    expect(w.keeper.dueAt(TEMPLATE_ID, 'linkedin.com')).toBe(T0 + 10 * H);
    await w.clock.set(T0 + 10 * H);
    const done = await w.keeper.tick();
    expect(w.visits).toEqual([{ path: null, host: TEMPLATE_ID }]);
    expect(w.recorded).toHaveLength(1);
    expect([...done.values()][0]).toMatchObject({ kind: 'visited', recorded: true });
    // Next one interval (± 20 %) later.
    expect(w.keeper.dueAt(TEMPLATE_ID, 'linkedin.com')).toBe(T0 + 20 * H);
  });

  test('the keeper path: visited, recorded only when it told something', async () => {
    const quiet = await world({
      pack: keeperPack('/keep'),
      verdict: { outcome: 'inconclusive', reason: 'no_signal', finalUrl: null },
    });
    await quiet.clock.set(T0 + 12 * H);
    await quiet.keeper.tick();
    await quiet.keeper.tick();
    expect(quiet.visits.map((v) => v.path)).toEqual(['/keep']);
    expect(quiet.recorded).toEqual([]);
    const out = await world({
      pack: keeperPack('/keep'),
      verdict: { outcome: 'signed_out', reason: 'redirect', finalUrl: null },
    });
    await out.clock.set(T0 + 12 * H);
    await out.keeper.tick();
    await out.keeper.tick();
    expect(out.recorded.map((v) => v.outcome)).toEqual(['signed_out']);
  });

  test('an agent load within the interval skips the visit and moves the next one', async () => {
    const w = await world();
    await w.keeper.tick();
    await w.clock.set(T0 + 10 * H);
    w.loads.set('linkedin.com', T0 + 9 * H);
    const done = await w.keeper.tick();
    expect([...done.values()]).toEqual([{ kind: 'skipped', reason: 'agent_load' }]);
    expect(w.visits).toEqual([]);
    expect(w.keeper.dueAt(TEMPLATE_ID, 'linkedin.com')).toBe(T0 + 19 * H);
  });

  test('a stopped browser starts only when a browser slot is free', async () => {
    const none = await world({ running: false, slotFree: false });
    await none.clock.set(T0 + 12 * H);
    const skipped = await none.keeper.tick();
    expect([...skipped.values()]).toEqual([{ kind: 'skipped', reason: 'no_slot' }]);
    expect(none.started).toEqual([]);
    const free = await world({ running: false });
    await free.clock.set(T0 + 12 * H);
    await free.keeper.tick();
    await free.keeper.tick();
    expect(free.started).toEqual([TEMPLATE_ID]);
    expect(free.visits).toHaveLength(1);
  });

  test('nothing for a signed-out or challenged site, a disabled site, another strategy or no packs', async () => {
    for (const state of ['signed_out', 'challenged'] as const) {
      const w = await world({
        site: {
          health: {
            state,
            reason: 'redirect',
            checkedAt: T0,
            changedAt: null,
            consecutiveInconclusive: 0,
          },
        },
      });
      await w.clock.set(T0 + 12 * H);
      await w.keeper.tick();
      expect(w.visits).toEqual([]);
    }
    const disabled = await world({ site: { enabled: false } });
    const plain = await world({ pack: effective() });
    const off = await world({ lookup: null });
    for (const w of [disabled, plain, off]) {
      await w.clock.set(T0 + 30 * H);
      await w.keeper.tick();
      await w.keeper.tick();
      expect(w.visits).toEqual([]);
    }
  });
});
