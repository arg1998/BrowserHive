/** @module infra/site-packs/registry-verifier — the `RegistryVerifier` port over `verify.ts` and `verify-layout.ts` (spec 13 §10.3) for one trust root: the pinned one, or the testing seam's. */

import type { RegistryVerifier } from '../../ports/site-pack-registry.ts';
import type { SitePacksTrustRoot } from '../../ports/site-packs.ts';
import { trustsNothing } from './trust-root.ts';
import { verifyIndex, verifyKeys, verifyListedPack } from './verify.ts';
import { indexFloorOf } from './verify-layout.ts';

/** The verifier of `root`. */
export function createRegistryVerifier(root: SitePacksTrustRoot): RegistryVerifier {
  return {
    trustsNothing: trustsNothing(root),
    verifyKeys: (input) => verifyKeys({ ...input, root }),
    verifyIndex: (input) => verifyIndex(input),
    verifyListedPack: (bytes, packId, entry, binaryVersion) =>
      verifyListedPack(bytes, packId, entry, binaryVersion),
    indexFloorOf: (keys, floors) => indexFloorOf(keys, floors),
  };
}
