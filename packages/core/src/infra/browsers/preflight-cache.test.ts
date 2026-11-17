/** @module infra/browsers/preflight-cache.test — the site's preflight answers kept per question for their max-age, as Chromium would (D-66). */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PREFLIGHT_MAX_AGE_S,
  MAX_PREFLIGHT_MAX_AGE_S,
  PreflightCache,
  preflightKey,
  preflightMaxAge,
} from './preflight-cache.ts';

const ORIGIN = 'https://site-a.test';

function question(headers: Record<string, string>, url = 'https://api.test/w', top = ORIGIN) {
  return preflightKey({ url, topOrigin: top, headers });
}

const ASKED = {
  Origin: ORIGIN,
  'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'content-type,x-custom',
  Referer: 'https://site-a.test/page',
  'User-Agent': 'ua',
};

function cacheAt(start = 1_000) {
  let now = start;
  const cache = new PreflightCache({ now: () => now, limit: 3 });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { cache, advance };
}

describe('preflightKey', () => {
  it('is the URL, the top origin, Origin and every Access-Control-Request-* header, case-insensitively', () => {
    const base = question(ASKED);
    expect(
      question({
        'access-control-request-headers': 'content-type,x-custom',
        origin: ORIGIN,
        'access-control-request-method': 'POST',
      }),
    ).toBe(base);
    // Other headers do not matter.
    expect(question({ ...ASKED, Referer: 'https://site-a.test/other' })).toBe(base);
    // Each part does.
    expect(question({ ...ASKED, 'Access-Control-Request-Method': 'PUT' })).not.toBe(base);
    expect(question({ ...ASKED, 'Access-Control-Request-Headers': 'x-custom' })).not.toBe(base);
    expect(question({ ...ASKED, Origin: 'https://site-b.test' })).not.toBe(base);
    expect(question({ ...ASKED, 'Access-Control-Request-Private-Network': 'true' })).not.toBe(base);
    expect(question(ASKED, 'https://api.test/other')).not.toBe(base);
    expect(question(ASKED, 'https://api.test/w', 'https://site-c.test')).not.toBe(base);
  });
});

describe('preflightMaxAge', () => {
  it('follows Chromium: default 5 s, capped at 2 h, 0 or less not kept', () => {
    expect(preflightMaxAge(undefined)).toBe(DEFAULT_PREFLIGHT_MAX_AGE_S);
    expect(preflightMaxAge('nonsense')).toBe(DEFAULT_PREFLIGHT_MAX_AGE_S);
    expect(preflightMaxAge('1.5')).toBe(DEFAULT_PREFLIGHT_MAX_AGE_S);
    expect(preflightMaxAge(' 600 ')).toBe(600);
    expect(preflightMaxAge('86400')).toBe(MAX_PREFLIGHT_MAX_AGE_S);
    expect(preflightMaxAge('0')).toBe(0);
    expect(preflightMaxAge('-1')).toBe(0);
  });
});

describe('PreflightCache', () => {
  const allow = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Max-Age': '600',
    'Content-Type': 'text/plain',
    Date: 'x',
  };

  it("keeps the site's Access-Control-* answer until its max-age passes", () => {
    const { cache, advance } = cacheAt();
    const key = question(ASKED);
    expect(cache.get(key)).toBeNull();
    expect(cache.store(key, ORIGIN, 204, allow)).toBe(true);
    expect(cache.get(key)).toEqual({
      status: 204,
      headers: [
        { name: 'Access-Control-Allow-Origin', value: ORIGIN },
        { name: 'Access-Control-Allow-Methods', value: 'POST' },
        { name: 'Access-Control-Max-Age', value: '600' },
      ],
    });
    advance(599_999);
    expect(cache.get(key)).not.toBeNull();
    advance(1);
    expect(cache.get(key)).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('keeps an answer without max-age for 5 s', () => {
    const { cache, advance } = cacheAt();
    const key = question(ASKED);
    const { 'Access-Control-Max-Age': _, ...noMaxAge } = allow;
    expect(cache.store(key, ORIGIN, 200, noMaxAge)).toBe(true);
    advance(4_999);
    expect(cache.get(key)).not.toBeNull();
    advance(1);
    expect(cache.get(key)).toBeNull();
  });

  it('never keeps a refusal, a foreign origin, a missing allow-origin or max-age 0', () => {
    const { cache } = cacheAt();
    const key = question(ASKED);
    expect(cache.store(key, ORIGIN, 403, allow)).toBe(false);
    expect(cache.store(key, ORIGIN, 302, allow)).toBe(false);
    expect(
      cache.store(key, ORIGIN, 204, { ...allow, 'Access-Control-Allow-Origin': 'https://x.test' }),
    ).toBe(false);
    expect(cache.store(key, ORIGIN, 204, { 'Access-Control-Max-Age': '600' })).toBe(false);
    expect(cache.store(key, ORIGIN, 204, { ...allow, 'Access-Control-Max-Age': '0' })).toBe(false);
    expect(cache.size).toBe(0);
    // `*` is kept: Chromium decides against the waiting request's credentials mode.
    expect(cache.store(key, ORIGIN, 204, { ...allow, 'access-control-allow-origin': ' * ' })).toBe(
      true,
    );
  });

  it('drops the oldest answer beyond its limit; storing again refreshes', () => {
    const { cache } = cacheAt();
    const keys = ['a', 'b', 'c', 'd'].map((p) => question(ASKED, `https://api.test/${p}`));
    for (const key of keys.slice(0, 3)) cache.store(key, ORIGIN, 204, allow);
    cache.store(keys[0] ?? '', ORIGIN, 204, allow);
    cache.store(keys[3] ?? '', ORIGIN, 204, allow);
    expect(cache.size).toBe(3);
    expect(keys.map((k) => cache.get(k) !== null)).toEqual([true, false, true, true]);
  });
});
