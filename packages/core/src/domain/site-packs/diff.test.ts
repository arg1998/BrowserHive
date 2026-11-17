/** @module domain/site-packs/diff.test — field-level pack diffs (spec 13 §10.6). */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { diffPacks, newDomains } from './diff.ts';
import { basePack } from './test-fixtures.ts';

describe('diffPacks', () => {
  it('matches guards by id and reports each changed field', () => {
    const a = SitePackV1.parse(basePack());
    const next = basePack();
    next.version = 4;
    next.domains = ['linkedin.com', 'licdn.com', 'lnkd.in'];
    const logout = next.guards?.[0];
    if (logout !== undefined) logout.action = 'warn';
    next.guards?.splice(1, 1);
    const b = SitePackV1.parse(next);
    const changes = diffPacks(a, b);
    expect(changes.map((c) => c.path)).toEqual([
      'domains',
      'guards[logout].action',
      'guards[settings-post]',
    ]);
    expect(changes.find((c) => c.path === 'guards[logout].action')).toEqual({
      path: 'guards[logout].action',
      from: 'block',
      to: 'warn',
      class: null,
    });
    expect(newDomains(a, b)).toEqual(['lnkd.in']);
  });

  it('lists every field of a new pack and no change for identical content', () => {
    const a = SitePackV1.parse(basePack());
    expect(diffPacks(a, a)).toEqual([]);
    expect(diffPacks(null, a).length).toBeGreaterThan(5);
    expect(newDomains(null, a)).toEqual(['linkedin.com', 'licdn.com']);
  });
});
