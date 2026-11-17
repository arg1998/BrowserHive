/** @module domain/site-packs/probe-classify.test — the pack probe's decision table (spec 13 §8.1): the cookie pre-check, then challenge → `challenged`, a `signed_out_redirects` final URL inside the pack's domains → `signed_out` `redirect`, the marker, the landmark, `no_redirect`, and every `inconclusive` reason; a challenge is never `signed_out`. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  classifyPackProbe,
  inPackDomains,
  type PackProbeFacts,
  packCookiePrecheck,
  probeUrlOf,
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
    ['still on the probe path', facts(), 'signed_in', 'no_redirect'],
    ['a timeout', facts({ failure: 'timeout' }), 'inconclusive', 'timeout'],
    ['a network failure', facts({ failure: 'network' }), 'inconclusive', 'network'],
    ['a server error on the probe path', facts({ status: 503 }), 'inconclusive', 'http_503'],
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

  it('a selector read that throws counts as absent', async () => {
    const broken: PackProbeFacts = {
      ...facts(),
      hasSelector: async () => {
        throw new Error('closed');
      },
    };
    expect(await classifyPackProbe(pack, broken)).toMatchObject({ reason: 'no_redirect' });
  });

  it('helpers', () => {
    expect(probeUrlOf(pack)).toBe('https://www.linkedin.com/feed/');
    expect(inPackDomains(pack, 'https://static.licdn.com/x')).toBe(true);
    expect(inPackDomains(pack, 'https://accounts.google.com/x')).toBe(false);
    expect(inPackDomains(pack, 'not a url')).toBe(false);
  });
});
