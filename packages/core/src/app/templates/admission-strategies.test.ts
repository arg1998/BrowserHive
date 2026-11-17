/** @module app/templates/admission-strategies.test — the admission strategies over a fake clock (spec 13 §6.3, §9.4): the pack concurrency cap and `ramp-up` (smallest wins, disabled sites ignored), `active-hours` refusing with `retry_after_ms` in the template's timezone, `launch-spacing` turns (FIFO, jitter bounds with an injected random, the 20 s and budget limits, refusal with the time to the turn), agent-safe refusal text, and nothing under `sitePacks=false`. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { PacksLookup, strategyPack } from '../../../test/helpers/packs-lookup.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { effectiveCap, NO_CAP_LIMITS } from '../../domain/templates/model.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import { AdmissionStrategies, LAUNCH_SPACING_MAX_WAIT_MS } from './admission-strategies.ts';

const DAY = 86_400_000;
const H = 3_600_000;
/** Tuesday 17 Nov 2026 12:00 UTC (07:00 in Toronto, the fixture template's zone). */
const NOON_UTC = Date.UTC(2026, 10, 17, 12);
const site = (siteId: string, enabled = true) => templateSiteRecord({ siteId, enabled });

function world(lookup: SitePackLookup | null, options: { random?: number; now?: number } = {}) {
  const clock = new FakeClock(options.now ?? NOON_UTC);
  const logger = new CollectingLogger();
  const random = options.random;
  const strategies = new AdmissionStrategies({
    clock,
    logger,
    lookup: () => lookup,
    ...(random !== undefined && { random: () => random }),
  });
  return { clock, logger, strategies };
}

function refusal(fn: () => unknown): {
  code: string;
  details: Record<string, unknown>;
  message: string;
} {
  try {
    fn();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      details: error.details as Record<string, unknown>,
      message: error.publicMessage,
    };
  }
  throw new Error('not refused');
}

describe('cap limits: concurrency.max_sessions and ramp-up', () => {
  it('takes the smallest pack max_sessions of the enabled sites, never above max_concurrent', () => {
    const lookup = new PacksLookup([
      strategyPack('site-a.test', {
        concurrency: { max_sessions: 3, source: { url: 'https://a.test/', kind: 'observed' } },
      }),
      strategyPack('site-b.test', {
        concurrency: { max_sessions: 2, source: { url: 'https://b.test/', kind: 'observed' } },
      }),
      strategyPack('site-c.test', {
        concurrency: { max_sessions: 1, source: { url: 'https://c.test/', kind: 'observed' } },
      }),
    ]);
    const { strategies } = world(lookup);
    const template = templateRecord({ maxConcurrent: 5, createdAt: NOON_UTC - 400 * DAY });
    const sites = [site('site-a.test'), site('site-b.test'), site('site-c.test', false)];
    const limits = strategies.capLimits(template, sites);
    expect(limits).toEqual({ siteMax: 2, rampFactor: 1 });
    expect(effectiveCap(template, limits)).toBe(2);
    expect(effectiveCap(templateRecord({ maxConcurrent: 1 }), limits)).toBe(1);
  });

  it('ramp-up scales the cap for a young template, rounded up, the smallest factor winning', async () => {
    const lookup = new PacksLookup([
      strategyPack('site-a.test', {
        strategies: [{ id: 'ramp-up', params: { days: 10, start_fraction: 0.2 } }],
      }),
      strategyPack('site-b.test', {
        strategies: [{ id: 'ramp-up', params: { days: 10, start_fraction: 0.5 } }],
      }),
    ]);
    const { strategies, clock } = world(lookup);
    const template = templateRecord({ maxConcurrent: 10, createdAt: NOON_UTC });
    const sites = [site('site-a.test'), site('site-b.test')];
    // Day 0: 0.2 × 10 = 2.
    expect(effectiveCap(template, strategies.capLimits(template, sites))).toBe(2);
    // Day 5: 0.2 + 0.8 × 0.5 = 0.6 → 6.
    await clock.advance(5 * DAY);
    expect(strategies.capLimits(template, sites).rampFactor).toBeCloseTo(0.6, 10);
    expect(effectiveCap(template, strategies.capLimits(template, sites))).toBe(6);
    // Day 10: the ramp is over.
    await clock.advance(5 * DAY);
    expect(effectiveCap(template, strategies.capLimits(template, sites))).toBe(10);
    // Rounded up: 0.36 × 3 = 1.08 → 2; never below 1.
    expect(
      effectiveCap(templateRecord({ maxConcurrent: 3 }), { siteMax: null, rampFactor: 0.36 }),
    ).toBe(2);
    expect(
      effectiveCap(templateRecord({ maxConcurrent: 1 }), { siteMax: null, rampFactor: 0.1 }),
    ).toBe(1);
  });

  it('applies nothing under sitePacks=false or for a site without a pack', () => {
    const { strategies } = world(null);
    expect(strategies.capLimits(templateRecord(), [site('site-a.test')])).toEqual(NO_CAP_LIMITS);
    const generic = world(new PacksLookup()).strategies;
    expect(generic.capLimits(templateRecord(), [site('other.test')])).toEqual(NO_CAP_LIMITS);
  });
});

