/** @module app/config/suggest.test — unit tests for suggest */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS } from '@browserhive/contracts/config';
import { camelFromKebab, damerauLevenshtein, suggest, suggestKey } from './suggest.ts';

describe('damerauLevenshtein', () => {
  it('counts insertions, deletions, substitutions and transpositions', () => {
    expect(damerauLevenshtein('', '')).toBe(0);
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
    expect(damerauLevenshtein('abc', 'abcd')).toBe(1);
    expect(damerauLevenshtein('abcd', 'abc')).toBe(1);
    expect(damerauLevenshtein('abc', 'abd')).toBe(1);
    expect(damerauLevenshtein('abcd', 'abdc')).toBe(1);
    expect(damerauLevenshtein('maxSession', 'maxSessions')).toBe(1);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('suggest', () => {
  it('returns candidates within distance 2, closest first, case-insensitive exact first', () => {
    expect(suggest('maxSession', CONFIG_KEYS)).toEqual(['maxSessions']);
    expect(suggest('maxsessions', CONFIG_KEYS)).toEqual(['maxSessions']);
    expect(suggest('MAXSESSIONS', CONFIG_KEYS)).toEqual(['maxSessions']);
    expect(suggest('completelyDifferent', CONFIG_KEYS)).toEqual([]);
    expect(suggest('ort', ['port', 'host', 'auth'])).toEqual(['port', 'host']);
  });
});

describe('camelFromKebab', () => {
  it('converts kebab and snake case, leaves camelCase alone', () => {
    expect(camelFromKebab('max-sessions')).toBe('maxSessions');
    expect(camelFromKebab('allow_insecure_bind')).toBe('allowInsecureBind');
    expect(camelFromKebab('maxSessions')).toBe('maxSessions');
    expect(camelFromKebab('--')).toBe('');
  });
});

describe('suggestKey', () => {
  it('suggests in the spelling of the source', () => {
    expect(suggestKey('--maxSession', 'cli', CONFIG_KEYS).suggestions).toEqual(['--maxSessions']);
    expect(suggestKey('BROWSERHIVE_MAX_SESSION', 'env', CONFIG_KEYS).suggestions).toEqual([
      'BROWSERHIVE_MAX_SESSIONS',
    ]);
    expect(suggestKey('maxSession', 'json', CONFIG_KEYS).suggestions).toEqual(['maxSessions']);
  });

  it('recognises kebab-case flags and json keys beyond distance 2', () => {
    expect(suggestKey('--allow-insecure-bind', 'cli', CONFIG_KEYS).suggestions).toEqual([
      '--allowInsecureBind',
    ]);
    expect(suggestKey('--max-sessions', 'cli', CONFIG_KEYS).suggestions).toEqual(['--maxSessions']);
    expect(suggestKey('session-lease', 'json', CONFIG_KEYS).suggestions).toEqual(['sessionLease']);
  });

  it('maps unsupported flag spellings to the supported key or marks them removed', () => {
    expect(suggestKey('--pretty-logs', 'cli', CONFIG_KEYS)).toEqual({
      suggestions: ['--logFormat'],
      removed: false,
    });
    expect(suggestKey('BROWSERHIVE_DISABLE_PATCHRIGHT', 'env', CONFIG_KEYS)).toEqual({
      suggestions: ['BROWSERHIVE_STEALTH_DRIVER'],
      removed: false,
    });
    expect(suggestKey('--admin-port', 'cli', CONFIG_KEYS)).toEqual({
      suggestions: [],
      removed: true,
    });
    expect(suggestKey('BROWSERHIVE_ADMIN_BIND', 'env', CONFIG_KEYS).removed).toBe(true);
  });

  it('returns nothing for unrelated names', () => {
    expect(suggestKey('--banana', 'cli', CONFIG_KEYS)).toEqual({ suggestions: [], removed: false });
  });
});
