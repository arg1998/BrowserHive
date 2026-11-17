/** @module test/helpers/packs-lookup — a `SitePackLookup` over parsed packs (several sites' strategies at once), every pack approved and enabled; `strategyPack` builds a fixture-site pack that selects the given strategies. */

import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { registrableDomain } from '../../src/kernel/url.ts';
import type { EffectivePack, SitePackLookup } from '../../src/ports/site-packs.ts';
import { sitePack } from './site-pack-kit.ts';

/** A pack for `id` (a registrable domain) with `extra` fields, e.g. `strategies`. */
export function strategyPack(id: string, extra: Partial<SitePackV1Input> = {}): SitePackV1 {
  return SitePackV1.parse(sitePack(id, 1, extra));
}

/** Approved packs by id; `set`/`remove` change them between calls. */
export class PacksLookup implements SitePackLookup {
  generation = 1;
  readonly #packs = new Map<string, SitePackV1>();

  constructor(packs: readonly SitePackV1[] = []) {
    for (const pack of packs) this.#packs.set(pack.id, pack);
  }

  set(pack: SitePackV1): void {
    this.#packs.set(pack.id, pack);
    this.generation += 1;
  }

  remove(packId: string): void {
    this.#packs.delete(packId);
    this.generation += 1;
  }

  effectiveFor(hostOrDomain: string): EffectivePack | null {
    const domain = registrableDomain(hostOrDomain);
    for (const pack of this.#packs.values()) {
      if (pack.domains.includes(domain)) return this.#effective(pack);
    }
    return null;
  }

  effectiveById(packId: string): EffectivePack | null {
    const pack = this.#packs.get(packId);
    return pack === undefined ? null : this.#effective(pack);
  }

  #effective(pack: SitePackV1): EffectivePack {
    return {
      packId: pack.id,
      pack,
      version: pack.version,
      sha256: `fixture-${pack.id}-${this.generation}`,
      source: 'local',
      localOverride: false,
    };
  }
}
