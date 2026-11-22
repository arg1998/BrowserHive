/** @module domain/site-packs/registry-listing — what a verified registry index lists for this binary (spec 13 §10.3 step 3): before a download, the index alone decides what is available, namely the highest non-revoked version per pack whose `min_client`/`max_client` admit this binary; a version for another BrowserHive names the range it needs. */

import type {
  RegistryIndexPack,
  RegistryIndexV1,
  RegistryPackVersion,
} from '@browserhive/contracts/site-packs';
import { compareSemver } from './refine.ts';

/** The BrowserHive range a listed version needs, or `null` when this binary is inside it. */
export function neededClient(entry: RegistryPackVersion, binaryVersion: string): string | null {
  const below = compareSemver(binaryVersion, entry.min_client) < 0;
  const above =
    entry.max_client !== undefined && compareSemver(binaryVersion, entry.max_client) > 0;
  if (!below && !above) return null;
  return entry.max_client === undefined
    ? `${entry.min_client} or later`
    : `${entry.min_client} to ${entry.max_client}`;
}

/** The highest version this binary may use: not revoked, inside its client range (`null` when none). */
export function bestUsable(
  pack: RegistryIndexPack,
  binaryVersion: string,
): RegistryPackVersion | null {
  let best: RegistryPackVersion | null = null;
  for (const entry of pack.versions) {
    if (entry.revoked === true || neededClient(entry, binaryVersion) !== null) continue;
    if (best === null || entry.v > best.v) best = entry;
  }
  return best;
}

/** The newest listed version, whatever its client range or revocation. */
export function newestListed(pack: RegistryIndexPack): RegistryPackVersion | null {
  let newest: RegistryPackVersion | null = null;
  for (const entry of pack.versions) if (newest === null || entry.v > newest.v) newest = entry;
  return newest;
}

/** The listed entry of `version` with this SHA-256, or `null`. */
export function listedEntry(
  pack: RegistryIndexPack | undefined,
  version: number,
): RegistryPackVersion | null {
  return pack?.versions.find((v) => v.v === version) ?? null;
}

/** An index entry left out because its text is not plain (review #100 UI H1). */
export interface UnsafeListing {
  readonly packId: string;
  readonly version: number | null;
  readonly detail: string;
}

/** Plain text for index strings: no controls (a line break allowed in notes), formats or separators. */
const UNSAFE_TITLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_NOTES = /[\p{Cf}\p{Zl}\p{Zp}]|[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

/**
 * The index without the entries whose signed text is not plain (spec 13 §9.10: shown as text
 * only): a pack whose title holds a control or format character (bidi overrides, escapes) is left
 * out whole, a version whose notes do is left out alone. The signature still covers the original.
 */
export function plainListings(index: RegistryIndexV1): {
  readonly index: RegistryIndexV1;
  readonly unsafe: readonly UnsafeListing[];
} {
  const unsafe: UnsafeListing[] = [];
  const packs: RegistryIndexPack[] = [];
  for (const pack of index.packs) {
    if (UNSAFE_TITLE.test(pack.title)) {
      unsafe.push({
        packId: pack.id,
        version: null,
        detail: 'its title holds a control or invisible formatting character',
      });
      continue;
    }
    const versions = pack.versions.filter((v) => {
      if (!UNSAFE_NOTES.test(v.notes)) return true;
      unsafe.push({
        packId: pack.id,
        version: v.v,
        detail: 'its notes hold a control or invisible formatting character',
      });
      return false;
    });
    if (versions.length > 0) packs.push({ ...pack, versions });
  }
  return { index: unsafe.length === 0 ? index : { ...index, packs }, unsafe };
}
