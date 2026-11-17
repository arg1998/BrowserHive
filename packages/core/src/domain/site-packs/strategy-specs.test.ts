/** @module domain/site-packs/strategy-specs.test — the strategy table, clamped parameters, parameter checks and the ramp and window helpers (spec 13 §9.4). */

import { describe, expect, test } from 'bun:test';
import { SitePackV1, STRATEGY_IDS } from '@browserhive/contracts/site-packs';
import { refinePack } from './refine.ts';
import {
  activeWindowHours,
  rampedLimit,
  rampFactor,
  STRATEGY_SPEC_LIST,
  STRATEGY_SPECS,
  strategyOf,
  strategyParamIssues,
} from './strategy-specs.ts';
import { basePack } from './test-fixtures.ts';

const DAY = 86_400_000;

function packWith(strategies: { id: string; params?: Record<string, unknown> }[], extra = {}) {
  return SitePackV1.parse({ ...basePack(), ...extra, strategies });
}

describe('STRATEGY_SPECS', () => {
  test('covers exactly the contract ids, in order', () => {
    expect(STRATEGY_SPEC_LIST.map((s) => s.id)).toEqual([...STRATEGY_IDS]);
    for (const id of STRATEGY_IDS) expect(STRATEGY_SPECS[id].id).toBe(id);
  });

  test('a path parameter has no safe direction', () => {
    for (const spec of STRATEGY_SPEC_LIST) {
      for (const p of spec.params) if (p.type === 'path') expect(p.safe.kind).toBe('none');
    }
  });
});

describe('strategyOf', () => {
  test('null when not selected', () => {
    expect(strategyOf(packWith([]), 'human-dwell')).toBeNull();
  });

  test('defaults', () => {
    const pack = packWith([{ id: 'human-dwell' }, { id: 'serialize-site' }, { id: 'ramp-up' }]);
    expect(strategyOf(pack, 'human-dwell')).toEqual({ minMs: 600, maxMs: 2500 });
    expect(strategyOf(pack, 'serialize-site')).toEqual({ maxParallel: 1 });
    expect(strategyOf(pack, 'ramp-up')).toEqual({ days: 14, startFraction: 0.3 });
  });

  test('clamps to the binary bounds', () => {
    const pack = packWith([
      { id: 'human-dwell', params: { min_ms: 50_000, max_ms: 1 } },
      { id: 'serialize-site', params: { max_parallel: 99 } },
      { id: 'ramp-up', params: { days: 0, start_fraction: 0.01 } },
      { id: 'keep-alive', params: { interval_h: 1 } },
    ]);
    expect(strategyOf(pack, 'human-dwell')).toEqual({ minMs: 10_000, maxMs: 10_000 });
    expect(strategyOf(pack, 'serialize-site')).toEqual({ maxParallel: 5 });
    expect(strategyOf(pack, 'ramp-up')).toEqual({ days: 1, startFraction: 0.1 });
    expect(strategyOf(pack, 'keep-alive')).toEqual({ intervalH: 6 });
  });

  test('pack-derived defaults', () => {
    const pack = packWith([{ id: 'launch-spacing' }, { id: 'keep-alive' }], {
      pacing: { rules: [], min_launch_gap_s: 90 },
      keeper: { interval_hours: 48 },
    });
    expect(strategyOf(pack, 'launch-spacing')).toEqual({ minGapS: 90, jitterPct: 20 });
    expect(strategyOf(pack, 'keep-alive')).toEqual({ intervalH: 48 });
    const bare = packWith([{ id: 'keep-alive' }], { pacing: undefined });
    expect(strategyOf(bare, 'keep-alive')).toEqual({ intervalH: 24 });
  });

  test('stealth parameters', () => {
    const pack = packWith([
      { id: 'stealth-profile', params: { min_level: 'max', fingerprint: 'forbidden' } },
      { id: 'webrtc-policy', params: { policy: 'disable_non_proxied_udp' } },
    ]);
    expect(strategyOf(pack, 'stealth-profile')).toEqual({
      minLevel: 'max',
      fingerprint: 'forbidden',
      humanize: false,
    });
    expect(strategyOf(pack, 'webrtc-policy')).toEqual({ policy: 'disable_non_proxied_udp' });
  });
});

describe('strategyParamIssues', () => {
  test('unknown names, types and enum values', () => {
    expect(strategyParamIssues('human-dwell', { min: 1 })[0]?.param).toBe('min');
    expect(strategyParamIssues('human-dwell', { min_ms: 'x' })[0]?.message).toBe(
      'must be a number',
    );
    expect(strategyParamIssues('webrtc-policy', { policy: 'off' })[0]?.param).toBe('policy');
    expect(strategyParamIssues('entry-warmup', { path: 'https://x.test/' })[0]?.param).toBe('path');
    expect(strategyParamIssues('pace-writes', {})).toEqual([]);
  });

  test('active-hours needs a window of at least one hour', () => {
    expect(strategyParamIssues('active-hours', { start_hour: 9, end_hour: 9 })).toHaveLength(1);
    expect(strategyParamIssues('active-hours', { start_hour: 22, end_hour: 6 })).toEqual([]);
  });

  test('refinePack reports them and duplicate ids', () => {
    const bad = packWith([
      { id: 'human-dwell', params: { min_ms: 'slow' } },
      { id: 'human-dwell', params: {} },
    ]);
    const paths = refinePack(bad).issues.map((i) => i.path);
    expect(paths).toContain('strategies[0].params.min_ms');
    expect(paths).toContain('strategies[1].id');
  });
});

describe('ramp-up and active hours', () => {
  test('rampFactor grows linearly to 1', () => {
    const params = { days: 10, startFraction: 0.5 };
    expect(rampFactor(params, 0)).toBe(0.5);
    expect(rampFactor(params, 5 * DAY)).toBe(0.75);
    expect(rampFactor(params, 10 * DAY)).toBe(1);
    expect(rampFactor(params, -DAY)).toBe(0.5);
  });

  test('rampedLimit rounds up and never reaches 0', () => {
    expect(rampedLimit(5, 0.3)).toBe(2);
    expect(rampedLimit(1, 0.1)).toBe(1);
    expect(rampedLimit(100, 1)).toBe(100);
    expect(rampedLimit(10, 0.6)).toBe(6);
  });

  test('activeWindowHours wraps past midnight', () => {
    expect(activeWindowHours({ startHour: 8, endHour: 22, weekdaysOnly: false })).toBe(14);
    expect(activeWindowHours({ startHour: 22, endHour: 2, weekdaysOnly: false })).toBe(4);
  });
});
