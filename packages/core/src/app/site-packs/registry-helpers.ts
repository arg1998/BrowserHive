/** @module app/site-packs/registry-helpers — small pure helpers of `SitePackRegistry` (spec 13 §9.6): `human_only` through an identity provider, and the import route's answer. */

import type { SitePackImportResponse, SitePackView } from '@browserhive/contracts/http';
import type { SitePackLookup } from '../../ports/site-packs.ts';

/** `sign_in.human_only` of the pack in force, through its identity provider's pack. */
export function humanOnlyOf(lookup: SitePackLookup, packId: string | null): boolean {
  if (packId === null) return false;
  const pack = lookup.effectiveById(packId)?.pack;
  if (pack === undefined) return false;
  if (pack.sign_in !== undefined) return pack.sign_in.human_only;
  const provider = pack.identity_provider;
  return provider === undefined
    ? false
    : lookup.effectiveFor(provider)?.pack.sign_in?.human_only === true;
}

/** `POST /site-packs/import`'s answer for one written file. */
export function importResponse(
  written: { readonly packId: string; readonly version: number; readonly sha256: string },
  view: SitePackView | null,
): SitePackImportResponse {
  return {
    imported: [
      {
        pack_id: written.packId,
        version: written.version,
        state: view?.local?.state ?? 'not_approved',
        sha256: written.sha256,
      },
    ],
  };
}
