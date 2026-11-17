/** @module domain/site-packs/classify-strategies.test — spec 13 §9.7 for `strategies`: added, removed, every parameter of `STRATEGY_SPECS` moved along and against its safe direction (`up`, `down`, `toward`, `away`, `none`, paths), defaults and clamping, the `active-hours` window rules, the `stealth-profile` floor against using templates, and the default-deny paths. */

import { describe, expect, it } from 'bun:test';
import { type SitePackV1Input, StrategyId } from '@browserhive/contracts/site-packs';
import type { ClassifyContext } from './classify.ts';
import { classOf } from './classify-test-kit.ts';
import { STRATEGY_SPEC_LIST } from './strategy-specs.ts';

type Params = Record<string, number | boolean | string>;

const select =
  (id: string, params: Params = {}) =>
  (p: SitePackV1Input) => {
    p.strategies = [...(p.strategies ?? []), { id: StrategyId.parse(id), params }];
  };
const setParams = (id: string, params: Params) => (p: SitePackV1Input) => {
  p.strategies = (p.strategies ?? []).map((s) => (s.id === id ? { ...s, params } : s));
};

/** The class of moving strategy `id` from `before` to `after` parameters. */
function moved(id: string, before: Params, after: Params, ctx?: ClassifyContext) {
  return classOf(setParams(id, after), { before: select(id, before), ...(ctx && { ctx }) });
}

describe('a strategy added or removed', () => {
  it('added tightens; removed loosens', () => {
    expect(classOf(select('serialize-site')).fields).toEqual({
      'strategies[serialize-site]': 'tightening',
    });
    expect(classOf(select('human-dwell', { min_ms: 900 })).overall).toBe('tightening');
    expect(classOf((p) => (p.strategies = []), { before: select('single-focus') }).fields).toEqual({
      'strategies[single-focus]': 'loosening',
    });
  });

  it('active-hours added is restrictive', () => {
    expect(classOf(select('active-hours', { start_hour: 6, end_hour: 23 })).overall).toBe(
      'restrictive',
    );
  });

  it('a strategy added with a path it loads is loosening (path-bearing)', () => {
    expect(classOf(select('entry-warmup', { path: '/jobs/' })).overall).toBe('loosening');
    expect(classOf(select('entry-warmup', { dwell_ms: 3000 })).overall).toBe('tightening');
  });
});

describe('every parameter moves along its safe direction', () => {
  // [strategy, param, value before, value after: a move in the safe direction]
  const safeMoves: [string, string, number | boolean | string, number | boolean | string][] = [
    ['launch-spacing', 'min_gap_s', 10, 60],
    ['launch-spacing', 'jitter_pct', 10, 30],
    ['ramp-up', 'days', 14, 30],
    ['ramp-up', 'start_fraction', 0.5, 0.2],
    ['serialize-site', 'max_parallel', 3, 1],
    ['human-dwell', 'min_ms', 600, 900],
    ['human-dwell', 'max_ms', 2500, 4000],
    ['entry-warmup', 'dwell_ms', 2000, 4000],
    ['keep-alive', 'interval_h', 24, 48],
    ['active-hours', 'weekdays_only', false, true],
    ['stealth-profile', 'min_level', 'standard', 'max'],
    ['stealth-profile', 'fingerprint', 'any', 'required'],
    ['stealth-profile', 'humanize', false, true],
    ['webrtc-policy', 'policy', 'default_public_interface_only', 'disable_non_proxied_udp'],
  ];

  it.each(safeMoves)('%s.%s: safe direction tightens, the reverse loosens', (id, name, a, b) => {
    const path = `strategies[${id}].params.${name}`;
    expect(moved(id, { [name]: a }, { [name]: b }).fields).toEqual({ [path]: 'tightening' });
    expect(moved(id, { [name]: b }, { [name]: a }).fields).toEqual({ [path]: 'loosening' });
  });

  it('covers every non-path, non-window parameter of STRATEGY_SPECS', () => {
    const covered = new Set(safeMoves.map(([id, name]) => `${id}.${name}`));
    const expected = STRATEGY_SPEC_LIST.flatMap((s) =>
      s.params.filter((p) => p.safe.kind !== 'none').map((p) => `${s.id}.${p.name}`),
    );
    expect(expected.filter((k) => !covered.has(k))).toEqual([]);
  });

  it('fingerprint: away from any tightens, between required and forbidden loosens', () => {
    expect(
      moved('stealth-profile', { fingerprint: 'any' }, { fingerprint: 'forbidden' }).overall,
    ).toBe('tightening');
    expect(
      moved('stealth-profile', { fingerprint: 'required' }, { fingerprint: 'forbidden' }).overall,
    ).toBe('loosening');
  });

  it('compares after defaults and clamping: an explicit default or an out-of-bounds twin is neutral', () => {
    expect(moved('serialize-site', {}, { max_parallel: 1 }).overall).toBe('neutral');
    expect(moved('launch-spacing', { min_gap_s: 5000 }, { min_gap_s: 3600 }).overall).toBe(
      'neutral',
    );
    // Absent → explicit uses the default as the "before" value.
    expect(moved('ramp-up', {}, { days: 30 }).overall).toBe('tightening');
    expect(moved('ramp-up', {}, { days: 7 }).overall).toBe('loosening');
  });
});

