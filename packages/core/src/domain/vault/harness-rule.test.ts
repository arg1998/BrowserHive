/** @module domain/vault/harness-rule.test — D-48 harness lists, table-driven: no list, an empty list, known slugs (`unknown`, `other`), custom names matched exactly, sessions without a declared name (pre-v7), and binding + group combined. */

import { describe, expect, it } from 'bun:test';
import {
  harnessRuleEntryProblem,
  harnessRuleLookalike,
  isHarnessAllowed,
} from '@browserhive/contracts/harness';
import { checkHarnessRules, normalizeHarnessList } from './harness-rule.ts';

type Subject = { readonly harness: string | null; readonly declared: string | null };

const claude: Subject = { harness: 'claude-code', declared: null };
const opencodeDeclared: Subject = { harness: 'opencode', declared: 'OpenCode' };
const scraper: Subject = { harness: 'nightly-scraper', declared: 'Nightly Scraper' };
const silent: Subject = { harness: 'unknown', declared: null };
/** Created before schema v3: no launch harness at all (reads `unknown`). */
const preV3: Subject = { harness: null, declared: null };
/** Created before schema v7: a launch slug but never a declared name. */
const preV7: Subject = { harness: 'nightly-scraper', declared: null };
const other: Subject = { harness: 'other', declared: 'other' };

describe('isHarnessAllowed (one list)', () => {
  const cases: readonly (readonly [string, readonly string[] | null, Subject, boolean])[] = [
    ['no list allows every harness', null, claude, true],
    ['no list allows unidentified clients', null, silent, true],
    ['an empty list allows nothing', [], claude, false],
    ['an empty list refuses unknown too', [], silent, false],
    ['a known slug matches the launch slug', ['claude-code'], claude, true],
    ['a known slug refuses another harness', ['claude-code'], opencodeDeclared, false],
    ['a known slug matches whatever was declared', ['opencode'], opencodeDeclared, true],
    ['unknown matches an unidentified session', ['unknown'], silent, true],
    ['unknown matches a session from before schema v3', ['unknown'], preV3, true],
    ['unknown does not match an identified one', ['unknown'], claude, false],
    [
      'leaving unknown out refuses unidentified clients',
      ['claude-code', 'opencode'],
      silent,
      false,
    ],
    ['other is a known slug', ['other'], other, true],
    ['a custom name matches the declared name exactly', ['Nightly Scraper'], scraper, true],
    ['a custom name is case-sensitive', ['nightly scraper'], scraper, false],
    ['a custom name is not folded to the slug', ['NIGHTLY SCRAPER'], scraper, false],
    ['a custom name never matches the sanitised slug', ['Nightly-Scraper'], scraper, false],
    ['a slug-shaped custom name is not a known slug', ['nightly-scraper'], scraper, false],
    ['a custom name never matches a session from before v7', ['Nightly Scraper'], preV7, false],
    [
      'a pre-v7 session still matches unknown or known slugs',
      ['unknown', 'claude-code'],
      silent,
      true,
    ],
    [
      'a custom lookalike of a known slug matches only that exact text',
      ['Claude-Code'],
      claude,
      false,
    ],
    [
      'the declared spelling of a lookalike matches when sent',
      ['OpenCode'],
      opencodeDeclared,
      true,
    ],
    ['any entry of the list is enough', ['codex', 'Nightly Scraper'], scraper, true],
  ];
  for (const [name, list, subject, expected] of cases) {
    it(name, () => {
      expect(isHarnessAllowed(list, subject)).toBe(expected);
    });
  }
});

describe('checkHarnessRules (binding + group)', () => {
  const cases: readonly (readonly [
    string,
    { binding: readonly string[] | null; group: readonly string[] | null },
    Subject,
    ReturnType<typeof checkHarnessRules>,
  ])[] = [
    ['no list anywhere', { binding: null, group: null }, claude, { allowed: true }],
    [
      'the group list alone restricts every binding in it',
      { binding: null, group: ['opencode'] },
      claude,
      { allowed: false, rule: 'group' },
    ],
    [
      'the binding list alone restricts',
      { binding: ['opencode'], group: null },
      claude,
      { allowed: false, rule: 'binding' },
    ],
    [
      'both must allow: binding yes, group no',
      { binding: ['claude-code'], group: ['opencode'] },
      claude,
      { allowed: false, rule: 'group' },
    ],
    [
      'both must allow: binding no, group yes (the binding is named first)',
      { binding: ['opencode'], group: ['claude-code'] },
      claude,
      { allowed: false, rule: 'binding' },
    ],
    [
      'both allow',
      { binding: ['claude-code', 'opencode'], group: ['claude-code'] },
      claude,
      { allowed: true },
    ],
    [
      'an empty group list refuses whatever the binding says',
      { binding: null, group: [] },
      claude,
      { allowed: false, rule: 'group' },
    ],
  ];
  for (const [name, rules, subject, expected] of cases) {
    it(name, () => {
      expect(checkHarnessRules(rules, subject)).toEqual(expected);
    });
  }
});

describe('normalizeHarnessList', () => {
  it('keeps null (all) and [] (none) apart', () => {
    expect(normalizeHarnessList(null)).toBeNull();
    expect(normalizeHarnessList(undefined)).toBeNull();
    expect(normalizeHarnessList([])).toEqual([]);
  });

  it('trims, drops blanks and duplicates in order, and keeps case', () => {
    expect(
      normalizeHarnessList([' opencode ', 'Claude-Code', 'opencode', '', 'claude-code']),
    ).toEqual(['opencode', 'Claude-Code', 'claude-code']);
  });
});

describe('editor helpers', () => {
  it('flags a custom name that folds to a built-in harness', () => {
    expect(harnessRuleLookalike('Claude-Code')).toBe('claude-code');
    expect(harnessRuleLookalike('Claude Code')).toBe('claude-code');
    expect(harnessRuleLookalike('claude-code')).toBeNull();
    expect(harnessRuleLookalike('Nightly Scraper')).toBeNull();
  });

  it('names what is wrong with an entry', () => {
    expect(harnessRuleEntryProblem('opencode')).toBeNull();
    expect(harnessRuleEntryProblem('')).not.toBeNull();
    expect(harnessRuleEntryProblem('x'.repeat(65))).not.toBeNull();
    expect(harnessRuleEntryProblem('bad\nname')).not.toBeNull();
  });
});
