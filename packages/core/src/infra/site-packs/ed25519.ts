/** @module infra/site-packs/ed25519 — Ed25519 for the registry (spec 13 §10.2): key ids, raw public keys and signature checks over exact bytes with `node:crypto` `verify(null, …)`. No canonicalisation: a signature covers the file as it was written. Never throws. */

import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { RegistryKeyId, RegistryPublicKey } from '@browserhive/contracts/site-packs';
import { z } from 'zod';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { SitePacksTrustRoot } from '../../ports/site-packs.ts';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** The raw bytes of a base64 public key, or `null` when it is not 32 bytes. */
function rawKeyOf(publicKey: string): Uint8Array | null {
  if (!RegistryPublicKey.safeParse(publicKey).success) return null;
  const raw = Uint8Array.from(Buffer.from(publicKey, 'base64'));
  return raw.byteLength === 32 ? raw : null;
}

/** The key id of a base64 raw public key: the first 16 hex digits of its SHA-256; `null` when malformed. */
export function keyIdOf(publicKey: string): string | null {
  const raw = rawKeyOf(publicKey);
  return raw === null ? null : createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const keyObjects = new Map<string, KeyObject | null>();

/** The `KeyObject` of a base64 raw public key (cached), or `null` when it cannot be imported. */
function keyObjectOf(publicKey: string): KeyObject | null {
  const cached = keyObjects.get(publicKey);
  if (cached !== undefined) return cached;
  const raw = rawKeyOf(publicKey);
  let key: KeyObject | null = null;
  if (raw !== null) {
    try {
      const der = new Uint8Array(SPKI_PREFIX.byteLength + raw.byteLength);
      der.set(SPKI_PREFIX, 0);
      der.set(raw, SPKI_PREFIX.byteLength);
      key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
    } catch {
      key = null;
    }
  }
  if (keyObjects.size > 64) keyObjects.clear();
  keyObjects.set(publicKey, key);
  return key;
}

/**
 * Whether `signature` (base64, 64 bytes) is `publicKey`'s Ed25519 signature over exactly `bytes`.
 * A malformed key or signature is `false`.
 */
export function verifyEd25519(publicKey: string, bytes: Uint8Array, signature: string): boolean {
  const key = keyObjectOf(publicKey);
  if (key === null) return false;
  const sig = Buffer.from(signature, 'base64');
  if (sig.byteLength !== 64) return false;
  try {
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

/** The shape of an injected trust root (`createServer({ testing: { sitePacksTrustRoot } })`). */
const TrustRootInput = z.strictObject({
  keys: z
    .array(z.strictObject({ keyId: RegistryKeyId, publicKey: RegistryPublicKey }))
    .min(1)
    .max(4),
});

/**
 * Checks an injected trust root: one to four keys, each importable, each with the key id of its
 * public key.
 *
 * @returns The root, or the reason it was refused.
 */
export function parseTrustRoot(input: unknown): Result<SitePacksTrustRoot, string> {
  const parsed = TrustRootInput.safeParse(input);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  for (const key of parsed.data.keys) {
    if (keyObjectOf(key.publicKey) === null) return err(`${key.keyId}: not an Ed25519 key`);
    if (keyIdOf(key.publicKey) !== key.keyId) {
      return err(`${key.keyId}: the key id is not the one of its public key`);
    }
  }
  return ok({ keys: parsed.data.keys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })) });
}