describe('parameters without a safe direction', () => {
  it('a path parameter: any change loosens', () => {
    expect(moved('entry-warmup', { path: '/' }, { path: '/feed/' }).fields).toEqual({
      'strategies[entry-warmup].params.path': 'loosening',
    });
  });

  it('entry-warmup referrer (none): any change loosens', () => {
    expect(moved('entry-warmup', {}, { referrer: 'search' }).overall).toBe('loosening');
    expect(moved('entry-warmup', { referrer: 'search' }, {}).overall).toBe('loosening');
  });
});

describe('active-hours window', () => {
  const hours = (start: number, end: number) => ({ start_hour: start, end_hour: end });
  it('shortened inside the window to 4 h or more tightens', () => {
    expect(moved('active-hours', hours(8, 22), hours(9, 20)).fields).toEqual({
      'strategies[active-hours].params.start_hour': 'tightening',
      'strategies[active-hours].params.end_hour': 'tightening',
    });
    expect(moved('active-hours', hours(8, 22), hours(8, 12)).overall).toBe('tightening');
  });

  it('shortened below 4 h is restrictive', () => {
    expect(moved('active-hours', hours(8, 22), hours(9, 12)).overall).toBe('restrictive');
  });

  it('longer or shifted loosens, also across midnight', () => {
    expect(moved('active-hours', hours(8, 22), hours(7, 22)).overall).toBe('loosening');
    expect(moved('active-hours', hours(8, 22), hours(10, 23)).overall).toBe('loosening');
    expect(moved('active-hours', hours(22, 6), hours(23, 5)).overall).toBe('tightening');
    expect(moved('active-hours', hours(22, 6), hours(20, 4)).overall).toBe('loosening');
  });
});

describe('stealth-profile and the templates that use the pack', () => {
  const ctx = (stealth: 'off' | 'standard' | 'max', fingerprint = false): ClassifyContext => ({
    usingTemplates: [{ templateId: 'tpl-1', name: 'sales', stealth, fingerprint }],
  });
  it('raised above a using template is restrictive; a template that meets it keeps tightening', () => {
    expect(moved('stealth-profile', {}, { min_level: 'max' }, ctx('standard')).overall).toBe(
      'restrictive',
    );
    expect(moved('stealth-profile', {}, { min_level: 'max' }, ctx('max')).overall).toBe(
      'tightening',
    );
    expect(
      moved('stealth-profile', {}, { fingerprint: 'forbidden' }, ctx('max', true)).overall,
    ).toBe('restrictive');
  });

  it('added above a using template is restrictive', () => {
    expect(classOf(select('stealth-profile'), { ctx: ctx('off') }).overall).toBe('restrictive');
    expect(classOf(select('stealth-profile'), { ctx: ctx('standard') }).overall).toBe('tightening');
  });
});

describe('default deny for strategies', () => {
  it('an unknown parameter name or an unknown strategy id path is loosening', () => {
    // Bypasses refinePack (which refuses both): the classifier must not trust its input.
    expect(moved('serialize-site', {}, { future_knob: 3 }).fields).toEqual({
      'strategies[serialize-site].params.future_knob': 'loosening',
    });
  });
});
