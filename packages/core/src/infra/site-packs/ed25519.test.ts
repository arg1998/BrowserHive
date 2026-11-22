/** @module infra/site-packs/ed25519.test — Bun's `node:crypto` verifies Ed25519 (spec 13 §10.2: proven before anything relies on it), with the RFC 8032 §7.1 test vectors (public keys and signatures only) and keys generated at run time; key ids; the injected trust root's checks. */

import { describe, expect, it } from 'bun:test';
import { sign } from 'node:crypto';
import { rootOf, testKey } from '../../../test/helpers/registry-kit.ts';
import { keyIdOf, parseTrustRoot, verifyEd25519 } from './ed25519.ts';

const hex = (h: string) => Buffer.from(h, 'hex');
const b64 = (h: string) => hex(h).toString('base64');

/** RFC 8032 §7.1, TEST 1 (empty message) and TEST 2 (one byte, 0x72). */
const VECTORS = [
  {
    publicKey: b64('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
    message: hex(''),
    signature: b64(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    ),
  },
  {
    publicKey: b64('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
    message: hex('72'),
    signature: b64(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    ),
  },
];

describe('verifyEd25519', () => {
  it('Bun verifies the RFC 8032 test vectors and refuses any change to them', () => {
    for (const v of VECTORS) {
      expect(verifyEd25519(v.publicKey, v.message, v.signature)).toBe(true);
      expect(verifyEd25519(v.publicKey, Buffer.concat([v.message, hex('00')]), v.signature)).toBe(
        false,
      );
      const flipped = Buffer.from(v.signature, 'base64');
      flipped[0] = (flipped[0] ?? 0) ^ 1;
      expect(verifyEd25519(v.publicKey, v.message, flipped.toString('base64'))).toBe(false);
    }
    expect(
      verifyEd25519(
        VECTORS[1]?.publicKey ?? '',
        VECTORS[0]?.message ?? hex(''),
        VECTORS[0]?.signature ?? '',
      ),
    ).toBe(false);
  });

  it('verifies a signature of a key made at run time over the exact bytes only', () => {
    const key = testKey();
    const bytes = new TextEncoder().encode('{"schema":1}\n');
    const sig = sign(null, bytes, key.privateKey).toString('base64');
    expect(verifyEd25519(key.publicKey, bytes, sig)).toBe(true);
    // No canonicalisation: the same JSON without its newline is other bytes.
    expect(verifyEd25519(key.publicKey, bytes.subarray(0, -1), sig)).toBe(false);
    expect(verifyEd25519(testKey().publicKey, bytes, sig)).toBe(false);
  });

  it('a malformed key or signature is false, never a throw', () => {
    const key = testKey();
    const bytes = new Uint8Array([1, 2, 3]);
    const sig = sign(null, bytes, key.privateKey).toString('base64');
    expect(verifyEd25519('not base64!', bytes, sig)).toBe(false);
    expect(verifyEd25519(Buffer.alloc(31).toString('base64'), bytes, sig)).toBe(false);
    expect(
      verifyEd25519(
        Buffer.alloc(32).toString('base64'),
        bytes,
        Buffer.alloc(64).toString('base64'),
      ),
    ).toBe(false);
    expect(verifyEd25519(key.publicKey, bytes, 'AAAA')).toBe(false);
  });
});

describe('keyIdOf', () => {
  it('is the first 16 hex digits of SHA-256 over the raw key', () => {
    expect(keyIdOf(VECTORS[0]?.publicKey ?? '')).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(testKey().publicKey)).not.toBe(keyIdOf(testKey().publicKey));
    expect(keyIdOf('short')).toBeNull();
  });
});

describe('parseTrustRoot', () => {
  it('accepts keys whose ids match their public keys', () => {
    const root = rootOf(testKey(), testKey());
    const parsed = parseTrustRoot(root);
    expect(parsed.ok).toBe(true);
  });

  it('refuses an empty list, a wrong id, extra fields and junk', () => {
    const key = testKey();
    expect(parseTrustRoot({ keys: [] }).ok).toBe(false);
    expect(
      parseTrustRoot({ keys: [{ keyId: '0000000000000000', publicKey: key.publicKey }] }).ok,
    ).toBe(false);
    expect(
      parseTrustRoot({ keys: [{ keyId: key.keyId, publicKey: key.publicKey, extra: 1 }] }).ok,
    ).toBe(false);
    expect(parseTrustRoot('keys').ok).toBe(false);
  });
});
