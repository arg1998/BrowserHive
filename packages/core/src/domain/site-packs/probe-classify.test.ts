/** @module domain/site-packs/probe-classify.test — the pack probe's decision table (spec 13 §8.1): the cookie pre-check, then challenge → `challenged`, a `signed_out_redirects` final URL inside the pack's domains → `signed_out` `redirect`, the marker, the landmark, `no_redirect` (`no_redirect_settled` for an `either` probe) on the probe path or below it at a segment boundary (LinkedIn's `/feed/` → `/feed/foryou/`), `cookies_present` when every sign-in cookie was there and nothing else showed, and every `inconclusive` reason; a challenge is never `signed_out`. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  classifyPackProbe,
  inPackDomains,
  type PackProbeFacts,
  packCookiePrecheck,
  packCookiesAllPresent,
  probeUrlOf,
  samePlace,
} from './probe-classify.ts';
import { basePack } from './test-fixtures.ts';

const base = basePack();
const pack = SitePackV1.parse({
  ...base,
  signed_in: {
    ...base.signed_in,
    kind: 'either',
    signed_out_marker: 'form#login',
    landmark: '#global-nav',
    cookie_names: ['li_at', 'JSESSIONID'],
  },
});
const PROBE = 'https://www.linkedin.com/feed/';

function facts(over: Partial<PackProbeFacts> & { selectors?: string[] } = {}): PackProbeFacts {
  return {
    failure: over.failure ?? null,
    finalUrl: over.finalUrl ?? PROBE,
    status: over.status === undefined ? 200 : over.status,
    challenge: over.challenge ?? null,
    settled: over.settled ?? true,
    ...(over.path !== undefined && { path: over.path }),
    ...(over.cookiesPresent !== undefined && { cookiesPresent: over.cookiesPresent }),
    hasSelector: async (s) => (over.selectors ?? []).includes(s),
  };
}

describe('packCookiePrecheck', () => {
  const now = 1_700_000_000_000;
  const cookie = (name: string, domain: string, expires = -1) => ({ name, domain, expires });
  it('signed_out cookies_absent when no named cookie is present and unexpired on the domains', () => {
    expect(packCookiePrecheck(pack, [], now)).toEqual({
      outcome: 'signed_out',
      reason: 'cookies_absent',
      finalUrl: null,
    });
    expect(
      packCookiePrecheck(pack, [cookie('li_at', '.linkedin.com', now / 1000 - 1)], now),
    ).not.toBeNull();
    expect(packCookiePrecheck(pack, [cookie('li_at', '.other.test')], now)).not.toBeNull();
    expect(packCookiePrecheck(pack, [cookie('bcookie', '.linkedin.com')], now)).not.toBeNull();
  });

  it('navigates (null) when one is present, or when the pack names none', () => {
    expect(packCookiePrecheck(pack, [cookie('JSESSIONID', 'www.linkedin.com')], now)).toBeNull();
    expect(
      packCookiePrecheck(pack, [cookie('li_at', '.licdn.com', now / 1000 + 60)], now),
    ).toBeNull();
    expect(packCookiePrecheck(SitePackV1.parse(base), [], now)).toBeNull();
  });
});

describe('classifyPackProbe', () => {
  it.each([
    [
      'a challenge, even on a signed-out redirect',
      facts({ challenge: 'checkpoint', finalUrl: 'https://www.linkedin.com/uas/login?x=1' }),
      'challenged',
      'challenge:checkpoint',
    ],
    [
      'a signed-out redirect',
      facts({ finalUrl: 'https://www.linkedin.com/uas/login?session_redirect=x' }),
      'signed_out',
      'redirect',
    ],
    ['the marker', facts({ selectors: ['form#login', '#global-nav'] }), 'signed_out', 'marker'],
    ['the landmark', facts({ selectors: ['#global-nav'] }), 'signed_in', 'landmark'],
    ['still on the probe path (`either`: settled)', facts(), 'signed_in', 'no_redirect_settled'],
    ['a timeout', facts({ failure: 'timeout' }), 'inconclusive', 'timeout'],
    ['a network failure', facts({ failure: 'network' }), 'inconclusive', 'network'],
    ['a server error on the probe path', facts({ status: 503 }), 'inconclusive', 'http_503'],
    // Review #83 C-L5: a bot wall on the probe path is not a session.
    ['a 403 bot wall on the probe path', facts({ status: 403 }), 'inconclusive', 'http_403'],
    ['a 401 on the probe path', facts({ status: 401 }), 'inconclusive', 'http_401'],
    [
      'a 403 with the landmark still counts the landmark',
      facts({ status: 403, selectors: ['#global-nav'] }),
      'signed_in',
      'landmark',
    ],
    [
      'elsewhere with no signal',
      facts({ finalUrl: 'https://www.linkedin.com/somewhere' }),
      'inconclusive',
      'no_signal',
    ],
    [
      'a redirect glob outside the pack domains',
      facts({ finalUrl: 'https://evil.test/uas/login' }),
      'inconclusive',
      'no_signal',
    ],
  ])('%s', async (_name, input, outcome, reason) => {
    expect(await classifyPackProbe(pack, input)).toMatchObject({ outcome, reason });
  });

  it('the final URL is sanitized; a `landmark` pack never answers no_redirect', async () => {
    const verdict = await classifyPackProbe(pack, facts({ finalUrl: `${PROBE}?token=secret#x` }));
    expect(verdict.finalUrl).toBe(PROBE);
    const landmarkOnly = SitePackV1.parse({
      ...base,
      signed_in: { ...base.signed_in, kind: 'landmark', landmark: '#nav' },
    });
    expect(await classifyPackProbe(landmarkOnly, facts())).toMatchObject({
      outcome: 'inconclusive',
      reason: 'no_signal',
    });
  });

  it('D48: an `either` probe still on the probe path is signed in only once the page settled', async () => {
    expect(await classifyPackProbe(pack, facts({ settled: false }))).toMatchObject({
      outcome: 'inconclusive',
      reason: 'no_signal',
    });
    // Lower confidence than a `redirect` probe's `no_redirect` (review #84 L1): its own reason.
    expect(await classifyPackProbe(pack, facts({ settled: true }))).toMatchObject({
      outcome: 'signed_in',
      reason: 'no_redirect_settled',
    });
    // A redirect that landed during the post-load window wins whatever `settled` says.
    const out = facts({ settled: false, finalUrl: 'https://www.linkedin.com/uas/login?x=1' });
    expect(await classifyPackProbe(pack, out)).toMatchObject({ outcome: 'signed_out' });
  });

  it('a `redirect` probe keeps no_redirect at DOMContentLoaded (not weakened by the window)', async () => {
    const redirectPack = SitePackV1.parse({
      ...base,
      signed_in: { ...base.signed_in, kind: 'redirect' },
    });
    expect(await classifyPackProbe(redirectPack, facts({ settled: false }))).toMatchObject({
      outcome: 'signed_in',
      reason: 'no_redirect',
    });
  });

  it('a keeper visit of another path never answers no_redirect; the landmark and redirects still count', async () => {
    const keeper = (over: Partial<PackProbeFacts> & { selectors?: string[] }) =>
      facts({ path: '/keep', finalUrl: 'https://www.linkedin.com/keep', ...over });
    expect(await classifyPackProbe(pack, keeper({}))).toMatchObject({ reason: 'no_signal' });
    expect(await classifyPackProbe(pack, keeper({ selectors: ['#global-nav'] }))).toMatchObject({
      outcome: 'signed_in',
      reason: 'landmark',
    });
    const out = keeper({ finalUrl: 'https://www.linkedin.com/uas/login?next=/keep' });
    expect(await classifyPackProbe(pack, out)).toMatchObject({ outcome: 'signed_out' });
  });

  const redirectPack = SitePackV1.parse({
    ...base,
    signed_in: { ...base.signed_in, kind: 'redirect', cookie_names: ['li_at', 'liap'] },
  });

  it('the probe path or below it at a segment boundary has stayed put (LinkedIn /feed/ → /feed/foryou/, owner 2026-11-17)', async () => {
    expect(
      await classifyPackProbe(
        redirectPack,
        facts({ finalUrl: 'https://www.linkedin.com/feed/foryou/' }),
      ),
    ).toMatchObject({
      outcome: 'signed_in',
      reason: 'no_redirect',
      finalUrl: 'https://www.linkedin.com/feed/foryou/',
    });
    expect(
      await classifyPackProbe(pack, facts({ finalUrl: 'https://www.linkedin.com/feed/foryou/' })),
    ).toMatchObject({ outcome: 'signed_in', reason: 'no_redirect_settled' });
    // `/feedback` is not below `/feed/`; neither is another host.
    expect(
      await classifyPackProbe(
        redirectPack,
        facts({ finalUrl: 'https://www.linkedin.com/feedback' }),
      ),
    ).toMatchObject({ outcome: 'inconclusive', reason: 'no_signal' });
    expect(
      await classifyPackProbe(
        redirectPack,
        facts({ finalUrl: 'https://linkedin.com/feed/foryou/' }),
      ),
    ).toMatchObject({ outcome: 'inconclusive', reason: 'no_signal' });
    // Below the probe path but an error page or a signed-out redirect is never signed in.
    expect(
      await classifyPackProbe(
        redirectPack,
        facts({ finalUrl: 'https://www.linkedin.com/feed/foryou/', status: 500 }),
      ),
    ).toMatchObject({ outcome: 'inconclusive', reason: 'http_500' });
    const loginBelow = SitePackV1.parse({
      ...base,
      signed_in: {
        ...base.signed_in,
        kind: 'redirect',
        signed_out_redirects: ['www.linkedin.com/feed/login*'],
      },
    });
    expect(
      await classifyPackProbe(
        loginBelow,
        facts({ finalUrl: 'https://www.linkedin.com/feed/login?x=1' }),
      ),
    ).toMatchObject({ outcome: 'signed_out', reason: 'redirect' });
  });

  it('samePlace: segment boundaries, trailing slashes, and a root probe path covers only itself', () => {
    const at = (path: string) =>
      SitePackV1.parse({
        ...base,
        signed_in: { ...base.signed_in, probe: { host: 'h.test', path } },
      });
    expect(samePlace(at('/feed/'), 'https://h.test/feed', '/feed/')).toBe(true);
    expect(samePlace(at('/feed/'), 'https://h.test/feed/foryou/', '/feed/')).toBe(true);
    expect(samePlace(at('/feed'), 'https://h.test/feed/x', '/feed')).toBe(true);
    expect(samePlace(at('/feed'), 'https://h.test/feedback', '/feed')).toBe(false);
    expect(samePlace(at('/feed/'), 'https://H.TEST/feed/a/b?x=1', '/feed/')).toBe(true);
    expect(samePlace(at('/'), 'https://h.test/', '/')).toBe(true);
    expect(samePlace(at('/'), 'https://h.test/anything', '/')).toBe(false);
    expect(samePlace(at('/feed/'), 'not a url', '/feed/')).toBe(false);
  });

  it('cookies_present: every sign-in cookie there, a probe-path visit with no other signal on the pack domains', async () => {
    const elsewhere = facts({
      finalUrl: 'https://www.linkedin.com/somewhere',
      cookiesPresent: true,
    });
    expect(await classifyPackProbe(redirectPack, elsewhere)).toMatchObject({
      outcome: 'signed_in',
      reason: 'cookies_present',
    });
    // Without every cookie, off the pack's domains, on a keeper visit, or an unsettled `either`
    // probe: still no signal.
    expect(
      await classifyPackProbe(redirectPack, { ...elsewhere, cookiesPresent: false }),
    ).toMatchObject({ outcome: 'inconclusive', reason: 'no_signal' });
    expect(
      await classifyPackProbe(redirectPack, { ...elsewhere, finalUrl: 'https://other.test/' }),
    ).toMatchObject({ outcome: 'inconclusive', reason: 'no_signal' });
    expect(await classifyPackProbe(redirectPack, { ...elsewhere, path: '/keep' })).toMatchObject({
      outcome: 'inconclusive',
      reason: 'no_signal',
    });
    expect(await classifyPackProbe(pack, { ...elsewhere, settled: false })).toMatchObject({
      outcome: 'inconclusive',
      reason: 'no_signal',
    });
    // Every stronger signal still wins: a signed-out redirect, the marker, an error page.
    expect(
      await classifyPackProbe(redirectPack, {
        ...elsewhere,
        finalUrl: 'https://www.linkedin.com/uas/login?x=1',
      }),
    ).toMatchObject({ outcome: 'signed_out', reason: 'redirect' });
    const marked = SitePackV1.parse({
      ...base,
      signed_in: { ...redirectPack.signed_in, signed_out_marker: 'form#login' },
    });
    expect(
      await classifyPackProbe(marked, facts({ ...elsewhere, selectors: ['form#login'] })),
    ).toMatchObject({ outcome: 'signed_out', reason: 'marker' });
    expect(await classifyPackProbe(redirectPack, { ...elsewhere, status: 404 })).toMatchObject({
      outcome: 'inconclusive',
      reason: 'http_404',
    });
  });

  it('packCookiesAllPresent: every named cookie present and unexpired on the pack domains', () => {
    const now = 1_700_000_000_000;
    const jar = [
      { name: 'li_at', domain: '.www.linkedin.com', expires: now / 1000 + 60 },
      { name: 'liap', domain: '.linkedin.com', expires: -1 },
      { name: 'IDE', domain: '.doubleclick.net', expires: now / 1000 + 60 },
    ];
    expect(packCookiesAllPresent(redirectPack, jar, now)).toBe(true);
    expect(packCookiesAllPresent(redirectPack, jar.slice(1), now)).toBe(false);
    expect(
      packCookiesAllPresent(
        redirectPack,
        [
          { ...jar[0], expires: now / 1000 - 1 } as (typeof jar)[number],
          jar[1] as (typeof jar)[number],
        ],
        now,
      ),
    ).toBe(false);
    expect(packCookiesAllPresent(SitePackV1.parse(base), jar, now)).toBe(false);
  });

  it('a selector read that throws counts as absent', async () => {
    const broken: PackProbeFacts = {
      ...facts(),
      hasSelector: async () => {
        throw new Error('closed');
      },
    };
    expect(await classifyPackProbe(pack, broken)).toMatchObject({ reason: 'no_redirect_settled' });
  });

  it('helpers', () => {
    expect(probeUrlOf(pack)).toBe('https://www.linkedin.com/feed/');
    expect(inPackDomains(pack, 'https://static.licdn.com/x')).toBe(true);
    expect(inPackDomains(pack, 'https://accounts.google.com/x')).toBe(false);
    expect(inPackDomains(pack, 'not a url')).toBe(false);
  });
});
