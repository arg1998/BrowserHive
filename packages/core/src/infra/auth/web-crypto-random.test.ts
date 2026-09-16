/** @module infra/auth/web-crypto-random.test — rejection sampling is unbiased; the adapter draws from Web Crypto. */

import { describe, expect, it } from 'bun:test';
import { SEED_ALPHABET, SEED_PASSWORD_LENGTH } from '../../domain/auth/token-format.ts';
import { createWebCryptoRandom, rejectionLimit, sampleUnbiased } from './web-crypto-random.ts';

describe('sampleUnbiased', () => {
  it('discards bytes at or above the rejection limit', () => {
    expect(rejectionLimit(57)).toBe(228);
    expect(rejectionLimit(64)).toBe(256);
    // Feed a byte stream that starts above the limit: those bytes must be skipped.
    let calls = 0;
    const stream = () => {
      calls += 1;
      return calls === 1 ? Uint8Array.from([255, 228, 0, 1]) : Uint8Array.from([2]);
    };
    expect(sampleUnbiased('abc'.padEnd(57, 'z'), 3, stream)).toBe('abc');
  });

  it('is uniform over a 57-symbol alphabet (chi-square sanity with a counted byte source)', () => {
    // Exhaustive byte source: every byte value 0..255 equally often → exact uniformity expected.
    let cursor = 0;
    const cyclic = (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (cursor + i) & 0xff;
      cursor += n;
      return out;
    };
    const counts = new Map<string, number>();
    const total = 228 * 100;
    for (const ch of sampleUnbiased(SEED_ALPHABET, total, cyclic)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(57);
    for (const n of counts.values()) expect(n).toBe(400);
  });

  it('a real CSPRNG draw is close to uniform (chi-square below the 0.001 critical value)', () => {
    const random = createWebCryptoRandom();
    const samples = 57 * 400;
    const counts = new Map<string, number>();
    for (const ch of random.token(SEED_ALPHABET, samples)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const expected = samples / 57;
    let chi = 0;
    for (const symbol of SEED_ALPHABET) {
      const n = counts.get(symbol) ?? 0;
      chi += (n - expected) ** 2 / expected;
    }
    // df = 56; chi-square critical value at p = 0.001 is ~95.8.
    expect(chi).toBeLessThan(95.8);
  });

  it('draws seed passwords of the right length and alphabet; bytes are random', () => {
    const random = createWebCryptoRandom();
    const pw = random.token(SEED_ALPHABET, SEED_PASSWORD_LENGTH);
    expect(pw).toHaveLength(24);
    for (const ch of pw) expect(SEED_ALPHABET.includes(ch)).toBe(true);
    const a = random.bytes(32);
    const b = random.bytes(32);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects invalid alphabets', () => {
    expect(() => sampleUnbiased('', 1, () => new Uint8Array(1))).toThrow(RangeError);
  });
});
