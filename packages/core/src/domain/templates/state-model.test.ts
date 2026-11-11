/** @module domain/templates/state-model.test — carry-forward, structure hashing, the summary, checkpoint version reasons, retention with Last good, and the size cap (spec 13 §3.9). */

import { describe, expect, it } from 'bun:test';
import type { TemplateVersionRecord } from '../../ports/persistence/index.ts';
import type { StateCookie, TemplateState } from '../../ports/template-state.ts';
import {
  capState,
  carryForward,
  checkpointVersionReason,
  lastGood,
  prunableVersions,
  signInChanged,
  structureHash,
  summarize,
  withoutDomain,
} from './state-model.ts';

function cookie(name: string, domain: string, value = 'v', expires = -1): StateCookie {
  return { name, value, domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' };
}

const LI_AT = cookie('li_at', '.linkedin.com', 'one', 2_000_000_000);
const BCOOKIE = cookie('bcookie', 'www.linkedin.com');
const ORIGIN_LI = {
  origin: 'https://www.linkedin.com',
  localStorage: [{ name: 'token', value: 'abc' }],
};
const ORIGIN_A = {
  origin: 'https://app.site-a.test',
  localStorage: [{ name: 'auth', value: 'x' }],
};
const BASE: TemplateState = { cookies: [LI_AT, BCOOKIE], origins: [ORIGIN_LI, ORIGIN_A] };

const SIGN_IN = new Map([['linkedin.com', ['li_at', 'JSESSIONID']]]);

function version(n: number, over: Partial<TemplateVersionRecord> = {}): TemplateVersionRecord {
  return {
    templateId: 'tp-aaaaaaaaaa',
    version: n,
    reason: 'manual',
    restoredFrom: null,
    sizeBytes: 1,
    sha256: 'x',
    keyId: 'k',
    structureSha256: 's',
    summary: { domains: [], storageOrigins: 0 },
    health: [{ siteId: 'linkedin.com', state: 'signed_out', enabled: true, signInComplete: null }],
    pinned: false,
    createdBy: 'browserhive',
    createdAt: n,
    ...over,
  };
}

describe('carry-forward (spec 13 §3.9)', () => {
  it('keeps origins this process never visited from the previous checkpoint', () => {
    const snapshot: TemplateState = { cookies: BASE.cookies, origins: [ORIGIN_LI] };
    const merged = carryForward(snapshot, BASE, new Set());
    expect(merged.origins.map((o) => o.origin)).toEqual([
      'https://www.linkedin.com',
      'https://app.site-a.test',
    ]);
  });

  it('never resurrects an origin the process visited (its storage may have been cleared)', () => {
    const snapshot: TemplateState = { cookies: BASE.cookies, origins: [] };
    const merged = carryForward(snapshot, BASE, new Set(['https://app.site-a.test']));
    expect(merged.origins.map((o) => o.origin)).toEqual(['https://www.linkedin.com']);
  });

  it('prefers the snapshot for an origin present in both', () => {
    const fresh = {
      origin: 'https://www.linkedin.com',
      localStorage: [{ name: 'token', value: 'new' }],
    };
    const merged = carryForward({ cookies: [], origins: [fresh] }, BASE, new Set());
    expect(merged.origins.find((o) => o.origin === fresh.origin)).toBe(fresh);
  });

  it('withoutDomain drops cookies and origins of a registrable domain', () => {
    const out = withoutDomain(BASE, 'linkedin.com');
    expect(out.cookies).toEqual([]);
    expect(out.origins.map((o) => o.origin)).toEqual(['https://app.site-a.test']);
  });
});

describe('structure hash (spec 13 §3.9)', () => {
  it('ignores values: a rolled cookie and a changed storage value keep the hash', () => {
    const rolled: TemplateState = {
      cookies: [cookie('li_at', '.linkedin.com', 'two', 2_100_000_000), BCOOKIE],
      origins: [
        { origin: 'https://www.linkedin.com', localStorage: [{ name: 'token', value: 'zzz' }] },
        ORIGIN_A,
      ],
    };
    expect(structureHash(rolled)).toBe(structureHash(BASE));
  });

  it('changes when a cookie name, a storage key or an IndexedDB database appears', () => {
    const h = structureHash(BASE);
    expect(
      structureHash({ ...BASE, cookies: [...BASE.cookies, cookie('new', 'x.test')] }),
    ).not.toBe(h);
    expect(
      structureHash({
        ...BASE,
        origins: [
          ...BASE.origins,
          { origin: 'https://b.test', localStorage: [{ name: 'k', value: '' }] },
        ],
      }),
    ).not.toBe(h);
    expect(
      structureHash({
        ...BASE,
        origins: [{ ...ORIGIN_LI, indexedDB: [{ name: 'db', stores: [] }] }, ORIGIN_A],
      }),
    ).not.toBe(h);
  });

  it('is independent of order', () => {
    const reordered: TemplateState = {
      cookies: [...BASE.cookies].reverse(),
      origins: [...BASE.origins].reverse(),
    };
    expect(structureHash(reordered)).toBe(structureHash(BASE));
  });
});

describe('summary (spec 13 §2.4)', () => {
  it('groups by registrable domain with names, expiry and session cookies, never values', () => {
    const summary = summarize(BASE, SIGN_IN);
    expect(summary).toEqual({
      domains: [
        {
          domain: 'linkedin.com',
          cookies: 2,
          signInCookies: ['li_at'],
          earliestExpiry: 2_000_000_000_000,
          sessionCookie: true,
        },
      ],
      storageOrigins: 2,
    });
    expect(JSON.stringify(summary)).not.toContain('one');
  });
});

describe('checkpoint version reasons (spec 13 §3.9)', () => {
  const summary = summarize(BASE, SIGN_IN);
  const structure = structureHash(BASE);
  const day = Date.UTC(2026, 10, 10, 12);
  const facts = {
    now: day,
    previousCheckpointAt: day - 15 * 60_000,
    summary,
    structure,
    newest: { summary, structureSha256: structure },
    sites: ['linkedin.com'],
    timeZone: 'UTC',
  };

  it('writes nothing for rolling cookies (same names, same structure)', () => {
    expect(checkpointVersionReason(facts)).toBeNull();
  });

  it('writes nothing before the first version', () => {
    expect(checkpointVersionReason({ ...facts, newest: null })).toBeNull();
  });

  it('writes signin_change when a sign-in cookie disappears', () => {
    const gone = summarize({ ...BASE, cookies: [BCOOKIE] }, SIGN_IN);
    expect(checkpointVersionReason({ ...facts, summary: gone })).toBe('signin_change');
    expect(signInChanged(gone, summary, ['linkedin.com'])).toBe(true);
  });

  it('writes daily only at the first checkpoint of a day with a different structure', () => {
    const changed = { ...facts, structure: 'other' };
    expect(checkpointVersionReason(changed)).toBeNull();
    const nextDay = { ...changed, now: day + 86_400_000, previousCheckpointAt: day };
    expect(checkpointVersionReason(nextDay)).toBe('daily');
    expect(checkpointVersionReason({ ...nextDay, structure })).toBeNull();
    expect(checkpointVersionReason({ ...changed, previousCheckpointAt: null })).toBe('daily');
  });
});

describe('retention and Last good (spec 13 §3.9)', () => {
  it('keeps the newest N, pinned versions and Last good', () => {
    const good = [
      { siteId: 'linkedin.com', state: 'signed_in' as const, enabled: true, signInComplete: null },
    ];
    const versions = [
      version(1, { health: good }),
      version(2, { pinned: true }),
      version(3),
      version(4),
      version(5),
      version(6),
    ];
    expect(lastGood(versions)).toBe(1);
    expect([...prunableVersions(versions, 2)].sort()).toEqual([3, 4]);
  });

  it('a disabled site does not keep a version from being Last good', () => {
    const health = [
      { siteId: 'a.test', state: 'signed_in' as const, enabled: true, signInComplete: null },
      { siteId: 'b.test', state: 'signed_out' as const, enabled: false, signInComplete: null },
    ];
    expect(lastGood([version(1, { health }), version(2)])).toBe(1);
  });

  it('keeps everything under the limit', () => {
    expect(prunableVersions([version(1), version(2)], 10)).toEqual([]);
  });
});

describe('size cap (spec 13 §3.9)', () => {
  it('drops IndexedDB data of the largest origins until the state fits', () => {
    const big = 'x'.repeat(5_000);
    const state: TemplateState = {
      cookies: [cookie('a', 'a.test')],
      origins: [
        { origin: 'https://a.test', localStorage: [], indexedDB: [{ name: 'small', data: 'y' }] },
        { origin: 'https://b.test', localStorage: [], indexedDB: [{ name: 'big', data: big }] },
      ],
    };
    const capped = capState(state, 2_000);
    expect(capped.dropped).toEqual(['https://b.test']);
    expect(capped.state.origins[1]?.indexedDB).toBeUndefined();
    expect(capped.state.origins[0]?.indexedDB).toBeDefined();
    expect(capped.sizeBytes).toBeLessThan(2_000);
    expect(capState(state).dropped).toEqual([]);
  });
});

describe('review #79 mutation gaps', () => {
  const good = (siteId: string, complete: boolean | null = true) => ({
    siteId,
    state: 'signed_in' as const,
    enabled: true,
    signInComplete: complete,
  });

  it('signin_change when only one of two sites loses its sign-in cookie', () => {
    const both = summarize(
      { cookies: [cookie('sid', '.a.test'), cookie('bid', '.b.test')], origins: [] },
      new Map([
        ['a.test', ['sid']],
        ['b.test', ['bid']],
      ]),
    );
    const onlyA = summarize(
      { cookies: [cookie('sid', '.a.test')], origins: [] },
      new Map([
        ['a.test', ['sid']],
        ['b.test', ['bid']],
      ]),
    );
    expect(signInChanged(onlyA, both, ['a.test', 'b.test'])).toBe(true);
    expect(signInChanged(onlyA, both, ['a.test'])).toBe(false);
  });

  it('Last good is the newest good version; a missing sign-in cookie or no enabled site is not good', () => {
    expect(
      lastGood([version(1, { health: [good('a')] }), version(3, { health: [good('a')] })]),
    ).toBe(3);
    expect(
      lastGood([version(1, { health: [good('a')] }), version(2, { health: [good('a', false)] })]),
    ).toBe(1);
    expect(lastGood([version(1, { health: [{ ...good('a'), enabled: false }] })])).toBeNull();
    expect(
      lastGood([version(1, { health: [good('a'), { ...good('b', false), enabled: false }] })]),
    ).toBe(1);
  });

  it('retention never deletes or counts a version it cannot read', () => {
    const versions = [version(1), version(2), version(3), version(4)];
    expect([...prunableVersions(versions, 1, (v) => v !== 1)].sort()).toEqual([2, 3]);
  });
});
