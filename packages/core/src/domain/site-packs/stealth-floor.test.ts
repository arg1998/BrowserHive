import { describe, expect, test } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { packFloorIssues, stealthFloorIssues } from './stealth-floor.ts';
import { basePack } from './test-fixtures.ts';

const floor = { minLevel: 'max', fingerprint: 'any', humanize: false } as const;

describe('stealthFloorIssues', () => {
  test('level ordering off < standard < max', () => {
    expect(stealthFloorIssues({ stealth: 'max', fingerprint: false }, floor)).toEqual([]);
    const codes = (s: 'off' | 'standard') =>
      stealthFloorIssues({ stealth: s, fingerprint: false }, floor).map((i) => i.code);
    expect(codes('standard')).toEqual(['stealth_below_floor']);
    expect(codes('off')).toEqual(['stealth_below_floor']);
    expect(
      stealthFloorIssues(
        { stealth: 'off', fingerprint: false },
        { ...floor, minLevel: 'standard' },
      ),
    ).toHaveLength(1);
  });

  test('fingerprint required and forbidden', () => {
    const on = { stealth: 'max', fingerprint: true } as const;
    const off = { stealth: 'max', fingerprint: false } as const;
    expect(stealthFloorIssues(off, { ...floor, fingerprint: 'required' })[0]?.code).toBe(
      'fingerprint_required',
    );
    expect(stealthFloorIssues(on, { ...floor, fingerprint: 'forbidden' })[0]?.code).toBe(
      'fingerprint_forbidden',
    );
    expect(stealthFloorIssues(on, { ...floor, fingerprint: 'any' })).toEqual([]);
  });

  test('packFloorIssues is empty without the strategy', () => {
    const settings = { stealth: 'off', fingerprint: false } as const;
    expect(packFloorIssues(settings, SitePackV1.parse(basePack()))).toEqual([]);
    const pack = SitePackV1.parse({ ...basePack(), strategies: [{ id: 'stealth-profile' }] });
    expect(packFloorIssues(settings, pack).map((i) => i.code)).toEqual(['stealth_below_floor']);
  });
});
