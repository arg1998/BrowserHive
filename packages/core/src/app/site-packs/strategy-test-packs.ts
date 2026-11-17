/** @module app/site-packs/strategy-test-packs — effective packs and lookups for the network strategies' unit tests (`pace-writes`, `ramp-up`, `keep-alive`, `webrtc-policy`, `device-bound-session`). Test support only. */

import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { basePack } from '../../domain/site-packs/test-fixtures.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';

/** The LinkedIn-shaped base pack with `extra` fields, as an effective pack. */
export function effective(extra: Partial<SitePackV1Input> = {}): EffectivePack {
  const pack = SitePackV1.parse({ ...basePack(), ...extra });
  return {
    packId: pack.id,
    pack,
    version: pack.version,
    sha256: 'a'.repeat(64),
    source: 'bundled',
    localOverride: false,
  };
}

/** A lookup over `packs` by id and by registrable domain (`www.x.com` → `x.com`). */
export function lookupOf(...packs: EffectivePack[]): SitePackLookup {
  const byDomain = (host: string) =>
    packs.find((p) => p.pack.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
  return {
    effectiveFor: byDomain,
    effectiveById: (id) => packs.find((p) => p.packId === id) ?? null,
    generation: 1,
  };
}
