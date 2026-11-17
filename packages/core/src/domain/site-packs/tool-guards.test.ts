/** @module domain/site-packs/tool-guards.test — the tool layer's pack view (spec 13 §9.3): `GET` document guards with the guard grammar (query strings, paths beneath, unreserved escapes), `write_policy` resolved by the template's override else the pack default, `DEFAULT_GUARDS` as `browserhive#<id>`, element guards by page glob; the template site of a URL; pack globs. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { matchesAnyPackGlob, matchesPackGlob } from './pack-glob.ts';
import { templateSiteOf } from './site-of-url.ts';
import { basePack } from './test-fixtures.ts';
import {
  effectiveAction,
  effectiveWritePolicy,
  elementGuardsFor,
  matchDocumentGuard,
} from './tool-guards.ts';

const pack = SitePackV1.parse({
  ...basePack(),
  guards: [
    ...(basePack().guards ?? []),
    {
      id: 'delete-get',
      kind: 'write',
      match: { url: 'www.linkedin.com/delete', methods: ['GET'] },
      action: 'write_policy',
    },
    {
      id: 'help-post',
      kind: 'account',
      match: { url: 'www.linkedin.com/help', methods: ['POST'] },
      action: 'block',
    },
    {
      id: 'api-xhr',
      kind: 'account',
      match: { url: 'www.linkedin.com/api/*', resource_types: ['xhr'] },
      action: 'block',
    },
  ],
});

const match = (url: string, policy: 'allow' | 'warn' | 'confirm' = 'confirm', defaults = []) =>
  matchDocumentGuard({ pack, cacheKey: `k-${policy}`, policy, defaults, url });

describe('matchDocumentGuard', () => {
  it.each([
    ['https://www.linkedin.com/m/logout', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout/', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout?next=/', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/log%6Fut', 'linkedin.com#logout'],
    ['https://WWW.LinkedIn.com/m/logout', 'linkedin.com#logout'],
    ['https://www.linkedin.com/m/logout-help', null],
    ['https://www.linkedin.com/help', null],
    ['https://www.linkedin.com/api/x', null],
    ['https://www.linkedin.com/feed/', null],
  ])('%s → %s', (url, ruleId) => {
    expect(match(url)?.ruleId ?? null).toBe(ruleId);
  });

  it('resolves write_policy with the policy in force', () => {
    expect(match('https://www.linkedin.com/delete', 'confirm')).toMatchObject({
      action: 'confirm',
      kind: 'write',
      guardId: 'delete-get',
      packId: 'linkedin.com',
    });
    expect(match('https://www.linkedin.com/delete', 'warn')?.action).toBe('warn');
    expect(match('https://www.linkedin.com/delete', 'allow')?.action).toBe('allow');
    expect(effectiveWritePolicy(pack, null)).toBe('confirm');
    expect(effectiveWritePolicy(pack, 'warn')).toBe('warn');
    expect(effectiveAction('block', 'allow')).toBe('block');
    expect(effectiveAction('write_policy', 'warn')).toBe('warn');
  });

  it('applies the compiled-in defaults after the pack, as browserhive#<id>, with or without a pack', () => {
    const defaults = [
      {
        id: 'oauth-consent',
        kind: 'credential' as const,
        match: { url: 'accounts.google.test/o/oauth2/approve' },
        action: 'block' as const,
      },
    ];
    const url = 'https://accounts.google.test/o/oauth2/approve?client=x';
    expect(
      matchDocumentGuard({ pack: null, cacheKey: 'none', policy: 'allow', defaults, url }),
    ).toMatchObject({
      ruleId: 'browserhive#oauth-consent',
      packId: 'browserhive',
      kind: 'credential',
      action: 'block',
    });
    expect(
      matchDocumentGuard({ pack: null, cacheKey: 'none', policy: 'allow', defaults: [], url }),
    ).toBeNull();
  });
});

describe('elementGuardsFor', () => {
  it('keeps the guards whose page glob matches', () => {
    expect(elementGuardsFor(pack, 'https://www.linkedin.com/feed/').map((g) => g.id)).toEqual([
      'signout-button',
    ]);
    expect(elementGuardsFor(pack, 'https://static.licdn.com/x')).toEqual([]);
  });
});

describe('pack globs', () => {
  it('match with the guard grammar; a refused glob matches nothing', () => {
    expect(
      matchesPackGlob('www.linkedin.com/uas/login*', 'https://www.linkedin.com/uas/login?x=1'),
    ).toBe(true);
    expect(
      matchesPackGlob(
        'www.linkedin.com/checkpoint',
        'https://www.linkedin.com/checkpoint/challenge',
      ),
    ).toBe(true);
    expect(matchesPackGlob('*', 'https://www.linkedin.com/')).toBe(false);
    expect(
      matchesAnyPackGlob(['a.test/x', 'www.linkedin.com/feed'], 'https://www.linkedin.com/feed/'),
    ).toBe(true);
    expect(matchesAnyPackGlob([], 'https://www.linkedin.com/feed/')).toBe(false);
  });
});

describe('templateSiteOf', () => {
  const sites = [
    { siteId: 'linkedin.com', packId: 'linkedin.com' },
    { siteId: 'site-b.test', packId: null },
  ];
  const packOf = (host: string) => (host.endsWith('licdn.com') ? 'linkedin.com' : null);
  it('by registrable domain, else by the pack owning the host', () => {
    expect(templateSiteOf(sites, 'https://www.linkedin.com/feed', packOf)?.siteId).toBe(
      'linkedin.com',
    );
    expect(templateSiteOf(sites, 'https://static.licdn.com/x', packOf)?.siteId).toBe(
      'linkedin.com',
    );
    expect(templateSiteOf(sites, 'https://www.site-b.test/', packOf)?.siteId).toBe('site-b.test');
    expect(templateSiteOf(sites, 'https://other.test/', packOf)).toBeNull();
    expect(templateSiteOf(sites, 'about:blank', packOf)).toBeNull();
  });
});
