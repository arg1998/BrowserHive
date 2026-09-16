/** @module domain/vault/origin.property.test — seeded property test over host/pattern pairs (500 fast, 10k nightly) */

import { describe, expect, it } from 'bun:test';
import { checkOrigin } from './origin.ts';

/**
 * Property test over random host/pattern pairs: a wildcard never matches a foreign registrable
 * domain, an exact host never matches a different host, and the check is deterministic. The fast
 * suite runs 500 pairs × 10 runs; `BROWSERHIVE_NIGHTLY=1` runs 10 000 pairs × 100 runs.
 */
const NIGHTLY = process.env['BROWSERHIVE_NIGHTLY'] === '1';
const PAIRS = NIGHTLY ? 10_000 : 500;
const RUNS = NIGHTLY ? 100 : 10;

const bases = ['linkedin.com', 'example.co.uk', 'github.io', 'google.com', 'my-site.org'];
const subs = ['', 'www.', 'm.', 'a.b.', 'login.'];
const attackers = ['attacker.com', 'evil.net'];

/** Seeded xorshift so a failure is reproducible. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

interface Pair {
  readonly url: string;
  readonly patterns: readonly string[];
  readonly expected: 'pass' | 'fail';
}

function makePair(next: () => number): Pair {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T;
  const base = pick(bases);
  const kind = Math.floor(next() * 4);
  if (kind === 0) {
    return { url: `https://${pick(subs)}${base}/path`, patterns: [`*.${base}`], expected: 'pass' };
  }
  if (kind === 1) {
    return {
      url: `https://${base}.${pick(attackers)}/`,
      patterns: [`*.${base}`],
      expected: 'fail',
    };
  }
  if (kind === 2) return { url: `https://not${base}/`, patterns: [`*.${base}`], expected: 'fail' };
  // exact host: only the apex passes; any subdomain fails
  const sub = pick(subs);
  return {
    url: `https://${sub}${base}/x`,
    patterns: [base],
    expected: sub === '' ? 'pass' : 'fail',
  };
}

describe(`checkOrigin — property (${PAIRS} pairs × ${RUNS} runs)`, () => {
  it('wildcard matches iff registrable domain equals the base; exact host matches only itself', () => {
    const next = rng(0x5eed);
    const pairs = Array.from({ length: PAIRS }, () => makePair(next));
    const baseline = pairs.map((p) => {
      const outcome = checkOrigin(p.url, p.patterns).outcome;
      expect(outcome).toBe(p.expected);
      return outcome;
    });
    for (let run = 1; run < RUNS; run += 1) {
      const outcomes = pairs.map((p) => checkOrigin(p.url, p.patterns).outcome);
      expect(outcomes).toEqual(baseline);
    }
  });

  it('determinism: identical inputs give identical full results', () => {
    const next = rng(42);
    for (let i = 0; i < (NIGHTLY ? 2000 : 200); i += 1) {
      const base = bases[Math.floor(next() * bases.length)] ?? 'linkedin.com';
      const url = `https://${subs[Math.floor(next() * subs.length)] ?? ''}${base}/x?q=${i}`;
      expect(checkOrigin(url, [`*.${base}`, 'other.com'])).toEqual(
        checkOrigin(url, [`*.${base}`, 'other.com']),
      );
    }
  });
});
