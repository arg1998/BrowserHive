/** @module ports/site-packs — where pack versions come from (`SitePackSource`) and the read side every enforcement point uses (`SitePackLookup`): the approved, enabled pack that owns a host (spec 13 §9.6). */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { Result } from '../kernel/result.ts';
import type { SitePackSourceId } from './persistence/site-packs.ts';

/** Why a source skipped a pack version (the contract's `SitePackSkipReason`). */
export type SitePackSkipReasonValue =
  | 'invalid'
  | 'too_large'
  | 'unknown_strategy'
  | 'min_client'
  | 'domain_overlap'
  | 'not_found'
  | 'id_mismatch'
  | 'signed_layout_unsupported'
  | 'unreadable'
  | 'layout_refused';

/** One verified, schema-checked and refined pack version a source offers. */
export interface SourcePackVersion {
  readonly pack: SitePackV1;
  /** SHA-256 (lowercase hex) of the exact bytes read. */
  readonly sha256: string;
  readonly size: number;
  /** The exact bytes, kept so an approved copy can be cached byte for byte. */
  readonly bytes: Uint8Array;
  /** Bundled: the release; local: the file path. */
  readonly origin: string;
  /** Advisory notes from `refinePack` (an element guard without `request_guard`). */
  readonly warnings: readonly string[];
}

/** A version a source could not offer. */
export interface SkippedPackVersion {
  /** The pack id when it could be read, else the file name. */
  readonly packId: string;
  readonly version: number | null;
  readonly reason: SitePackSkipReasonValue;
  readonly detail: string;
}

/** What one load of a source found. */
export interface SourceCatalog {
  readonly source: SitePackSourceId;
  readonly packs: readonly SourcePackVersion[];
  readonly skipped: readonly SkippedPackVersion[];
  /** Signed layouts found (spec 13 §10.5: verified like an import by the registry client). */
  readonly signedLayouts: number;
  /** Their folders (the local folder itself for a top-level layout). */
  readonly layouts?: readonly string[];
}

/** Why a source could not load at all (the folder is unreadable). */
export interface SitePackSourceError {
  readonly source: SitePackSourceId;
  readonly message: string;
}

/** A source of pack versions (spec 13 §9.6). */
export interface SitePackSource {
  readonly id: SitePackSourceId;
  /** `publisher` for bundled, remote and imported signed versions; `operator` for unsigned local files. */
  readonly trust: 'publisher' | 'operator';
  load(signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>>;
}

/** The pack in force for a registrable domain. */
export interface EffectivePack {
  readonly packId: string;
  readonly pack: SitePackV1;
  readonly version: number;
  readonly sha256: string;
  /** Where the content in force came from (`local` when a local override applies). */
  readonly source: SitePackSourceId;
  readonly localOverride: boolean;
}

/**
 * The read side of the registry that enforcement uses: guards, element guards, challenges,
 * probes and the template views. Reads are synchronous over the registry's current snapshot (a
 * reload swaps it atomically, D-22); every answer is `null` when `sitePacks=false`.
 */
export interface SitePackLookup {
  /** The approved, enabled pack whose `domains` contain `registrableDomain(hostOrDomain)`. */
  effectiveFor(hostOrDomain: string): EffectivePack | null;
  /** The approved, enabled pack with this id. */
  effectiveById(packId: string): EffectivePack | null;
  /** A counter that changes on every snapshot swap (compiled-rule caches key on it). */
  readonly generation: number;
}

/** One registry root key (spec 13 §10.2): the key id and the raw 32-byte Ed25519 public key (base64). */
export interface TrustRootKey {
  readonly keyId: string;
  readonly publicKey: string;
}

/**
 * The keys a client trusts to sign `keys.json` (threshold 1). A release pins its own
 * (`infra/site-packs/trust-root.ts`); BrowserHive's suites inject a test root only through
 * `createServer({ testing: { sitePacksTrustRoot } })` (spec 13 §10.2). An empty list trusts nothing.
 */
export interface SitePacksTrustRoot {
  readonly keys: readonly TrustRootKey[];
}
