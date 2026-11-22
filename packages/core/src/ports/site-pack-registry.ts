/** @module ports/site-pack-registry — what the site-pack registry client (spec 13 §10.3–§10.5) needs from the outside: one hygienic `GET` of a registry file (`RegistryFetcher`), the last good signed layout it holds on disk (`HeldLayoutStore`), and the trust chain (`RegistryVerifier`). */

import type {
  RegistryIndexV1,
  RegistryKeysV1,
  RegistryPackVersion,
} from '@browserhive/contracts/site-packs';
import type { Result } from '../kernel/result.ts';
import type { SourcePackVersion } from './site-packs.ts';

/** One request for a registry file, relative to `sitePacksUrl`. */
export interface RegistryFetchRequest {
  /** `keys.json`, `index.json`, their `.sig`, or `packs/<id>/<sha256>.json`. */
  readonly path: string;
  /** A body larger than this is refused while it streams (`too_large`). */
  readonly maxBytes: number;
  /**
   * The SHA-256 (hex) of the verified body BrowserHive holds for this path: sent as
   * `If-None-Match: "<sha256>"`. Derived only from public content, never from a server's ETag, so
   * it cannot carry an identifier (spec 13 §10.4, D69).
   */
  readonly heldSha256?: string;
}

/** Why a fetch failed. */
export type RegistryFetchFailure =
  | 'insecure_url'
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'redirect'
  | 'too_large'
  | 'not_modified_without_body'
  /** A `Content-Encoding` other than `identity` (compressed bodies are refused: no decompression bomb). */
  | 'encoding';

/** The outcome of one fetch. `date` is the response's `Date` header (epoch ms) when it parses. */
export type RegistryFetchResult =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly date: number | null }
  | { readonly kind: 'not_modified'; readonly date: number | null }
  | {
      readonly kind: 'failed';
      readonly reason: RegistryFetchFailure;
      readonly status: number | null;
      readonly detail: string;
      readonly date: number | null;
    };

/** Fetches registry files: `https:` only (loopback `http:` only through the testing seam), no cookie, query, body or redirect, `User-Agent: BrowserHive`. */
export interface RegistryFetcher {
  /** The registry folder (`sitePacksUrl`). */
  readonly url: string;
  fetch(request: RegistryFetchRequest, signal?: AbortSignal): Promise<RegistryFetchResult>;
}

/** The files of the held layout (`<dataDir>/site-packs/remote/`). */
export const HELD_LAYOUT_FILES = [
  'keys.json',
  'keys.json.sig',
  'index.json',
  'index.json.sig',
] as const;
/** One held file. */
export type HeldLayoutFile = (typeof HELD_LAYOUT_FILES)[number];

/** The last good `keys.json`, `index.json` and their signatures (spec 13 §10.3 step 2: "keep the file as the last good index"). */
export interface HeldLayoutStore {
  readonly dir: string;
  /** The held bytes, `null` when absent or unreadable. */
  read(file: HeldLayoutFile): Promise<Uint8Array | null>;
  /** Replaces the given files atomically, one by one, `index.json` last. */
  write(files: Partial<Readonly<Record<HeldLayoutFile, Uint8Array>>>): Promise<void>;
}

/** A refused registry file (the infra verifier's `RegistryRefusal`). */
export interface RegistryRefusalInfo {
  /** The file, relative to `registry/v1/`. */
  readonly file: string;
  /** `unknown_key`, `bad_signature`, `expired`, `rollback`, `fast_forward`, `hash_mismatch`, … */
  readonly reason: string;
  readonly detail: string;
}

/** A verified signed file and the key that signed it. */
export interface VerifiedFile<T> {
  readonly value: T;
  readonly signedBy: string;
}

/** A listed pack file that verified but needs another BrowserHive. */
export interface OutOfRangePack {
  readonly outOfRange: string;
}

/**
 * The trust chain of spec 13 §10.2–§10.3 over the pinned root (or the testing seam's), as the
 * client uses it: `infra/site-packs/verify.ts` behind a port, so the app layer stays free of
 * `node:crypto`.
 */
export interface RegistryVerifier {
  /** The build pins no root key (until the key ceremony): no index can verify, so no check runs. */
  readonly trustsNothing: boolean;
  verifyKeys(input: {
    readonly bytes: Uint8Array;
    readonly sig: Uint8Array;
    readonly now: number;
    readonly floor: number | null;
  }): Result<VerifiedFile<RegistryKeysV1>, RegistryRefusalInfo>;
  verifyIndex(input: {
    readonly bytes: Uint8Array;
    readonly sig: Uint8Array;
    readonly keys: RegistryKeysV1;
    readonly now: number;
    readonly floor: number | null;
  }): Result<VerifiedFile<RegistryIndexV1>, RegistryRefusalInfo>;
  /** Step 3 for one listed file. */
  verifyListedPack(
    bytes: Uint8Array,
    packId: string,
    entry: RegistryPackVersion,
    binaryVersion: string,
  ): Result<SourcePackVersion | OutOfRangePack, RegistryRefusalInfo>;
  /** `keys.json`'s `index_floor`, honoured once per newer `keys.json` (review #97 M2). */
  indexFloorOf(
    keys: RegistryKeysV1,
    floors: { readonly keysVersion: number | null; readonly indexVersion: number | null },
  ): { readonly floor: number | null; readonly applied: number | null };
}
