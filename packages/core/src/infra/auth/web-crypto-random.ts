/** @module infra/auth/web-crypto-random — `crypto.getRandomValues` adapter with rejection sampling (no modulo bias). */

import type { Random } from '../../ports/random.ts';

/** Largest byte value accepted for an alphabet of `size` symbols: the biggest multiple of `size` below 256. */
export function rejectionLimit(size: number): number {
  return 256 - (256 % size);
}

/**
 * Draws `length` symbols uniformly from `alphabet` using `nextBytes` as the entropy source.
 * Bytes at or above {@link rejectionLimit} are discarded, so `256 % alphabet.length !== 0`
 * introduces no bias: a plain `byte % size` would favour the first symbols of the alphabet (D-09).
 */
export function sampleUnbiased(
  alphabet: string,
  length: number,
  nextBytes: (n: number) => Uint8Array,
): string {
  const size = alphabet.length;
  if (size < 1 || size > 256) throw new RangeError('alphabet must have 1-256 symbols');
  if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be >= 0');
  const limit = rejectionLimit(size);
  let out = '';
  while (out.length < length) {
    const batch = nextBytes(Math.max(16, (length - out.length) * 2));
    for (const byte of batch) {
      if (byte >= limit) continue;
      out += alphabet[byte % size];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Builds the production {@link Random} over Web Crypto. */
export function createWebCryptoRandom(): Random {
  const bytes = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  };
  return { bytes, token: (alphabet, length) => sampleUnbiased(alphabet, length, bytes) };
}
