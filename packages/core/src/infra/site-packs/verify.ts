/** @module infra/site-packs/verify — the registry trust chain (spec 13 §10.2, §10.3 steps 1–3): `keys.json` signed by a root key, `index.json` signed by a valid online key of it, and each listed pack file trusted only through the index's `sha256` and `size`. Ed25519 over the exact file bytes (`ed25519.ts`). The stored rollback floors are optional inputs (the client keeps them from T4b; `sitepacks verify` has none). Pure apart from the clock value passed in; never throws. */

import {
  REGISTRY_INDEX_MAX_BYTES,
  REGISTRY_KEYS_MAX_BYTES,
  REGISTRY_SIG_MAX_BYTES,
  RegistryIndexV1,
  RegistryKeysV1,
  type RegistryPackVersion,
  RegistrySignatures,
  SITE_PACK_MAX_BYTES,
} from '@browserhive/contracts/site-packs';
import type { z } from 'zod';
import { loadPackBytes, sha256Hex } from '../../domain/site-packs/load.ts';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { SitePacksTrustRoot, SourcePackVersion } from '../../ports/site-packs.ts';
import { verifyEd25519 } from './ed25519.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Clock skew allowed on `keys.json.expires` (spec 13 §10.3 step 1). */
export const KEYS_SKEW_MS = HOUR_MS;
/** How far in the future `issued_at` may be (step 2). */
export const ISSUED_AHEAD_MS = 5 * 60_000;
/** The fast-forward bound on `index.json.version` (step 2). */
export const INDEX_FAST_FORWARD = 100_000;
/** `keys.json.expires` is at most this far ahead (§10.2). */
export const KEYS_MAX_LIFETIME_MS = 120 * DAY_MS;
/** An online key's `not_after` is at most this far ahead (§10.2). */
export const ONLINE_KEY_MAX_LIFETIME_MS = 90 * DAY_MS;
/** `index.json.expires` is at most this long after `issued_at` (§10.2). */
export const INDEX_MAX_LIFETIME_MS = 14 * DAY_MS;

/** Why a registry file was refused. */
export type RegistryRefusalReason =
  | 'no_trust_root'
  | 'missing'
  | 'too_large'
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'key_expired'
  | 'issued_in_future'
  | 'out_of_bounds'
  | 'rollback'
  | 'fast_forward'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'pack_mismatch'
  | 'invalid_pack';

/** A refused registry file. */
export interface RegistryRefusal {
  /** The file, relative to `registry/v1/`. */
  readonly file: string;
  readonly reason: RegistryRefusalReason;
  readonly detail: string;
}

/** An accepted, signed file and the key whose signature verified. */
export interface Verified<T> {
  readonly value: T;
  readonly signedBy: string;
}