describe('active-hours', () => {
  const hours = (start: number, end: number, weekdays = false) =>
    strategyPack('site-a.test', {
      strategies: [
        {
          id: 'active-hours',
          params: { start_hour: start, end_hour: end, weekdays_only: weekdays },
        },
      ],
    });

  it('refuses outside the window in the template timezone with the time to its start', () => {
    const { strategies } = world(new PacksLookup([hours(8, 22)]));
    // 07:00 in Toronto: an hour early.
    const busy = refusal(() => strategies.checkHours(templateRecord(), [site('site-a.test')]));
    expect(busy.code).toBe('TEMPLATE_BUSY');
    expect(busy.details).toMatchObject({
      limit_kind: 'capacity',
      retry_after_ms: H,
      retry_after_s: 3600,
    });
    // Agents learn nothing about hours, packs or sites.
    expect(busy.message).toBe("Template 'job-hunt' is at capacity. Retry in 3600 s.");
    // The same instant in UTC is inside.
    const utcTemplate = templateRecord({
      identity: { ...templateRecord().identity, timezoneId: 'UTC' },
    });
    expect(() => strategies.checkHours(utcTemplate, [site('site-a.test')])).not.toThrow();
  });

  it('intersects several sites and ignores disabled ones', () => {
    const lookup = new PacksLookup([
      hours(6, 22),
      strategyPack('site-b.test', {
        strategies: [{ id: 'active-hours', params: { start_hour: 9, end_hour: 17 } }],
      }),
    ]);
    const { strategies } = world(lookup, { now: Date.UTC(2026, 10, 17, 12) }); // 07:00 Toronto
    const both = [site('site-a.test'), site('site-b.test')];
    expect(
      refusal(() => strategies.checkHours(templateRecord(), both)).details['retry_after_ms'],
    ).toBe(2 * H);
    expect(() =>
      strategies.checkHours(templateRecord(), [site('site-a.test'), site('site-b.test', false)]),
    ).not.toThrow();
  });

  it('weekdays_only waits for Monday; windows that never overlap ask for a day and log it', () => {
    // Saturday 21 Nov 15:00 UTC = 10:00 Toronto → Monday 08:00 Toronto.
    const saturday = Date.UTC(2026, 10, 21, 15);
    const { strategies, logger } = world(new PacksLookup([hours(8, 22, true)]), { now: saturday });
    expect(
      refusal(() => strategies.checkHours(templateRecord(), [site('site-a.test')])).details[
        'retry_after_ms'
      ],
    ).toBe(46 * H);
    const apart = world(
      new PacksLookup([
        hours(8, 10),
        strategyPack('site-b.test', {
          strategies: [{ id: 'active-hours', params: { start_hour: 12, end_hour: 14 } }],
        }),
      ]),
    );
    const busy = refusal(() =>
      apart.strategies.checkHours(templateRecord(), [site('site-a.test'), site('site-b.test')]),
    );
    expect(busy.details['retry_after_ms']).toBe(DAY);
    expect(apart.logger.records.some((r) => r.msg === 'active hours never overlap')).toBe(true);
    expect(logger.records.some((r) => r.msg === 'launch outside hours')).toBe(true);
  });

  it('is inert under sitePacks=false', () => {
    const { strategies } = world(null);
    expect(() => strategies.checkHours(templateRecord(), [site('site-a.test')])).not.toThrow();
  });
});

