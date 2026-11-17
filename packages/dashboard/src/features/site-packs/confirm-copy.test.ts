/** @module features/site-packs/confirm-copy.test — the pack confirmations follow the change's classification (review #84 L1, L4): approving a local file that relaxes rules or can stop the site asks with care and says so; Revert says what going back changes, names the fields to read first and asks with care unless it only tightens or changes nothing */

import { describe, expect, it } from 'bun:test';
import { packDiff, packView, sha } from '../../../test/fixtures/site-packs.ts';
import { approveLocalConfirm, revertConfirm } from './confirm-copy.ts';

const PATH = '/data/site-packs/local/linkedin.com.json';

describe('approveLocalConfirm', () => {
  it('a file that relaxes rules or can stop the site asks with care, in words', () => {
    const loose = approveLocalConfirm(packView(), PATH, sha('d'), 'loosening');
    expect(loose.danger).toBe(true);
    expect(loose.description).toMatch(/^This file relaxes rules: check every highlighted field/);
    const stop = approveLocalConfirm(packView(), PATH, sha('d'), 'restrictive');
    expect(stop.danger).toBe(true);
    expect(stop.description).toMatch(/^This file can stop agents from using the site/);
  });

  it('a file that only tightens, changes nothing or is new is not a danger', () => {
    for (const cls of ['tightening', 'neutral', 'new_pack'] as const) {
      expect(approveLocalConfirm(packView(), PATH, sha('d'), cls).danger).toBe(false);
    }
    expect(approveLocalConfirm(packView(), PATH, sha('d'), 'tightening').description).toMatch(
      /^This file only tightens rules\./,
    );
    // The SHA-256 and the path stay named.
    expect(approveLocalConfirm(packView(), PATH, sha('d')).items).toEqual([
      `SHA-256 ${sha('d')}`,
      expect.stringContaining('linkedin.com.json'),
    ]);
  });
});

describe('revertConfirm', () => {
  const pack = packView({ previous: { version: 2, source: 'bundled' } });

  it('going back to a version that relaxes rules names the fields and asks with care', () => {
    const options = revertConfirm(
      pack,
      packDiff({
        classification: 'loosening',
        changes: [
          { path: 'title', from: 'a', to: 'b', class: 'neutral' },
          { path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' },
          { path: 'browser.headed', from: 'any', to: 'required', class: 'restrictive' },
        ],
      }),
    );
    expect(options.danger).toBe(true);
    expect(options.description).toMatch(/^v2 relaxes rules compared with the version in force/);
    expect(options.itemsLabel).toBe('Fields to read first');
    expect(options.items).toEqual([
      'guards[logout] · Relaxes rules',
      'browser.headed · Can stop the site',
    ]);
  });

  it('a revert that only tightens is not a danger; an unknown one is', () => {
    const tight = revertConfirm(pack, packDiff({ classification: 'tightening' }));
    expect(tight.danger).toBe(false);
    expect(tight.description).toMatch(/^v2 only tightens rules\./);
    expect(tight.items).toBeUndefined();
    const unknown = revertConfirm(pack);
    expect(unknown.danger).toBe(true);
    expect(unknown.description).toMatch(/^What v2 changes could not be classified\./);
  });

  it('counts the fields beyond the first six', () => {
    const changes = Array.from({ length: 8 }, (_, i) => ({
      path: `guards[g${i}]`,
      from: { id: `g${i}` },
      to: null,
      class: 'loosening' as const,
    }));
    const options = revertConfirm(pack, packDiff({ classification: 'loosening', changes }));
    expect(options.items).toHaveLength(7);
    expect(options.items?.at(-1)).toBe('and 2 more');
  });
});
