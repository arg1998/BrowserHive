/** @module domain/templates/sign-ins.test — learned cookie names and unlisted sign-ins (spec 13 §2.3, §7.1). */
import { describe, expect, it } from 'bun:test';
import {
  isAnalyticsCookie,
  jarNames,
  learnedCookieNames,
  MAX_LEARNED_COOKIE_NAMES,
  unlistedDomains,
} from './sign-ins.ts';

const cookie = (
  domain: string,
  name: string,
  extra: Partial<{ expires: number; httpOnly: boolean; secure: boolean }> = {},
) => ({
  name,
  domain,
  expires: 2_000_000_000,
  httpOnly: true,
  secure: true,
  ...extra,
});

describe('learnedCookieNames', () => {
  it('learns the names added on the site since the window opened, without analytics', () => {
    const baseline = jarNames([cookie('.site-a.test', 'pref'), cookie('idp.test', 'x')]);
    const now = [
      cookie('.site-a.test', 'pref'),
      cookie('www.site-a.test', 'sid'),
      cookie('.site-a.test', '_ga'),
      cookie('.site-a.test', '_ga_ABC'),
      cookie('.site-a.test', '__cf_bm'),
      cookie('.site-a.test', 'ajs_user_id'),
      cookie('site-b.test', 'other'),
      cookie('.site-a.test', 'sid'),
    ];
    expect(learnedCookieNames(baseline, now, 'site-a.test')).toEqual(['sid']);
  });

  it('keeps at most 16 names', () => {
    const now = Array.from({ length: 20 }, (_, i) => cookie('site-a.test', `n${i}`));
    expect(learnedCookieNames(new Set(), now, 'site-a.test')).toHaveLength(
      MAX_LEARNED_COOKIE_NAMES,
    );
  });

  it('knows the analytics names of the spec', () => {
    for (const name of [
      '_ga',
      '_gid',
      '_gat_UA',
      '_fbp',
      '_fbc',
      '__cf_bm',
      '_cfuvid',
      '__utmz',
      '_hjSession',
      '_uetsid',
      '_uetvid',
      'ajs_anonymous_id',
    ]) {
      expect([name, isAnalyticsCookie(name)]).toEqual([name, true]);
    }
    for (const name of ['sid', 'session', 'gid', '_gidx'])
      expect([name, isAnalyticsCookie(name)]).toEqual([name, false]);
  });
});

describe('unlistedDomains', () => {
  it('lists signed-in domains that are not sites: persistent, HttpOnly and Secure cookies only', () => {
    const jar = [
      cookie('.site-a.test', 'sid'),
      cookie('.idp.test', 'idp_session'),
      cookie('www.cdn-a.test', 'session-only', { expires: -1 }),
      cookie('tracker.test', 'js-readable', { httpOnly: false }),
      cookie('plain.test', 'insecure', { secure: false }),
      cookie('127.0.0.1', 'local'),
    ];
    expect(unlistedDomains(jar, ['site-a.test'])).toEqual(['idp.test']);
  });
});
