/** @module kernel/glob.test — anchored glob semantics. */

import { describe, expect, it } from 'bun:test';
import { globToRegExp, hasGlobWildcard, MAX_PATTERN_LENGTH, matchesGlob } from './glob.ts';

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

  it('compiles to an anchored regexp with no flags', () => {
    const re = globToRegExp('*.example.com');
    expect(re.source).toBe('^.*\\.example\\.com$');
    expect(re.flags).toBe('');
  });

  it('hasGlobWildcard', () => {
    expect(hasGlobWildcard('a*')).toBe(true);
    expect(hasGlobWildcard('a?')).toBe(true);
    expect(hasGlobWildcard('abc')).toBe(false);
  });
});
