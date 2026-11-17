/** @module app/site-packs/strategy-scope — which pack strategies apply where (spec 13 §9.4, §9.6): template-scoped strategies (admission, stealth, host flags, keeper) come from the template's enabled sites' approved packs; page-scoped ones (before action, request guard, responses, focus) from the approved pack owning the URL's registrable domain (packs are global across template hosts, D-67). Every answer is empty under `sitePacks=false` (no lookup). */

import type { StrategyId } from '@browserhive/contracts/site-packs';
import { hostOf } from '../../domain/site-packs/site-of-url.ts';
import { type StrategyParams, strategyOf } from '../../domain/site-packs/strategy-specs.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';

/** A strategy selected by the pack of one template site. */
export interface SiteStrategy<K extends StrategyId> {
  readonly site: TemplateSiteRecord;
  readonly pack: EffectivePack;
  readonly params: StrategyParams[K];
}

/** A strategy selected by the pack owning a URL. */
export interface PageStrategy<K extends StrategyId> {
  readonly pack: EffectivePack;
  readonly params: StrategyParams[K];
}

/** The approved, enabled pack of a template site: its attached pack, else the one owning its domain. */
export function packOfSite(
  site: Pick<TemplateSiteRecord, 'siteId' | 'packId'>,
  lookup: SitePackLookup | null,
): EffectivePack | null {
  if (lookup === null) return null;
  return site.packId !== null
    ? lookup.effectiveById(site.packId)
    : lookup.effectiveFor(site.siteId);
}

/** Strategy `id` of every enabled site of a template whose pack selects it. */
export function templateStrategies<K extends StrategyId>(
  sites: readonly TemplateSiteRecord[],
  lookup: SitePackLookup | null,
  id: K,
): SiteStrategy<K>[] {
  const out: SiteStrategy<K>[] = [];
  for (const site of sites) {
    if (!site.enabled) continue;
    const pack = packOfSite(site, lookup);
    if (pack === null) continue;
    const params = strategyOf(pack.pack, id);
    if (params !== null) out.push({ site, pack, params });
  }
  return out;
}

/** Strategy `id` of the pack owning `url`'s registrable domain, or `null`. */
export function pageStrategy<K extends StrategyId>(
  url: string,
  lookup: SitePackLookup | null,
  id: K,
): PageStrategy<K> | null {
  if (lookup === null) return null;
  const host = hostOf(url);
  if (host === null) return null;
  const pack = lookup.effectiveFor(host);
  if (pack === null) return null;
  const params = strategyOf(pack.pack, id);
  return params === null ? null : { pack, params };
}
