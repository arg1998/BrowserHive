/** @module app/templates/template-packs — what the template services need from the site-pack registry (spec 13 §9.6, T3a): approval on first use when a site is added, the pack in force for a site's view, its identity provider (notification threads) and `human_only` (no vault re-login). `NO_PACKS` is the answer when packs are off or not wired. */

import type { TemplateSitePack } from '@browserhive/contracts/http';
import { registrableDomain } from '../../kernel/url.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { SiteApproval } from '../site-packs/registry-types.ts';

/** The registry as the template services see it (`SitePackRegistry` fits). */
export interface TemplatePacks {
  /**
   * Approves the pack a site uses on first use; `sha256` is the version the operator reviewed
   * (`CONFLICT` on mismatch). `null` when no pack covers the site.
   */
  approveSite(siteId: string, sha256: string | undefined, by: string): Promise<SiteApproval | null>;
  /** The pack in force for a site's `pack_id`, or `null`. */
  sitePackOf(packId: string | null): TemplateSitePack | null;
  /** The pack's identity provider, or `null`. */
  providerOf(packId: string | null): string | null;
  /** Whether the pack's sign-in is human only (never filled by the vault). */
  humanOnly(packId: string | null): boolean;
}

/** No packs: every site is generic. */
export const NO_PACKS: TemplatePacks = {
  approveSite: () => Promise.resolve(null),
  sitePackOf: () => null,
  providerOf: () => null,
  humanOnly: () => false,
};

/** The reviewed hashes of `POST /templates` sites, by registrable domain. */
export function reviewedHashes(
  sites: readonly { readonly site_id: string; readonly pack_sha256?: string | undefined }[],
): (siteId: string) => string | undefined {
  const map = new Map<string, string>();
  for (const s of sites) {
    if (s.pack_sha256 !== undefined)
      map.set(registrableDomain(s.site_id) || s.site_id, s.pack_sha256);
  }
  return (siteId) => map.get(siteId);
}

/** The identity-provider lookup `domain/templates/probe.ts` takes. */
export function providerLookup(packs: TemplatePacks): (packId: string) => string | null {
  return (packId) => packs.providerOf(packId);
}

/**
 * Approves the pack of each new site on first use (spec 13 §9.6) and records it on the site
 * (`pack_id`, `pack_version`). `shaOf` gives the SHA-256 the operator reviewed for a site.
 *
 * @throws AppError `CONFLICT` (a reviewed version that is not the one approved or on offer).
 */
export async function attachPacks(
  packs: TemplatePacks,
  sites: readonly TemplateSiteRecord[],
  shaOf: (siteId: string) => string | undefined,
  by: string,
): Promise<TemplateSiteRecord[]> {
  const out: TemplateSiteRecord[] = [];
  for (const site of sites) {
    const approval = await packs.approveSite(site.siteId, shaOf(site.siteId), by);
    out.push(
      approval === null
        ? site
        : { ...site, packId: approval.packId, packVersion: approval.version },
    );
  }
  return out;
}
