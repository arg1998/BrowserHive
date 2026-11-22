/** @module domain/site-packs/registry-listing — what a verified registry index lists for this binary (spec 13 §10.3 step 3): before a download, the index alone decides what is available, namely the highest non-revoked version per pack whose `min_client`/`max_client` admit this binary; a version for another BrowserHive names the range it needs. */

import type { RegistryIndexPack, RegistryPackVersion } from '@browserhive/contracts/site-packs';
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
