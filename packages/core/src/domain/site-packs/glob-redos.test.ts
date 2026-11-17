/** @module domain/site-packs/glob-redos.test — review PR #83 H1 as regression tests: pack globs match in linear time in the request guard and in pack globs, a pack with too many stars is refused at load, and a load with a long probe path stays fast whatever the guards. */

import { describe, expect, it } from 'bun:test';
import { compileRequestGuardRules, matchRequestGuard } from '../policies/request-guard.ts';
import { MAX_GLOB_STARS } from './glob-scope.ts';
import { loadPackBytes } from './load.ts';
import { matchesPackGlob } from './pack-glob.ts';
import { refinePack } from './refine.ts';
import { basePack } from './test-fixtures.ts';
import { SitePackV1 } from '@browserhive/contracts/site-packs';

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
  ])('the request guard matches `x.com/` + %i × `*a` + `*b` against %i chars in < 50 ms', (k, n) => {
    const glob = `x.com/${'*a'.repeat(k)}*b`.slice(0, 300);
    const rules = compileRequestGuardRules([{ id: 'g', url: glob, action: 'block' }]);
    if (!rules.ok) throw new Error(rules.error.reason);
    const url = `https://x.com/${'a'.repeat(n)}`;
    const ms = timed(() => {
      expect(matchRequestGuard(rules.value, { url, method: 'GET', resourceType: 'document' })).toBe(
        null,
      );
    });
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('a page, challenge or redirect glob is as fast (pack-glob)', () => {
    const glob = `x.com/${'*a'.repeat(4)}*b`;
    const url = `https://x.com/${'a'.repeat(2 * 1024 * 1024)}`;
    expect(timed(() => expect(matchesPackGlob(glob, url)).toBe(false))).toBeLessThan(LIMIT_MS);
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
