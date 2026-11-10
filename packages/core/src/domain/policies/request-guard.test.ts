/** @module domain/policies/request-guard.test — the request guard's rule compiler, its method × resource type × URL matcher table and the atomic holder (spec 13 §9.3). */

import { describe, expect, it } from 'bun:test';
import {
  compileRequestGuardRules,
  DEFAULT_GUARD_RESOURCE_TYPES,
  EMPTY_REQUEST_GUARD_RULES,
  type GuardedRequest,
  matchRequestGuard,
  type RequestGuardRuleInput,
  RequestGuardRuleSet,
  type RequestGuardRules,
} from './request-guard.ts';

function compiled(...inputs: RequestGuardRuleInput[]): RequestGuardRules {
  const result = compileRequestGuardRules(inputs);
  if (!result.ok) throw new Error(`bad fixture: ${result.error.reason}`);
  return result.value;
}

const req = (method: string, resourceType: string, url: string): GuardedRequest => ({
  method,
  resourceType,
  url,
});

describe('matchRequestGuard', () => {
  const rules = compiled(
    { id: 'logout-post', url: 'site.test/logout', methods: ['POST'], action: 'block' },
    {
      id: 'beacon-only',
      url: 'site.test/api/track',
      resourceTypes: ['ping'],
      action: 'warn',
    },
    { id: 'delete-any', url: '*.site.test/api/delete*', action: 'confirm' },
    {
      id: 'stream',
      url: 'site.test/events',
      resourceTypes: ['eventsource', 'other'],
      action: 'block',
    },
  );

  // [method, resource type, url, expected rule id or null]
  const TABLE: ReadonlyArray<readonly [string, string, string, string | null]> = [
    // A POST form logout and a fetch POST are matched; the GET confirm page is not.
    ['POST', 'document', 'https://site.test/logout', 'logout-post'],
    ['POST', 'fetch', 'https://site.test/logout', 'logout-post'],
    ['POST', 'xhr', 'http://site.test/logout', 'logout-post'],
    ['POST', 'ping', 'https://site.test/logout', 'logout-post'],
    ['GET', 'document', 'https://site.test/logout', null],
    ['post', 'fetch', 'https://SITE.test/LOGOUT', 'logout-post'],
    // The implicit `/*` suffix of the spec 11 §5 grammar covers paths beneath; for guards a
    // pattern not ending in `*` also covers the same path with any query (spec 13 §9.3).
    ['POST', 'fetch', 'https://site.test/logout/now', 'logout-post'],
    ['POST', 'fetch', 'https://site.test/logout?next=/', 'logout-post'],
    ['POST', 'document', 'https://site.test/logout?', 'logout-post'],
    ['POST', 'fetch', 'https://site.test/logout/now?x=1', 'logout-post'],
    // ...but not a longer path, and `?` in the pattern stays a one-character wildcard.
    ['POST', 'fetch', 'https://site.test/logout-help', null],
    ['POST', 'fetch', 'https://site.test/logoutpage', null],
    ['POST', 'fetch', 'https://site.test/logoutx?y=1', null],
    // Percent-encoded unreserved characters are what the server decodes them to.
    ['POST', 'fetch', 'https://site.test/log%6Fut', 'logout-post'],
    ['POST', 'fetch', 'https://site.test/LOG%4Fut?next=1', 'logout-post'],
    // A reserved character stays encoded: `%2F` is not a path separator.
    ['POST', 'fetch', 'https://site.test/logout%2Fnow', null],
    // Types outside the default set are not covered by a rule without resource types.
    ['POST', 'image', 'https://site.test/logout', null],
    ['POST', 'script', 'https://site.test/logout', null],
    ['POST', 'eventsource', 'https://site.test/logout', null],
    ['POST', 'other', 'https://site.test/logout', null],
    // A beacon-only rule matches beacons of any method, and nothing else.
    ['POST', 'ping', 'https://site.test/api/track', 'beacon-only'],
    ['GET', 'ping', 'https://site.test/api/track', 'beacon-only'],
    ['POST', 'fetch', 'https://site.test/api/track', null],
    // No `methods`: every method, including ones a rule cannot name.
    ['DELETE', 'fetch', 'https://www.site.test/api/delete/7', 'delete-any'],
    ['HEAD', 'xhr', 'https://www.site.test/api/delete', 'delete-any'],
    ['OPTIONS', 'document', 'https://a.site.test/api/delete?x=1', 'delete-any'],
    ['DELETE', 'fetch', 'https://site.test/api/delete', null],
    // Named non-default types.
    ['GET', 'eventsource', 'https://site.test/events', 'stream'],
    ['GET', 'other', 'https://site.test/events', 'stream'],
    ['GET', 'fetch', 'https://site.test/events', null],
    // Non-network and unparseable URLs match nothing (fail-open, as the blocklist).
    ['POST', 'document', 'about:blank', null],
    ['POST', 'fetch', 'data:text/plain,site.test/logout', null],
    ['POST', 'fetch', 'blob:https://site.test/0000', null],
    ['POST', 'fetch', 'not a url', null],
    // Another host.
    ['POST', 'fetch', 'https://other.test/logout', null],
  ];

  for (const [method, type, url, expected] of TABLE) {
    it(`${method} ${type} ${url} → ${expected ?? 'no match'}`, () => {
      expect(matchRequestGuard(rules, req(method, type, url))?.rule.id ?? null).toBe(expected);
    });
  }

  it('the first matching rule decides', () => {
    const ordered = compiled(
      { id: 'allow-first', url: 'site.test/api/*', methods: ['POST'], action: 'allow' },
      { id: 'block-later', url: 'site.test/api/logout', action: 'block' },
    );
    const hit = matchRequestGuard(ordered, req('POST', 'fetch', 'https://site.test/api/logout'));
    expect(hit?.rule.id).toBe('allow-first');
    expect(hit?.rule.action).toBe('allow');
    const get = matchRequestGuard(ordered, req('GET', 'fetch', 'https://site.test/api/logout'));
    expect(get?.rule.id).toBe('block-later');
  });

  it('reports the comparison form that matched', () => {
    const scheme = compiled({ id: 'https-only', url: 'https://site.test/x', action: 'block' });
    expect(matchRequestGuard(scheme, req('GET', 'document', 'https://site.test/x'))?.matched).toBe(
      'https://site.test/x',
    );
    expect(matchRequestGuard(scheme, req('GET', 'document', 'http://site.test/x'))).toBeNull();
  });

  it('an empty rule list never matches', () => {
    expect(
      matchRequestGuard(EMPTY_REQUEST_GUARD_RULES, req('POST', 'fetch', 'https://a.test/')),
    ).toBeNull();
  });

  it('defaults to document, xhr, fetch and ping', () => {
    expect([...DEFAULT_GUARD_RESOURCE_TYPES]).toEqual(['document', 'xhr', 'fetch', 'ping']);
    const rule = compiled({ id: 'r', url: 'a.test', action: 'block' }).rules[0];
    expect([...(rule?.resourceTypes ?? [])]).toEqual(['document', 'xhr', 'fetch', 'ping']);
    expect(rule?.methods).toBeNull();
  });

  it('compiles matchers once per rule set', () => {
    const rule = compiled({ id: 'r', url: 'a.test/x*', action: 'block' }).rules[0];
    expect(rule?.matchers).toHaveLength(1);
    const plain = compiled({ id: 'r', url: 'a.test/x', action: 'block' }).rules[0];
    expect(plain?.matchers.map((m) => m.kind)).toEqual(['equals', 'regexp', 'regexp']);
  });

  it('a pattern with wildcards still gets the query variant', () => {
    const wild = compiled({ id: 'w', url: '*.site.test/api/?/delete', action: 'block' });
    const at = (url: string) => matchRequestGuard(wild, req('POST', 'fetch', url))?.rule.id ?? null;
    expect(at('https://a.site.test/api/7/delete')).toBe('w');
    expect(at('https://a.site.test/api/7/delete?id=1')).toBe('w');
    expect(at('https://a.site.test/api/7/deleted')).toBeNull();
  });
});

