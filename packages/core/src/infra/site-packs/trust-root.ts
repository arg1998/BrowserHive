/** @module infra/site-packs/trust-root — the registry root keys this binary trusts (spec 13 §10.2, D-55): two Ed25519 keys held offline by the owner, threshold 1 of 2, that sign only `keys.json`. They are the public halves of `registry/keys/root-1.pub` and `root-2.pub`; `node scripts/registry-keys.mjs init-roots` writes both, and `trust-root.test.ts` keeps them equal. Until the owner's key ceremony the list is empty: this build then trusts no registry, and the release check (`scripts/registry-trust-check.ts`) refuses to publish it. Replacing a root key needs a release. Nothing (no configuration key, flag or environment variable) adds to this list; BrowserHive's own suites inject a test root through `createServer({ testing: { sitePacksTrustRoot } })` only. */

import type { SitePacksTrustRoot, TrustRootKey } from '../../ports/site-packs.ts';

// The block between the markers is rewritten by `node scripts/registry-keys.mjs init-roots`.
// BEGIN PINNED ROOT KEYS
/** The pinned root keys. */
export const PINNED_ROOT_KEYS: readonly TrustRootKey[] = [];
// END PINNED ROOT KEYS

/** The trust root of this build. */
export const PINNED_TRUST_ROOT: SitePacksTrustRoot = Object.freeze({
  keys: Object.freeze(PINNED_ROOT_KEYS.map((k) => Object.freeze({ ...k }))),
});

/** Whether `root` trusts nothing (the placeholder before the key ceremony). */
export function trustsNothing(root: SitePacksTrustRoot): boolean {
  return root.keys.length === 0;
}
