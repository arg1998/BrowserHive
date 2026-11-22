/** @module domain/site-packs/auto-update.test — Tests of auto-update's own limits (spec 13 §9.7, D74) and of what an index lists for this binary (§10.3 step 3). */

import { describe, expect, it } from 'bun:test';
import type { RegistryIndexPack, SitePackV1 } from '@browserhive/contracts/site-packs';
import { SitePackV1 as Schema } from '@browserhive/contracts/site-packs';
import { sitePack } from '../../../test/helpers/site-pack-kit.ts';
import { AUTO_MAX_ADDED_BLOCKING, autoApplyHold } from './auto-update.ts';
import { bestUsable, neededClient, newestListed } from './registry-listing.ts';

const ID = 'pack-a.test';
const base: SitePackV1 = Schema.parse(sitePack(ID, 1));

function withGuards(n: number, extra: Partial<SitePackV1['guards'][number]> = {}): SitePackV1 {
  return {
    ...base,
    version: 2,
    guards: [
      ...base.guards,
      ...Array.from({ length: n }, (_, i) => ({
        id: `g-${i}`,
        kind: 'destructive' as const,
        match: { url: `www.${ID}/x${i}`, methods: ['DELETE' as const] },
        action: 'block' as const,
        ...extra,
      })),
    ],
  };
}

describe('autoApplyHold', () => {
  it('applies tightening or neutral versions within the cap', () => {
    expect(autoApplyHold(base, withGuards(AUTO_MAX_ADDED_BLOCKING), 'tightening', [])).toBeNull();
    expect(autoApplyHold(base, { ...base, version: 2, title: 'x' }, 'neutral', [])).toBeNull();
  });

  it('holds loosening, restrictive and domain changes', () => {
    expect(autoApplyHold(base, base, 'loosening', [])).toBe('classification');
    expect(autoApplyHold(base, base, 'restrictive', [])).toBe('classification');
    expect(autoApplyHold(base, base, 'tightening', ['other.test'])).toBe('domains');
  });

  it('holds more than the cap of new blocking guards, a host-wide one, or a broad element guard', () => {
    expect(autoApplyHold(base, withGuards(AUTO_MAX_ADDED_BLOCKING + 1), 'tightening', [])).toBe(
      'too_many_blocking_guards',
    );
    const hostWide = withGuards(1, { match: { url: `www.${ID}/*` } });
    expect(autoApplyHold(base, hostWide, 'tightening', [])).toBe('host_wide_guard');
    const broad: SitePackV1 = {
      ...base,
      version: 2,
      element_guards: [
        {
          id: 'e',
          kind: 'write',
          page: `www.${ID}/*`,
          target: { selector: 'button' },
          action: 'confirm',
        },
      ],
    };
    expect(autoApplyHold(base, broad, 'tightening', [])).toBe('element_guards');
  });

  it('holds what can stop agents on a site (review #100 M1, L3; D-87)', () => {
    // A1: 28 attention challenges that cover neither the probe nor the sign-in page.
    const challenged: SitePackV1 = {
      ...base,
      version: 2,
      challenges: 'bcdefghijkmnopqrstuvwxyz0123'.split('').map((c, i) => ({
        id: `ch-${i}`,
        kind: 'checkpoint' as const,
        match: { url: `www.${ID}/${c}*` },
        action: 'attention' as const,
      })),
    } as SitePackV1;
    expect(autoApplyHold(base, challenged, 'tightening', [])).toBe('challenges');
    // A2: element guards with a two-letter role name.
    const roles: SitePackV1 = {
      ...base,
      version: 2,
      element_guards: [
        {
          id: 'r',
          kind: 'write',
          page: `www.${ID}/feed*`,
          target: { role: 'button', name: 'en' },
          action: 'block',
        },
      ],
    };
    expect(autoApplyHold(base, roles, 'tightening', [])).toBe('element_guards');
    // A3: human_only on, max_sessions 2, a one-hour launch gap.
    const signIn = base.sign_in ?? {
      url: { host: `www.${ID}`, path: '/login' },
      human_only: false,
    };
    expect(
      autoApplyHold(base, { ...base, sign_in: { ...signIn, human_only: true } }, 'tightening', []),
    ).toBe('human_only');
    const capped: SitePackV1 = {
      ...base,
      concurrency: {
        max_sessions: 2,
        source: { url: 'https://www.pack-a.test/terms', kind: 'official' },
      },
    } as SitePackV1;
    expect(autoApplyHold(base, capped, 'tightening', [])).toBe('concurrency');
    const slow: SitePackV1 = { ...base, pacing: { rules: [], min_launch_gap_s: 3600 } };
    expect(autoApplyHold(base, slow, 'tightening', [])).toBe('pacing');
  });

  it('applies small throttling steps (at most 2× slower)', () => {
    const gap = (s: number): SitePackV1 => ({
      ...base,
      pacing: { rules: [], min_launch_gap_s: s },
    });
    expect(autoApplyHold(base, gap(20), 'tightening', [])).toBeNull();
    expect(autoApplyHold(gap(60), gap(120), 'tightening', [])).toBeNull();
    expect(autoApplyHold(gap(60), gap(121), 'tightening', [])).toBe('pacing');
  });

  it('counts an existing guard made blocking like a new one', () => {
    const warned: SitePackV1 = { ...withGuards(4, { action: 'warn' }), version: 1 };
    const blocked = withGuards(4);
    expect(autoApplyHold(warned, blocked, 'tightening', [])).toBe('too_many_blocking_guards');
  });
});

describe('registry listings', () => {
  const entry = (v: number, extra: Record<string, unknown> = {}) => ({
    v,
    min_client: '0.1.0',
    sha256: String(v).repeat(64).slice(0, 64),
    size: 100,
    path: `packs/${ID}/${String(v).repeat(64).slice(0, 64)}.json`,
    released: '2026-11-20',
    notes: 'n',
    ...extra,
  });
  const listing = (versions: ReturnType<typeof entry>[]): RegistryIndexPack => ({
    id: ID,
    title: 'A',
    versions,
  });

  it('the best usable version skips revoked ones and other clients', () => {
    const l = listing([entry(5, { min_client: '9.0.0' }), entry(4, { revoked: true }), entry(3)]);
    expect(bestUsable(l, '0.3.0')?.v).toBe(3);
    expect(newestListed(l)?.v).toBe(5);
    expect(neededClient(entry(5, { min_client: '9.0.0' }), '0.3.0')).toBe('9.0.0 or later');
    expect(neededClient(entry(2, { max_client: '0.2.9' }), '0.3.0')).toBe('0.1.0 to 0.2.9');
    expect(neededClient(entry(1), '0.3.0')).toBeNull();
  });
});