describe('compileRequestGuardRules', () => {
  const REFUSED: ReadonlyArray<readonly [RequestGuardRuleInput, string]> = [
    [{ id: 'Bad', url: 'a.test', action: 'block' }, 'id must be a lowercase slug'],
    [{ id: '', url: 'a.test', action: 'block' }, 'id must be a lowercase slug'],
    [{ id: 'r', url: '  ', action: 'block' }, 'url is empty'],
    [{ id: 'r', url: '*', action: 'block' }, 'url matches every URL'],
    [{ id: 'r', url: '*/*', action: 'block' }, 'url matches every URL'],
    [{ id: 'r', url: `a.test/${'x'.repeat(300)}`, action: 'block' }, 'url is too long'],
    [
      { id: 'r', url: 'a.test', methods: [], action: 'block' },
      'methods must be a non-empty list of known methods',
    ],
    [
      // A rule source with unchecked data.
      { id: 'r', url: 'a.test', methods: ['HEAD' as 'GET'], action: 'block' },
      'methods must be a non-empty list of known methods',
    ],
    [
      { id: 'r', url: 'a.test', resourceTypes: [], action: 'block' },
      'resource types must be a non-empty list of known types',
    ],
    [
      { id: 'r', url: 'a.test', resourceTypes: ['image' as 'other'], action: 'block' },
      'resource types must be a non-empty list of known types',
    ],
    [
      // A pack's `write_policy` must be resolved before a rule reaches the guard.
      { id: 'r', url: 'a.test', action: 'write_policy' as 'block' },
      'action must be block, confirm, warn or allow',
    ],
    [
      { id: 'r', url: 'bücher.test/logout', action: 'block' },
      'url must be printable ASCII (punycode hosts, percent-encoded paths)',
    ],
    [
      { id: 'r', url: 'a.test/two words', action: 'block' },
      'url must be printable ASCII (punycode hosts, percent-encoded paths)',
    ],
  ];

  for (const [input, reason] of REFUSED) {
    it(`refuses ${JSON.stringify(input).slice(0, 80)}: ${reason}`, () => {
      const result = compileRequestGuardRules([{ id: 'ok', url: 'b.test', action: 'warn' }, input]);
      expect(result).toEqual({ ok: false, error: { index: 1, id: input.id, reason } });
    });
  }

  it('refuses a duplicate id', () => {
    const result = compileRequestGuardRules([
      { id: 'same', url: 'a.test', action: 'block' },
      { id: 'same', url: 'b.test', action: 'block' },
    ]);
    expect(result).toEqual({ ok: false, error: { index: 1, id: 'same', reason: 'duplicate id' } });
  });

  it('lowercases and trims the URL glob and accepts pack-qualified ids', () => {
    const rules = compiled({
      id: 'site-a.test#logout',
      url: ' Site-A.test/Logout ',
      action: 'block',
    });
    expect(rules.rules[0]?.url).toBe('site-a.test/logout');
    expect(rules.rules[0]?.id).toBe('site-a.test#logout');
  });
});

describe('RequestGuardRuleSet', () => {
  it('answers every URL with the current list and swaps it atomically', () => {
    const set = new RequestGuardRuleSet();
    expect(set.rulesFor('https://a.test/').rules).toEqual([]);
    const next = compiled({ id: 'r', url: 'a.test', action: 'block' });
    set.replace(next);
    expect(set.rulesFor('https://a.test/')).toBe(next);
    expect(set.rulesFor('https://other.test/')).toBe(next);
  });
});
