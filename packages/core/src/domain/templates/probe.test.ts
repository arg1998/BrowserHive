/** @module domain/templates/probe.test — the generic sign-in probe table (spec 13 §8.1 step 3) and the health rules over probe results (§8.2, §8.3): `healthAfter`, `staleSites`, the jitter and the site gap. */

import { describe, expect, it } from 'bun:test';
import { templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type {
  TemplateProbeOutcome,
  TemplateSiteHealthRecord,
} from '../../ports/persistence/index.ts';
import {
  classifyGenericProbe,
  healthAfter,
  isOut,
  jitteredInterval,
  providerOf,
  siteGapMs,
  sitesOfProvider,
  staleSites,
} from './probe.ts';

const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1000;
const LATER = NOW_S + 3_600;
const EARLIER = NOW_S - 3_600;

const SITE = templateSiteRecord({ siteId: 'site-a.test', learnedCookieNames: ['sid', 'auth'] });

function cookie(name: string, domain = '.site-a.test', expires = LATER) {
  return { name, domain, expires };
}

describe('classifyGenericProbe', () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      readonly ReturnType<typeof cookie>[],
      TemplateProbeOutcome,
      string,
      (readonly string[])?,
    ]
  > = [
    ['every learned name present', [cookie('sid'), cookie('auth')], 'signed_in', 'learned_cookies'],
    ['no learned name present', [cookie('other')], 'signed_out', 'cookies_absent'],
    ['an empty jar', [], 'signed_out', 'cookies_absent'],
    ['some learned names present', [cookie('sid')], 'inconclusive', 'partial_cookies'],
    ['no learned names', [cookie('sid'), cookie('auth')], 'inconclusive', 'no_pack', []],
    [
      'an expired cookie counts absent',
      [cookie('sid'), cookie('auth', '.site-a.test', EARLIER)],
      'inconclusive',
      'partial_cookies',
    ],
    [
      'every cookie expired counts as none',
      [cookie('sid', '.site-a.test', EARLIER), cookie('auth', '.site-a.test', EARLIER)],
      'signed_out',
      'cookies_absent',
    ],
    [
      'an expiry exactly now counts absent',
      [cookie('sid'), cookie('auth', '.site-a.test', NOW_S)],
      'inconclusive',
      'partial_cookies',
    ],
    [
      'session cookies (expires 0 or -1) count present',
      [cookie('sid', '.site-a.test', 0), cookie('auth', '.site-a.test', -1)],
      'signed_in',
      'learned_cookies',
    ],
    [
      'cookies of another registrable domain are ignored',
      [cookie('sid', '.other.test'), cookie('auth', 'evil-site-a.test')],
      'signed_out',
      'cookies_absent',
    ],
    [
      'a sibling domain does not complete the set',
      [cookie('sid'), cookie('auth', '.other.test')],
      'inconclusive',
      'partial_cookies',
    ],
    [
      'www. and leading-dot domains are the site',
      [cookie('sid', 'www.site-a.test'), cookie('auth', '.accounts.site-a.test')],
      'signed_in',
      'learned_cookies',
    ],
    [
      'a host-only cookie on the bare domain counts',
      [cookie('sid', 'site-a.test'), cookie('auth', 'site-a.test')],
      'signed_in',
      'learned_cookies',
    ],
  ];

  for (const [name, jar, outcome, reason, learned] of cases) {
    it(name, () => {
      const site =
        learned === undefined ? SITE : { siteId: SITE.siteId, learnedCookieNames: learned };
      expect(classifyGenericProbe(site, jar, NOW)).toEqual({
        outcome,
        reason,
        finalUrl: null,
      });
    });
  }
});

const UNKNOWN: TemplateSiteHealthRecord = {
  state: 'unknown',
  reason: null,
  checkedAt: null,
  changedAt: null,
  consecutiveInconclusive: 0,
};