describe('launch-spacing', () => {
  const spaced = (gap: number, jitter = 0, id = 'site-a.test') =>
    strategyPack(id, {
      strategies: [{ id: 'launch-spacing', params: { min_gap_s: gap, jitter_pct: jitter } }],
    });
  const BUDGET = 50_000;

  it('spaces consecutive launches: the first goes at once, the next waits for its turn', async () => {
    const { strategies, clock } = world(new PacksLookup([spaced(10)]));
    const t = templateRecord();
    const sites = [site('site-a.test')];
    expect(strategies.reserveTurn(t, sites, BUDGET)).toBe(0);
    // Reserved synchronously: three launches at the same instant queue FIFO.
    expect(strategies.reserveTurn(t, sites, BUDGET)).toBe(10_000);
    expect(strategies.reserveTurn(t, sites, BUDGET)).toBe(20_000);
    // The fourth turn is 30 s away, beyond the 20 s wait: refused with the time to it.
    const busy = refusal(() => strategies.reserveTurn(t, sites, BUDGET));
    expect(busy.details).toMatchObject({ limit_kind: 'capacity', retry_after_ms: 30_000 });
    expect(busy.message).toBe("Template 'job-hunt' is at capacity. Retry in 30 s.");
    // The refusal reserved nothing: 30 s later the next launch goes at once.
    await clock.advance(30_000);
    expect(strategies.reserveTurn(t, sites, BUDGET)).toBe(0);
  });

  it('never waits beyond the remaining launch budget', () => {
    const { strategies } = world(new PacksLookup([spaced(15)]));
    const t = templateRecord();
    strategies.reserveTurn(t, [site('site-a.test')], BUDGET);
    expect(
      refusal(() => strategies.reserveTurn(t, [site('site-a.test')], 12_000)).details,
    ).toMatchObject({
      retry_after_ms: 15_000,
    });
    expect(strategies.reserveTurn(t, [site('site-a.test')], 16_000)).toBe(15_000);
    expect(LAUNCH_SPACING_MAX_WAIT_MS).toBe(20_000);
  });

  it('jitter stays within [0, jitter_pct %] of the gap (injected random)', () => {
    const at = (random: number) => {
      const { strategies } = world(new PacksLookup([spaced(10, 50)]), { random });
      strategies.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET);
      return strategies.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET);
    };
    expect(at(0)).toBe(10_000);
    expect(at(0.5)).toBe(12_500);
    expect(at(0.999_999)).toBeLessThanOrEqual(15_000);
    expect(at(0.999_999)).toBeGreaterThan(14_999);
    // A random source out of range is clamped.
    expect(at(7)).toBeLessThanOrEqual(15_000);
    expect(at(-1)).toBe(10_000);
  });

  it('several sites: the largest gap and jitter win; disabled sites and other templates do not count', () => {
    const lookup = new PacksLookup([spaced(4, 0), spaced(8, 25, 'site-b.test')]);
    const { strategies } = world(lookup, { random: 0.5 });
    const t = templateRecord();
    const both = [site('site-a.test'), site('site-b.test')];
    strategies.reserveTurn(t, both, BUDGET);
    expect(strategies.reserveTurn(t, both, BUDGET)).toBe(9_000);
    const other = templateRecord({ templateId: 'tp-other00001' });
    expect(strategies.reserveTurn(other, both, BUDGET)).toBe(0);
    const onlyA = world(lookup, { random: 0.5 }).strategies;
    onlyA.reserveTurn(t, [site('site-a.test'), site('site-b.test', false)], BUDGET);
    expect(onlyA.reserveTurn(t, [site('site-a.test'), site('site-b.test', false)], BUDGET)).toBe(
      4_000,
    );
  });

  it('is inert with no gap and under sitePacks=false', () => {
    const none = world(new PacksLookup([spaced(0)])).strategies;
    expect(none.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET)).toBe(0);
    expect(none.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET)).toBe(0);
    const off = world(null).strategies;
    off.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET);
    expect(off.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET)).toBe(0);
  });

  it('forgets a deleted template', () => {
    const { strategies } = world(new PacksLookup([spaced(10)]));
    strategies.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET);
    strategies.forget(templateRecord().templateId);
    expect(strategies.reserveTurn(templateRecord(), [site('site-a.test')], BUDGET)).toBe(0);
  });
});
