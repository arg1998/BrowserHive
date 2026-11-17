/** @module domain/site-packs/glob-redos.test — review PR #83 H1 as regression tests: pack globs match in linear time in the request guard and in pack globs, a pack with too many stars is refused at load, and a load with a long probe path stays fast whatever the guards. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  compileRequestGuardRules,
  MAX_GUARD_MATCH_URL,
  matchRequestGuard,
} from '../policies/request-guard.ts';
import { MAX_GLOB_STARS } from './glob-scope.ts';
import { loadPackBytes } from './load.ts';
import { matchesPackGlob } from './pack-glob.ts';
import { refinePack } from './refine.ts';
import { basePack } from './test-fixtures.ts';

const LIMIT_MS = 50;

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('pack globs never backtrack (H1)', () => {
  it.each([
    [2, 2_000],
    [3, 500],
    [4, 200],
    [99, 2 * 1024 * 1024],
  ])(
    'the request guard matches `x.com/` + %i × `*a` + `*b` against %i chars in < 50 ms',
    (k, n) => {
      const glob = `x.com/${'*a'.repeat(k)}*b`.slice(0, 300);
      const rules = compileRequestGuardRules([{ id: 'g', url: glob, action: 'block' }]);
      if (!rules.ok) throw new Error(rules.error.reason);
      const url = `https://x.com/${'a'.repeat(n)}`;
      const ms = timed(() => {
        const match = matchRequestGuard(rules.value, {
          url,
          method: 'GET',
          resourceType: 'document',
        });
        // Under the cap the glob decides (no match); over it the host decides, failing closed (N1).
        expect(match === null).toBe(url.length <= MAX_GUARD_MATCH_URL);
      });
      expect(ms).toBeLessThan(LIMIT_MS);
    },
  );

  it('a page, challenge or redirect glob is as fast (pack-glob)', () => {
    const glob = `x.com/${'*a'.repeat(4)}*b`;
    const short = `https://x.com/${'a'.repeat(MAX_GUARD_MATCH_URL - 20)}`;
    expect(timed(() => expect(matchesPackGlob(glob, short)).toBe(false))).toBeLessThan(LIMIT_MS);
    // A 2 MB URL on the glob's host counts as a match (fail closed, verify #83 N1), still fast.
    const url = `https://x.com/${'a'.repeat(2 * 1024 * 1024)}`;
    expect(timed(() => expect(matchesPackGlob(glob, url)).toBe(true))).toBeLessThan(LIMIT_MS);
  });
});

describe('the star cap (H1)', () => {
  it(`refuses a glob with more than ${MAX_GLOB_STARS} stars or with '**'`, () => {
    const pack = basePack();
    pack.guards = [
      {
        id: 'evil',
        kind: 'logout',
        match: { url: `www.linkedin.com/${'*a'.repeat(5)}*b` },
        action: 'block',
      },
      { id: 'twin', kind: 'logout', match: { url: 'www.linkedin.com/**/out' }, action: 'block' },
    ];
    const { issues } = refinePack(SitePackV1.parse(pack));
    expect(issues).toContainEqual({
      path: 'guards[0].match.url',
      message: `a glob has at most ${MAX_GLOB_STARS} '*'`,
    });
    expect(issues).toContainEqual({ path: 'guards[1].match.url', message: "a glob has no '**'" });
  });

  it('the reviewer’s load-time PoC (5 stars, a 150-char probe path) is refused at once', () => {
    const pack = basePack();
    pack.guards = [
      {
        id: 'evil',
        kind: 'logout',
        match: { url: `www.linkedin.com/${'*a'.repeat(7)}*b` },
        action: 'block',
      },
    ];
    pack.signed_in.probe = { host: 'www.linkedin.com', path: `/${'a'.repeat(150)}` };
    const bytes = new TextEncoder().encode(JSON.stringify(pack));
    let refused = false;
    const ms = timed(() => {
      const result = loadPackBytes(bytes, {
        origin: 'local',
        binaryVersion: null,
        expectedId: 'linkedin.com',
      });
      refused = !result.ok;
    });
    expect(refused).toBe(true);
    expect(ms).toBeLessThan(LIMIT_MS * 4);
  });

  it('a pack at the cap with a 200-char probe path loads fast', () => {
    const pack = basePack();
    pack.guards = [
      ...(pack.guards ?? []),
      {
        id: 'edge',
        kind: 'logout',
        match: { url: `www.linkedin.com/${'*a'.repeat(3)}*b` },
        action: 'block',
      },
    ];
    pack.signed_in.probe = { host: 'www.linkedin.com', path: `/${'a'.repeat(199)}` };
    const ms = timed(() => {
      expect(refinePack(SitePackV1.parse(pack)).issues).toEqual([]);
    });
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});

