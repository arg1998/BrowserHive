/** @module app/site-packs/strategies/entry-warmup.test — `entry-warmup` decisions (spec 13 §9.4): only deep links warm up; the host is the target's when it is the pack's `www.` host or probe host, else the probe host; the referrer variants; the budget stays within half the tool's timeout. */

import { describe, expect, it } from 'bun:test';
import { SEARCH_REFERRER, WARMUP_LOAD_MAX_MS, warmupBudget, warmupPlan } from './entry-warmup.ts';

const pack = {
  domains: ['example.test', 'cdn-example.test'],
  signed_in: {
    probe: { host: 'app.example.test', path: '/feed' },
    kind: 'redirect' as const,
    signed_out_redirects: ['app.example.test/login*'],
  },
};
const params = { path: '/home', dwellMs: 2000, referrer: 'none' as const };

describe('warmupPlan', () => {
  it('skips the root, the entry path itself and unparsable targets', () => {
    expect(warmupPlan(pack, params, 'https://www.example.test/')).toBeNull();
    expect(warmupPlan(pack, params, 'https://www.example.test/home?tab=1')).toBeNull();
    expect(warmupPlan(pack, params, 'not a url')).toBeNull();
  });

  it('warms a deep link on the www host or the probe host up on that host', () => {
    expect(warmupPlan(pack, params, 'https://www.example.test/jobs/42')).toEqual({
      url: 'https://www.example.test/home',
      referer: undefined,
      dwellMs: 2000,
    });
    expect(warmupPlan(pack, params, 'https://app.example.test/jobs/42')?.url).toBe(
      'https://app.example.test/home',
    );
  });

  it('warms any other host of the pack up on the probe host', () => {
    expect(warmupPlan(pack, params, 'https://m.example.test/jobs/42')?.url).toBe(
      'https://app.example.test/home',
    );
    expect(warmupPlan(pack, params, 'https://cdn-example.test/x')?.url).toBe(
      'https://app.example.test/home',
    );
  });

  it('sends no Referer, the site root or the search engine', () => {
    const target = 'https://www.example.test/jobs/42';
    expect(warmupPlan(pack, { ...params, referrer: 'none' }, target)?.referer).toBeUndefined();
    expect(warmupPlan(pack, { ...params, referrer: 'same-site' }, target)?.referer).toBe(
      'https://www.example.test/',
    );
    expect(warmupPlan(pack, { ...params, referrer: 'search' }, target)?.referer).toBe(
      SEARCH_REFERRER,
    );
  });
});

describe('warmupBudget', () => {
  it('uses half the timeout, the dwell included', () => {
    expect(warmupBudget(30_000, 2_000)).toEqual({ loadMs: 13_000, dwellMs: 2_000 });
  });

  it('caps the load and has a bound without a timeout', () => {
    expect(warmupBudget(120_000, 2_000)).toEqual({ loadMs: WARMUP_LOAD_MAX_MS, dwellMs: 2_000 });
    expect(warmupBudget(0, 2_000)).toEqual({ loadMs: WARMUP_LOAD_MAX_MS, dwellMs: 2_000 });
  });

  it('skips a warm-up the timeout leaves no room for', () => {
    expect(warmupBudget(5_000, 2_000)).toBeNull();
    expect(warmupBudget(6_000, 2_000)).toEqual({ loadMs: 1_000, dwellMs: 2_000 });
  });
});