describe('healthAfter', () => {
  it('moves changedAt only when the state changes', () => {
    const first = healthAfter(UNKNOWN, { outcome: 'signed_in', reason: 'learned_cookies' }, 1_000);
    expect(first).toEqual({
      state: 'signed_in',
      reason: 'learned_cookies',
      checkedAt: 1_000,
      changedAt: 1_000,
      consecutiveInconclusive: 0,
    });
    const same = healthAfter(first, { outcome: 'signed_in', reason: 'learned_cookies' }, 2_000);
    expect(same).toMatchObject({ checkedAt: 2_000, changedAt: 1_000 });
    const out = healthAfter(same, { outcome: 'signed_out', reason: 'cookies_absent' }, 3_000);
    expect(out).toMatchObject({ state: 'signed_out', checkedAt: 3_000, changedAt: 3_000 });
  });

  it('counts consecutive inconclusive results and resets on a decided one', () => {
    let health = UNKNOWN;
    for (const [i, at] of [10, 20, 30].entries()) {
      health = healthAfter(health, { outcome: 'inconclusive', reason: 'partial_cookies' }, at);
      expect(health.consecutiveInconclusive).toBe(i + 1);
    }
    expect(health.changedAt).toBe(10);
    health = healthAfter(health, { outcome: 'signed_out', reason: 'cookies_absent' }, 40);
    expect(health.consecutiveInconclusive).toBe(0);
    health = healthAfter(health, { outcome: 'inconclusive', reason: 'network' }, 50);
    expect(health).toMatchObject({ consecutiveInconclusive: 1, reason: 'network', changedAt: 50 });
  });
});

describe('staleSites', () => {
  const at = (checkedAt: number | null, extra = {}) =>
    templateSiteRecord({
      siteId: `s${checkedAt ?? 'never'}.test`,
      ...extra,
      health: { ...UNKNOWN, checkedAt },
    });

  it('returns enabled sites never checked or checked longer ago than the max age', () => {
    const sites = [
      at(null),
      at(NOW - 1_000),
      at(NOW - 15 * 60_000),
      at(NOW - 15 * 60_000 - 1),
      at(NOW - 99 * 60_000, { enabled: false }),
    ];
    expect(staleSites(sites, NOW, 15 * 60_000).map((s) => s.health.checkedAt)).toEqual([
      null,
      NOW - 15 * 60_000 - 1,
    ]);
  });
});

describe('isOut, providerOf, sitesOfProvider', () => {
  it('only signed_out and challenged are out', () => {
    expect(isOut('signed_out')).toBe(true);
    expect(isOut('challenged')).toBe(true);
    expect(isOut('signed_in')).toBe(false);
    expect(isOut('inconclusive')).toBe(false);
    expect(isOut('unknown')).toBe(false);
  });

  it('the provider is the site until packs; disabled sites are not covered', () => {
    const a = templateSiteRecord({ siteId: 'a.test' });
    const b = templateSiteRecord({ siteId: 'b.test' });
    const off = templateSiteRecord({ siteId: 'a.test', enabled: false });
    expect(providerOf(a)).toBe('a.test');
    expect(sitesOfProvider([a, b], 'a.test')).toEqual([a]);
    expect(sitesOfProvider([off, b], 'a.test')).toEqual([]);
  });

  it("a pack's identity provider groups its sites (glassdoor.com signs in with indeed.com)", () => {
    const indeed = templateSiteRecord({ siteId: 'indeed.com', packId: 'indeed.com' });
    const glassdoor = templateSiteRecord({ siteId: 'glassdoor.com', packId: 'glassdoor.com' });
    const lookup = (packId: string) => (packId === 'glassdoor.com' ? 'indeed.com' : null);
    expect(providerOf(glassdoor, lookup)).toBe('indeed.com');
    expect(providerOf(glassdoor)).toBe('glassdoor.com');
    expect(sitesOfProvider([indeed, glassdoor], 'indeed.com', lookup)).toEqual([indeed, glassdoor]);
  });
});

describe('jitteredInterval and siteGapMs', () => {
  it('jitters the interval by ±10 %', () => {
    const interval = 6 * 3_600_000;
    expect(jitteredInterval(interval, 0)).toBe(interval * 0.9);
    expect(jitteredInterval(interval, 0.5)).toBe(interval);
    const top = jitteredInterval(interval, 0.999_999_9);
    expect(top).toBeLessThanOrEqual(interval * 1.1);
    expect(top).toBeGreaterThan(interval * 1.099);
    for (let r = 0; r < 1; r += 0.01) {
      const v = jitteredInterval(interval, r);
      expect(v).toBeGreaterThanOrEqual(interval * 0.9);
      expect(v).toBeLessThanOrEqual(interval * 1.1);
    }
  });

  it('spaces sites 5–20 s apart', () => {
    expect(siteGapMs(0)).toBe(5_000);
    expect(siteGapMs(0.5)).toBe(12_500);
    expect(siteGapMs(0.999_999_9)).toBe(20_000);
    for (let r = 0; r < 1; r += 0.01) {
      const v = siteGapMs(r);
      expect(v).toBeGreaterThanOrEqual(5_000);
      expect(v).toBeLessThanOrEqual(20_000);
    }
  });
});
