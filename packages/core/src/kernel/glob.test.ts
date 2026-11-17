/** @module kernel/glob.test — anchored glob semantics. */

import { describe, expect, it } from 'bun:test';
import {
  compileGlob,
  compileGlobTokens,
  globTokens,
  globTokensIntersect,
  hasGlobWildcard,
  MAX_PATTERN_LENGTH,
  matchesCompiledGlob,
  matchesGlob,
} from './glob.ts';

describe('matchesGlob', () => {
  it('is anchored and whole-string', () => {
    expect(matchesGlob('agent-1', 'agent-*')).toBe(true);
    expect(matchesGlob('agent-checkout', 'agent-*')).toBe(true);
    expect(matchesGlob('agentx', 'agent-*')).toBe(false);
    expect(matchesGlob('other-agent-1', 'agent-*')).toBe(false);
  });

  it('treats * as zero-or-more and ? as exactly one', () => {
    expect(matchesGlob('', '*')).toBe(true);
    expect(matchesGlob('anything', '*')).toBe(true);
    expect(matchesGlob('ab', 'a?')).toBe(true);
    expect(matchesGlob('a', 'a?')).toBe(false);
    expect(matchesGlob('abc', 'a?')).toBe(false);
  });

  it('treats every other character as a literal', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('axb', 'a.b')).toBe(false);
    expect(matchesGlob('(x)[y]{z}+^$|\\', '(x)[y]{z}+^$|\\')).toBe(true);
  });

  it('no-wildcard patterns are equality; empty matches only empty', () => {
    expect(matchesGlob('foo', 'foo')).toBe(true);
    expect(matchesGlob('foo ', 'foo')).toBe(false);
    expect(matchesGlob('', '')).toBe(true);
    expect(matchesGlob('x', '')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(matchesGlob('Foo', 'foo')).toBe(false);
  });

  it('fails closed on over-long patterns', () => {
    expect(matchesGlob('x', `${'*'.repeat(MAX_PATTERN_LENGTH)}*`)).toBe(false);
  });

  it.each([
    ['a*b*c', 'abc', true],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'acb', false],
    ['*a*', 'bab', true],
    ['*ab', 'aab', true],
    ['ab*ab', 'ab', false],
    ['ab*ab', 'abab', true],
    ['a?c*', 'abcdef', true],
    ['*?b', 'b', false],
    ['*?b', 'ab', true],
    ['x*y?z*w', 'xyzw', false],
    ['x*y?z*w', 'xQyQzRw', true],
    ['**', '', true],
    ['*.example.com', 'a.b.example.com', true],
    ['*.example.com', 'example.com', false],
  ] as const)('%s against %s is %p (no regular expression)', (pattern, value, expected) => {
    expect(matchesGlob(value, pattern)).toBe(expected);
  });

  it('extends a pattern with literal characters (a literal `?` and a star)', () => {
    const glob = compileGlobTokens([
      ...globTokens('site.test/logout'),
      { kind: 'char', char: '?' },
      { kind: 'star' },
    ]);
    expect(matchesCompiledGlob(glob, 'site.test/logout?next=/')).toBe(true);
    expect(matchesCompiledGlob(glob, 'site.test/logoutx')).toBe(false);
  });

  it('runs in linear time whatever the stars (review PR #83 H1)', () => {
    // The reviewer's worst case: a 300-character glob of 100 stars against a 2 MB URL.
    const glob = compileGlob(`x.com/${'*a'.repeat(99)}*b`.slice(0, 300));
    const url = `x.com/${'a'.repeat(2 * 1024 * 1024)}`;
    const started = performance.now();
    expect(matchesCompiledGlob(glob, url)).toBe(false);
    expect(matchesGlob(url, `x.com/${'*a'.repeat(99)}*b`.slice(0, 300))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('hasGlobWildcard', () => {
    expect(hasGlobWildcard('a*')).toBe(true);
    expect(hasGlobWildcard('a?')).toBe(true);
    expect(hasGlobWildcard('abc')).toBe(false);
  });
});

describe('globTokensIntersect', () => {
  const meet = (a: string, b: string) => globTokensIntersect(globTokens(a), globTokens(b));
  it('is true exactly when some string matches both patterns', () => {
    expect(meet('abc', 'abc')).toBe(true);
    expect(meet('abc', 'abd')).toBe(false);
    expect(meet('a*', '*c')).toBe(true);
    expect(meet('a*b', 'a*c')).toBe(false);
    expect(meet('a?c', 'abc')).toBe(true);
    expect(meet('a?c', 'ac')).toBe(false);
    expect(meet('*x*', '*y*')).toBe(true);
    expect(meet('/session', '/sessions/*')).toBe(false);
    expect(meet('/sessions/*', '/sessions/two-factor')).toBe(true);
    expect(meet('*', '')).toBe(true);
    expect(meet('?', '')).toBe(false);
    expect(meet('', '')).toBe(true);
  });

  it('agrees with matchesGlob on a witness and stays fast with many stars', () => {
    expect(meet('a*b*c', '*b*')).toBe(true);
    expect(matchesGlob('abc', 'a*b*c') && matchesGlob('abc', '*b*')).toBe(true);
    const long = `${'*a'.repeat(150)}`;
    const started = performance.now();
    expect(meet(long, `${'a*'.repeat(150)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
