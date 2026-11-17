/** @module domain/templates/sign-ins.test — learned cookie names, a pack site signed in by its cookies, and unlisted sign-ins (spec 13 §2.3, §7.1): the owner's LinkedIn jar (ad and anti-bot cookies of embedded frames) lists nothing; a domain the operator opened and signed in to is listed. */
import { describe, expect, it } from 'bun:test';
import {
  isAnalyticsCookie,
  jarExpiries,
  jarNames,
  learnedCookieNames,
  MAX_LEARNED_COOKIE_NAMES,
  packCookiesChanged,
  packCookiesPresent,
  type UnlistedContext,
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
    for (const name of [
      'IDE',
      'DSID',
      'test_cookie',
      'fr',
      '_GRECAPTCHA',
      'NID',
      'AEC',
      '__Secure-ENID',
      'ar_debug',
      'receive-cookie-deprecation',
    ]) {
      expect([name, isAnalyticsCookie(name)]).toEqual([name, true]);
    }
    for (const name of ['sid', 'session', 'gid', '_gidx', 'li_at', 'SID', 'c_user'])
      expect([name, isAnalyticsCookie(name)]).toEqual([name, false]);
  });
});

const PACKS: Record<string, { domains: string[]; cookieNames: string[] }> = {
  'linkedin.com': { domains: ['linkedin.com', 'licdn.com'], cookieNames: ['li_at', 'liap'] },
  'google.com': { domains: ['google.com'], cookieNames: ['SID', 'HSID'] },
  'facebook.com': { domains: ['facebook.com', 'fbcdn.net'], cookieNames: ['c_user', 'xs'] },
};
const packOf: UnlistedContext['packOf'] = (domain) =>
  Object.values(PACKS).find((p) => p.domains.includes(domain)) ?? null;
const NOW = 1_800_000_000_000;
const context = (visited: readonly string[] = []): UnlistedContext => ({
  packOf,
  visited: new Set(visited),
  now: NOW,
});

/** The owner's jar after signing in to LinkedIn in the recording window (2026-11-17, names only). */
const LINKEDIN_JAR = [
  cookie('.www.linkedin.com', 'li_at'),
  cookie('.linkedin.com', 'liap'),
  cookie('.www.linkedin.com', 'JSESSIONID', { httpOnly: false }),
  cookie('.linkedin.com', 'bcookie', { httpOnly: false }),
  cookie('.doubleclick.net', 'IDE'),
  cookie('www.google.com', '_GRECAPTCHA'),
  cookie('.facebook.com', 'fr'),
];

describe('packCookiesPresent', () => {
  it('needs every pack cookie name, unexpired, on the pack’s domains', () => {
    const pack = PACKS['linkedin.com'] as { domains: string[]; cookieNames: string[] };
    expect(packCookiesPresent(pack, LINKEDIN_JAR, NOW)).toBe(true);
    expect(packCookiesPresent(pack, [cookie('.linkedin.com', 'liap')], NOW)).toBe(false);
    expect(
      packCookiesPresent(
        pack,
        [cookie('.linkedin.com', 'liap'), cookie('.linkedin.com', 'li_at', { expires: 100 })],
        NOW,
      ),
    ).toBe(false);
    expect(
      packCookiesPresent(
        pack,
        [cookie('.other.test', 'li_at'), cookie('.other.test', 'liap')],
        NOW,
      ),
    ).toBe(false);
    expect(packCookiesPresent({ domains: ['x.test'], cookieNames: [] }, LINKEDIN_JAR, NOW)).toBe(
      false,
    );
  });
});