describe('`?` parts and over-long URLs (verify #83 N1)', () => {
  const twoMb = (prefix: string) => `${prefix}${'a'.repeat(2 * 1024 * 1024)}`;

  it('a glob part full of `?` against a 2 MB URL decides in < 50 ms (guard and pack glob)', () => {
    const glob = `x.com/*${'a?'.repeat(70)}b*${'?a'.repeat(40)}`;
    const rules = compileRequestGuardRules([{ id: 'g', url: glob, action: 'block' }]);
    if (!rules.ok) throw new Error(rules.error.reason);
    const url = twoMb('https://y.com/');
    const elapsed = timed(() => {
      matchRequestGuard(rules.value, { url, method: 'GET', resourceType: 'document' });
      matchesPackGlob(`x.com/*${'a?'.repeat(40)}*`, url);
    });
    expect(elapsed).toBeLessThan(LIMIT_MS);
  });

  it('over the cap a protective guard of the URL host still decides (fail closed)', () => {
    const rules = compileRequestGuardRules([
      { id: 'note', url: 'www.site.test/*/notes', action: 'warn' },
      { id: 'post', url: 'www.site.test/api/*', methods: ['POST'], action: 'confirm' },
      { id: 'logout', url: 'www.site.test/*/logout', action: 'block' },
    ]);
    if (!rules.ok) throw new Error(rules.error.reason);
    const padded = `https://www.site.test/${'p'.repeat(MAX_GUARD_MATCH_URL)}/logout`;
    const get = matchRequestGuard(rules.value, {
      url: padded,
      method: 'GET',
      resourceType: 'document',
    });
    expect(get?.rule.id).toBe('logout');
    const other = `https://other.test/${'p'.repeat(MAX_GUARD_MATCH_URL)}/logout`;
    expect(
      matchRequestGuard(rules.value, { url: other, method: 'GET', resourceType: 'document' }),
    ).toBeNull();
    // Without a `block` rule for the method, a `confirm` one decides; `warn` never does.
    const onlySoft = compileRequestGuardRules([
      { id: 'note', url: 'www.site.test/*', action: 'warn' },
      { id: 'post', url: 'www.site.test/api/*', methods: ['POST'], action: 'confirm' },
    ]);
    if (!onlySoft.ok) throw new Error(onlySoft.error.reason);
    expect(
      matchRequestGuard(onlySoft.value, { url: padded, method: 'POST', resourceType: 'fetch' })
        ?.rule.id,
    ).toBe('post');
    expect(
      matchRequestGuard(onlySoft.value, { url: padded, method: 'GET', resourceType: 'document' }),
    ).toBeNull();
  });

  it('a URL just under the cap is still matched glob by glob', () => {
    const rules = compileRequestGuardRules([
      { id: 'logout', url: 'www.site.test/*/logout', action: 'block' },
    ]);
    if (!rules.ok) throw new Error(rules.error.reason);
    const url = `https://www.site.test/${'p'.repeat(1000)}/home`;
    expect(
      matchRequestGuard(rules.value, { url, method: 'GET', resourceType: 'document' }),
    ).toBeNull();
  });
});
