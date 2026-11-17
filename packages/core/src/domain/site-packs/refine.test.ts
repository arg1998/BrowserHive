/** @module domain/site-packs/refine.test — the pack refinements and the malicious-pack corpus (spec 13 §9.10, §14 "Pack data never executes"): every abuse row is refused, or rendered inert by construction (asserted where it is a refinement). */

import { describe, expect, it } from 'bun:test';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { SitePackSkipReasonValue as SkipReason } from '../../ports/site-packs.ts';
import { loadPackBytes } from './load.ts';
import { compareSemver, refinePack } from './refine.ts';
import { basePack } from './test-fixtures.ts';

function refineInput(input: SitePackV1Input) {
  return refinePack(SitePackV1.parse(input));
}

function issuePaths(input: SitePackV1Input): string[] {
  return refineInput(input).issues.map((i) => i.path);
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const LOAD = { origin: 'test', binaryVersion: '0.3.0', expectedId: null } as const;

describe('refinePack', () => {
  it('accepts the base pack with no issues', () => {
    expect(refineInput(basePack())).toEqual({ issues: [], warnings: [] });
  });

  it('warns when an element guard names no request guard', () => {
    const p = basePack();
    const eg = p.element_guards?.[0];
    if (eg !== undefined) delete eg.request_guard;
    expect(refineInput(p).warnings).toHaveLength(1);
  });

  // The malicious-pack corpus (spec 13 §9.10), one case per abuse row.
  const corpus: [string, (p: SitePackV1Input) => void, string][] = [
    [
      'sign-in URL on a look-alike domain',
      (p) => {
        if (p.sign_in) p.sign_in.url.host = 'linkedin.com.evil.io';
      },
      'sign_in.url.host',
    ],
    [
      'probe on another site',
      (p) => {
        p.signed_in.probe.host = 'evil.io';
      },
      'signed_in.probe.host',
    ],
    [
      'probe path matched by its own logout guard',
      (p) => {
        p.signed_in.probe.path = '/m/logout';
      },
      'signed_in.probe',
    ],
    [
      'probe path under a methodless account guard',
      (p) => {
        p.guards?.push({
          id: 'acct',
          kind: 'account',
          match: { url: 'www.linkedin.com/feed*' },
          action: 'block',
        });
      },
      'signed_in.probe',
    ],
    [
      'keeper path is a logout',
      (p) => {
        p.keeper = { interval_hours: 24, path: '/m/logout' };
      },
      'keeper.path',
    ],
    [
      'entry-warmup path is a logout',
      (p) => {
        p.strategies = [{ id: 'entry-warmup', params: { path: '/m/logout/now' } }];
      },
      'strategies[0].params.path',
    ],
    [
      'entry-warmup path with a query',
      (p) => {
        p.strategies = [{ id: 'entry-warmup', params: { path: '/go?to=/m/logout' } }];
      },
      'strategies[0].params.path',
    ],
    [
      'guard on another site',
      (p) => {
        p.guards?.push({
          id: 'g',
          kind: 'account',
          match: { url: 'accounts.google.com/*' },
          action: 'block',
        });
      },
      'guards[3].match.url',
    ],
    [
      'guard with a wildcard registrable domain',
      (p) => {
        p.guards?.push({ id: 'g', kind: 'account', match: { url: '*.com/x' }, action: 'block' });
      },
      'guards[3].match.url',
    ],
    [
      'guard with a wildcard inside the domain label',
      (p) => {
        p.guards?.push({
          id: 'g',
          kind: 'account',
          match: { url: '*linkedin.com/x' },
          action: 'block',
        });
      },
      'guards[3].match.url',
    ],
    [
      'guard with a scheme',
      (p) => {
        p.guards?.push({
          id: 'g',
          kind: 'account',
          match: { url: 'https://www.linkedin.com/x' },
          action: 'block',
        });
      },
      'guards[3].match.url',
    ],
    [
      'guard with a Unicode host',
      (p) => {
        p.guards?.push({
          id: 'g',
          kind: 'account',
          match: { url: 'www.lіnkedin.com/x' },
          action: 'block',
        });
      },
      'guards[3].match.url',
    ],
    [
      'write_policy on a logout guard',
      (p) => {
        p.guards?.push({
          id: 'g',
          kind: 'logout',
          match: { url: 'www.linkedin.com/x' },
          action: 'write_policy',
        });
      },
      'guards[3].action',
    ],
    [
      'duplicate guard ids',
      (p) => {
        p.guards?.push({
          id: 'logout',
          kind: 'logout',
          match: { url: 'www.linkedin.com/y' },
          action: 'block',
        });
      },
      'guards[3].id',
    ],
    [
      'element guard naming a missing request guard',
      (p) => {
        const e = p.element_guards?.[0];
        if (e) e.request_guard = 'nope';
      },
      'element_guards[0].request_guard',
    ],
    [
      'selector with :text-matches (a regular expression)',
      (p) => {
        const e = p.element_guards?.[0];
        if (e) e.target = { selector: 'a:text-matches("(a+)+$")' };
      },
      'element_guards[0].target.selector',
    ],
    [
      'selector with an engine prefix',
      (p) => {
        p.signed_in.landmark = 'xpath=//div';
      },
      'signed_in.landmark',
    ],
    [
      'selector chain',
      (p) => {
        p.signed_in.signed_out_marker = 'div >> text=Sign in';
      },
      'signed_in.signed_out_marker',
    ],
    [
      'challenge matching nothing',
      (p) => {
        p.challenges?.push({ id: 'c', kind: 'captcha', match: {}, action: 'attention' });
      },
      'challenges[1].match',
    ],
    [
      'challenge URL on another site',
      (p) => {
        p.challenges?.push({
          id: 'c',
          kind: 'captcha',
          match: { url: 'evil.io/*' },
          action: 'attention',
        });
      },
      'challenges[1].match.url',
    ],
    [
      'pace limit above the ceiling',
      (p) => {
        const r = p.pacing?.rules?.[0];
        if (r) {
          r.per = 'minute';
          r.limit = 61;
        }
      },
      'pacing.rules[0].limit',
    ],
    [
      'pace rule on a non-write guard',
      (p) => {
        const r = p.pacing?.rules?.[0];
        if (r) r.guard = 'logout';
      },
      'pacing.rules[0].guard',
    ],
    [
      'loose default against the stance',
      (p) => {
        p.write_policy.default = 'allow';
      },
      'write_policy.default',
    ],
    [
      'domains[0] is not the id',
      (p) => {
        p.domains = ['licdn.com', 'linkedin.com'];
      },
      'domains[0]',
    ],
    [
      'a public suffix as a domain',
      (p) => {
        p.domains = ['linkedin.com', 'co.uk'];
      },
      'domains[1]',
    ],
    [
      'a subdomain as a domain',
      (p) => {
        p.domains = ['linkedin.com', 'www.licdn.com'];
      },
      'domains[1]',
    ],
    [
      'form selectors with human_only',
      (p) => {
        p.sign_in = {
          url: { host: 'www.linkedin.com', path: '/login' },
          human_only: true,
          form: { username: '#u', password: '#p' },
        };
      },
      'sign_in.form',
    ],
    [
      'redirect probe without redirects',
      (p) => {
        p.signed_in.signed_out_redirects = [];
      },
      'signed_in.kind',
    ],
    [
      'no sign-in and no identity provider',
      (p) => {
        delete p.sign_in;
      },
      'sign_in',
    ],
  ];
  for (const [name, mutate, path] of corpus) {
    it(`refuses: ${name}`, () => {
      const p = basePack();
      mutate(p);
      expect(issuePaths(p)).toContain(path);
    });
  }

  it('allows a method-restricted guard on the probe path (Reddit: GET probe, form posts guarded)', () => {
    const p = basePack();
    p.guards?.push({
      id: 'acct',
      kind: 'account',
      match: { url: 'www.linkedin.com/feed*', methods: ['POST'] },
      action: 'confirm',
    });
    expect(issuePaths(p)).toEqual([]);
  });

  it('accepts a stance exception with its reason', () => {
    const p = basePack();
    p.write_policy = {
      default: 'warn',
      stance: 'prohibited',
      exception: 'Only reads are automated on this site.',
    };
    expect(issuePaths(p)).toEqual([]);
  });
});

describe('loadPackBytes', () => {
  it('loads a valid pack with its hash', () => {
    const result = loadPackBytes(bytes(basePack()), LOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.value.pack.browser).toEqual({ channel: 'any', headed: 'any' });
    }
  });

  const refused: [string, unknown, SkipReason][] = [
    ['an unknown key (strict schema)', { ...basePack(), script: 'alert(1)' }, 'invalid'],
    ['launch arguments', { ...basePack(), launch_args: ['--remote-debugging-port=1'] }, 'invalid'],
    [
      'an unknown strategy',
      { ...basePack(), strategies: [{ id: 'run-js', params: {} }] },
      'unknown_strategy',
    ],
    ['a newer client', { ...basePack(), min_client: '9.0.0' }, 'min_client'],
    [
      'a version past max_client',
      { ...basePack(), min_client: '0.1.0', max_client: '0.2.9' },
      'min_client',
    ],
    [
      'a concurrency above the bound',
      {
        ...basePack(),
        concurrency: { max_sessions: 50, source: { url: 'https://x.org', kind: 'vendor' } },
      },
      'invalid',
    ],
    [
      'a keeper interval below the floor',
      { ...basePack(), keeper: { interval_hours: 1 } },
      'invalid',
    ],
    [
      'a sign-in URL with a query',
      {
        ...basePack(),
        sign_in: {
          url: { host: 'www.linkedin.com', path: '/login?next=https://evil.io' },
          human_only: false,
        },
      },
      'invalid',
    ],
    [
      'a sources URL over http',
      { ...basePack(), sources: [{ url: 'http://x.org', kind: 'official' }] },
      'invalid',
    ],
  ];
  for (const [name, value, reason] of refused) {
    it(`refuses ${name}`, () => {
      const result = loadPackBytes(bytes(value), LOAD);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe(reason);
    });
  }

  it('refuses a file over 64 KiB', () => {
    const p = { ...basePack(), description: 'x'.repeat(500) };
    const big = new Uint8Array(64 * 1024 + 1).fill(32);
    big.set(bytes(p));
    const result = loadPackBytes(big, LOAD);
    expect(result.ok ? null : result.error.reason).toBe('too_large');
  });

  it('refuses a file named for another pack', () => {
    const result = loadPackBytes(bytes(basePack()), { ...LOAD, expectedId: 'x.com' });
    expect(result.ok ? null : result.error.reason).toBe('id_mismatch');
  });

  it('refuses text that is not JSON', () => {
    const result = loadPackBytes(new TextEncoder().encode('{'), LOAD);
    expect(result.ok ? null : result.error.reason).toBe('invalid');
  });
});

describe('compareSemver', () => {
  it('orders versions and pre-releases', () => {
    expect(compareSemver('0.3.0', '0.3.0')).toBe(0);
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.3.0-rc.1', '0.3.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });
});
