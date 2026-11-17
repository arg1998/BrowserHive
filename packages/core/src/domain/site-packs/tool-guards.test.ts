/** @module domain/site-packs/tool-guards.test — the tool layer's pack view (spec 13 §9.3): `write_policy` resolved by the template's override else the pack default, element guards by page glob; the template site of a URL; pack globs with the guard grammar. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { matchesAnyPackGlob, matchesPackGlob } from './pack-glob.ts';
import { templateSiteOf } from './site-of-url.ts';
import { basePack } from './test-fixtures.ts';
import { effectiveAction, effectiveWritePolicy, elementGuardsFor } from './tool-guards.ts';

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

describe('effective actions', () => {
  it('resolves write_policy with the policy in force', () => {
    expect(effectiveWritePolicy(pack, null)).toBe('confirm');
    expect(effectiveWritePolicy(pack, 'warn')).toBe('warn');
    expect(effectiveAction('block', 'allow')).toBe('block');
    expect(effectiveAction('write_policy', 'warn')).toBe('warn');
    expect(effectiveAction('write_policy', 'allow')).toBe('allow');
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