describe('unlistedDomains', () => {
  it('the owner’s LinkedIn jar: the ad and anti-bot cookies of embedded frames list nothing', () => {
    expect(unlistedDomains(LINKEDIN_JAR, ['linkedin.com'], context())).toEqual([]);
    // Even had the window opened those domains as pages, ad names and ad domains never count.
    expect(
      unlistedDomains(
        LINKEDIN_JAR,
        ['linkedin.com'],
        context(['doubleclick.net', 'google.com', 'facebook.com']),
      ),
    ).toEqual([]);
  });

  it('lists a pack domain whose sign-in cookies are present (the operator signed in to Google)', () => {
    const jar = [...LINKEDIN_JAR, cookie('.google.com', 'SID'), cookie('.google.com', 'HSID')];
    expect(unlistedDomains(jar, ['linkedin.com'], context())).toEqual(['google.com']);
    // Only one of the two names: not a sign-in.
    expect(
      unlistedDomains([...LINKEDIN_JAR, cookie('.google.com', 'SID')], ['linkedin.com'], context()),
    ).toEqual([]);
  });

  it('never lists a pack’s other domain when the pack’s site is a site of the template', () => {
    const jar = [cookie('.licdn.com', 'li_at'), cookie('.licdn.com', 'liap'), ...LINKEDIN_JAR];
    expect(unlistedDomains(jar, ['linkedin.com'], context(['licdn.com']))).toEqual([]);
  });

  it('lists a domain without a pack only when a window opened it and it holds a sign-in cookie', () => {
    const jar = [
      cookie('.site-a.test', 'sid'),
      cookie('.idp.test', 'idp_session'),
      cookie('.embedded.test', 'tracker_session'),
      cookie('www.cdn-a.test', 'session-only', { expires: -1 }),
      cookie('tracker.test', 'js-readable', { httpOnly: false }),
      cookie('plain.test', 'insecure', { secure: false }),
      cookie('127.0.0.1', 'local'),
    ];
    const visited = ['idp.test', 'cdn-a.test', 'tracker.test', 'plain.test'];
    expect(unlistedDomains(jar, ['site-a.test'], context(visited))).toEqual(['idp.test']);
    expect(unlistedDomains(jar, ['site-a.test'], context())).toEqual([]);
  });

  it('never lists an ad or tracking domain, even opened as a page with a sign-in-shaped cookie', () => {
    const jar = [cookie('.doubleclick.net', 'session_id'), cookie('.adnxs.com', 'sess')];
    expect(
      unlistedDomains(jar, ['linkedin.com'], context(['doubleclick.net', 'adnxs.com'])),
    ).toEqual([]);
    // The same cookie on an ordinary domain the window opened is a sign-in.
    expect(
      unlistedDomains(
        [cookie('.mail.test', 'session_id')],
        ['linkedin.com'],
        context(['mail.test']),
      ),
    ).toEqual(['mail.test']);
  });

  it('a pack domain without the pack’s full set still counts when the window opened it (review #85 L1)', () => {
    const jar = [cookie('.google.com', 'SID'), cookie('.google.com', '__Secure-1PSID')];
    expect(unlistedDomains(jar, ['linkedin.com'], context())).toEqual([]);
    expect(unlistedDomains(jar, ['linkedin.com'], context(['google.com']))).toEqual(['google.com']);
  });
});

describe('packCookiesChanged (review #85 H2)', () => {
  const pack = PACKS['linkedin.com'] as { domains: string[]; cookieNames: string[] };
  it('a sign-in cookie that appeared or was set again since the window opened', () => {
    const before = [cookie('.linkedin.com', 'liap'), cookie('.www.linkedin.com', 'li_at')];
    const baseline = jarExpiries(before);
    expect(packCookiesChanged(pack, baseline, before)).toBe(false);
    expect(packCookiesChanged(pack, jarExpiries([before[0] as never]), before)).toBe(true);
    expect(
      packCookiesChanged(pack, baseline, [
        before[0] as never,
        cookie('.www.linkedin.com', 'li_at', { expires: 2_000_000_600 }),
      ]),
    ).toBe(true);
    // Other cookies changing say nothing; no baseline proves nothing.
    expect(
      packCookiesChanged(pack, baseline, [...before, cookie('.linkedin.com', 'bcookie')]),
    ).toBe(false);
    expect(packCookiesChanged(pack, undefined, before)).toBe(false);
  });
});
