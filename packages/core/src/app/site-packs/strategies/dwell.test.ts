/** @module app/site-packs/strategies/dwell.test — `human-dwell` (spec 13 §9.4): no wait for a session's first action on a site; afterwards a dwell in [min_ms, max_ms] drawn from the injected random, measured from the previous action; per (session, site). */

import { describe, expect, it } from 'bun:test';
import { SiteDwell } from './dwell.ts';

const params = { minMs: 600, maxMs: 2500 };

describe('SiteDwell', () => {
  it('does not wait before the first action on a site', () => {
    expect(new SiteDwell(() => 0.5).waitMs('s-1', 'site-a.test', params, 1_000)).toBe(0);
  });

  it('draws the dwell inside [min_ms, max_ms] from the injected random', () => {
    const low = new SiteDwell(() => 0);
    low.record('s-1', 'site-a.test', 10_000);
    expect(low.waitMs('s-1', 'site-a.test', params, 10_000)).toBe(600);
    const high = new SiteDwell(() => 0.999_999);
    high.record('s-1', 'site-a.test', 10_000);
    expect(high.waitMs('s-1', 'site-a.test', params, 10_000)).toBe(2500);
    const mid = new SiteDwell(() => 0.5);
    mid.record('s-1', 'site-a.test', 10_000);
    expect(mid.waitMs('s-1', 'site-a.test', params, 10_000)).toBe(600 + Math.floor(0.5 * 1901));
  });

  it('counts time already passed since the previous action', () => {
    const dwell = new SiteDwell(() => 0);
    dwell.record('s-1', 'site-a.test', 10_000);
    expect(dwell.waitMs('s-1', 'site-a.test', params, 10_400)).toBe(200);
    expect(dwell.waitMs('s-1', 'site-a.test', params, 11_000)).toBe(0);
  });

  it('keeps sessions and sites apart and forgets a closed session', () => {
    const dwell = new SiteDwell(() => 0);
    dwell.record('s-1', 'site-a.test', 10_000);
    expect(dwell.waitMs('s-2', 'site-a.test', params, 10_000)).toBe(0);
    expect(dwell.waitMs('s-1', 'site-b.test', params, 10_000)).toBe(0);
    dwell.forget('s-1');
    expect(dwell.waitMs('s-1', 'site-a.test', params, 10_000)).toBe(0);
  });

  it('a max below the min acts as the min; zero bounds never wait', () => {
    const dwell = new SiteDwell(() => 0.9);
    dwell.record('s-1', 'p', 0);
    expect(dwell.waitMs('s-1', 'p', { minMs: 800, maxMs: 100 }, 0)).toBe(800);
    expect(dwell.waitMs('s-1', 'p', { minMs: 0, maxMs: 0 }, 0)).toBe(0);
  });
});