function refusal(file: string, reason: RegistryRefusalReason, detail: string) {
  return err<RegistryRefusal>({ file, reason, detail });
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** UTF-8 JSON, or `undefined`. */
function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * The first signature of `sigBytes` by one of `keys` that verifies over `bytes`.
 *
 * @returns The signing key id, or why none verified (`unknown_key`: no signature by a listed key).
 */
function checkSignature(
  file: string,
  bytes: Uint8Array,
  sigBytes: Uint8Array,
  keys: ReadonlyMap<string, string>,
): Result<string, RegistryRefusal> {
  const sigFile = `${file}.sig`;
  if (sigBytes.byteLength > REGISTRY_SIG_MAX_BYTES) {
    return refusal(sigFile, 'too_large', `${sigBytes.byteLength} bytes`);
  }
  const parsed = RegistrySignatures.safeParse(jsonOf(sigBytes));
  if (!parsed.success) return refusal(sigFile, 'malformed', issuesOf(parsed.error));
  let known = false;
  for (const { key_id, sig } of parsed.data.signatures) {
    const publicKey = keys.get(key_id);
    if (publicKey === undefined) continue;
    known = true;
    if (verifyEd25519(publicKey, bytes, sig)) return ok(key_id);
  }
  return known
    ? refusal(sigFile, 'bad_signature', 'no signature verifies over the file')
    : refusal(sigFile, 'unknown_key', 'signed by no trusted key');
}

/** Inputs of {@link verifyKeys}. */
export interface VerifyKeysInput {
  readonly bytes: Uint8Array;
  readonly sig: Uint8Array;
  readonly root: SitePacksTrustRoot;
  /** Epoch ms. */
  readonly now: number;
  /** The highest `keys.json` version accepted before (`site_packs.keys_version`); `null` for none. */
  readonly floor: number | null;
}

/** Step 1: `keys.json` against the pinned root keys. */
export function verifyKeys(
  input: VerifyKeysInput,
): Result<Verified<RegistryKeysV1>, RegistryRefusal> {
  const file = 'keys.json';
  if (input.root.keys.length === 0) {
    return refusal(file, 'no_trust_root', 'this build pins no registry root keys');
  }
  if (input.bytes.byteLength > REGISTRY_KEYS_MAX_BYTES) {
    return refusal(file, 'too_large', `${input.bytes.byteLength} bytes`);
  }
  const roots = new Map(input.root.keys.map((k) => [k.keyId, k.publicKey]));
  const signed = checkSignature(file, input.bytes, input.sig, roots);
  if (!signed.ok) return signed;
  const parsed = RegistryKeysV1.safeParse(jsonOf(input.bytes));
  if (!parsed.success) return refusal(file, 'malformed', issuesOf(parsed.error));
  const keys = parsed.data;
  const expires = Date.parse(keys.expires);
  if (input.floor !== null && keys.version < input.floor) {
    return refusal(file, 'rollback', `version ${keys.version} is below ${input.floor}`);
  }
  if (input.now >= expires + KEYS_SKEW_MS)
    return refusal(file, 'expired', `expired ${keys.expires}`);
  if (expires > input.now + KEYS_MAX_LIFETIME_MS + KEYS_SKEW_MS) {
    return refusal(file, 'out_of_bounds', `expires ${keys.expires}, more than 120 days ahead`);
  }
  for (const key of keys.online) {
    if (Date.parse(key.not_after) > input.now + ONLINE_KEY_MAX_LIFETIME_MS + KEYS_SKEW_MS) {
      return refusal(file, 'out_of_bounds', `online key ${key.key_id} is valid more than 90 days`);
    }
  }
  return ok({ value: keys, signedBy: signed.value });
}

/** Inputs of {@link verifyIndex}. */
export interface VerifyIndexInput {
  readonly bytes: Uint8Array;
  readonly sig: Uint8Array;
  /** The accepted `keys.json`. */
  readonly keys: RegistryKeysV1;
  readonly now: number;
  /** The highest index version accepted before (or `keys.json`'s `index_floor`); `null` for none. */
  readonly floor: number | null;
}

/** Step 2: `index.json` against the online keys of the accepted `keys.json`. */
export function verifyIndex(
  input: VerifyIndexInput,
): Result<Verified<RegistryIndexV1>, RegistryRefusal> {
  const file = 'index.json';
  if (input.bytes.byteLength > REGISTRY_INDEX_MAX_BYTES) {
    return refusal(file, 'too_large', `${input.bytes.byteLength} bytes`);
  }
  const online = new Map(input.keys.online.map((k) => [k.key_id, k.public_key]));
  const signed = checkSignature(file, input.bytes, input.sig, online);
  if (!signed.ok) return signed;
  const parsed = RegistryIndexV1.safeParse(jsonOf(input.bytes));
  if (!parsed.success) return refusal(file, 'malformed', issuesOf(parsed.error));
  const index = parsed.data;
  const key = input.keys.online.find((k) => k.key_id === signed.value);
  const notAfter = key === undefined ? 0 : Date.parse(key.not_after);
  const issued = Date.parse(index.issued_at);
  const expires = Date.parse(index.expires);
  if (input.now >= notAfter || issued >= notAfter) {
    return refusal(
      file,
      'key_expired',
      `online key ${signed.value} is valid until ${key?.not_after}`,
    );
  }
  if (issued > input.now + ISSUED_AHEAD_MS) {
    return refusal(file, 'issued_in_future', `issued ${index.issued_at}`);
  }
  if (expires - issued > INDEX_MAX_LIFETIME_MS || expires <= issued) {
    return refusal(file, 'out_of_bounds', 'expires more than 14 days after issued_at');
  }
  if (input.floor !== null) {
    if (index.version <= input.floor) {
      return refusal(file, 'rollback', `version ${index.version} is not above ${input.floor}`);
    }
    if (index.version > input.floor + INDEX_FAST_FORWARD) {
      return refusal(
        file,
        'fast_forward',
        `version ${index.version} is too far above ${input.floor}`,
      );
    }
  }
  if (input.now >= expires) return refusal(file, 'expired', `expired ${index.expires}`);
  return ok({ value: index, signedBy: signed.value });
}

/** A listed pack file that verified but needs another BrowserHive (`min_client`/`max_client`). */
export interface OutOfRange {
  readonly outOfRange: string;
}

/**
 * Step 3: one pack file against its index entry: size, SHA-256, the pack schema and refinements,
 * and the entry's id, version and client range. With `binaryVersion`, a version that needs
 * another BrowserHive is reported, not refused.
 */
export function verifyListedPack(
  bytes: Uint8Array,
  packId: string,
  entry: RegistryPackVersion,
  binaryVersion: string | null,
): Result<SourcePackVersion | OutOfRange, RegistryRefusal> {
  const file = entry.path;
  if (bytes.byteLength > SITE_PACK_MAX_BYTES) {
    return refusal(file, 'too_large', `${bytes.byteLength} bytes`);
  }
  if (bytes.byteLength !== entry.size) {
    return refusal(
      file,
      'size_mismatch',
      `${bytes.byteLength} bytes, the index says ${entry.size}`,
    );
  }
  if (sha256Hex(bytes) !== entry.sha256) {
    return refusal(file, 'hash_mismatch', 'the SHA-256 is not the one the index lists');
  }
  const loaded = loadPackBytes(bytes, { origin: file, binaryVersion, expectedId: packId });
  if (!loaded.ok) {
    if (loaded.error.reason === 'min_client') return ok({ outOfRange: loaded.error.detail });
    return refusal(file, 'invalid_pack', `${loaded.error.reason}: ${loaded.error.detail}`);
  }
  const { pack } = loaded.value;
  if (
    pack.version !== entry.v ||
    pack.min_client !== entry.min_client ||
    pack.max_client !== entry.max_client
  ) {
    return refusal(file, 'pack_mismatch', 'the version or client range is not the one listed');
  }
  return ok(loaded.value);
}
