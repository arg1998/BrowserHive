/** @module infra/browsers/humanize/rng.test — seeded mulberry32 and derived distributions. */

import { describe, expect, it } from 'bun:test';
import {
  chance,
  clamp,
  hashSeed,
  logNormal,
  normal,
  pick,
  seededRng,
  uniform,
  uniformInt,
} from './rng.ts';

describe('hashSeed', () => {
  it('is deterministic and stays inside a 32-bit unsigned range', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    for (const seed of ['', 'a', 'session-abcd1234', '🙂 unicode']) {
      const hash = hashSeed(seed);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('separates similar seeds', () => {
    expect(hashSeed('session-1')).not.toBe(hashSeed('session-2'));
  });
});

describe('seededRng', () => {
  it('replays the same sequence for the same seed', () => {
    // This is what lets a restored profile resurrect the same machine from a persisted seed.
    const a = seededRng('seed');
    const b = seededRng('seed');
    const left = Array.from({ length: 20 }, () => a.next());
    const right = Array.from({ length: 20 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different sequences for different seeds', () => {
    const one = seededRng('one');
    const two = seededRng('two');
    const a = Array.from({ length: 10 }, () => one.next());
    const b = Array.from({ length: 10 }, () => two.next());
    expect(a).not.toEqual(b);
  });

  it('stays inside [0, 1) and is not obviously biased', () => {
    const rng = seededRng('distribution');
    const draws = Array.from({ length: 5_000 }, () => rng.next());
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    const mean = draws.reduce((sum, d) => sum + d, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});

describe('derived distributions', () => {
  it('uniform / uniformInt respect their bounds', () => {
    const rng = seededRng('bounds');
    for (let i = 0; i < 500; i++) {
      const u = uniform(rng, 10, 20);
      expect(u).toBeGreaterThanOrEqual(10);
      expect(u).toBeLessThan(20);
      const n = uniformInt(rng, 3, 5);
      expect([3, 4, 5]).toContain(n);
    }
  });

  it('normal centres on mu with roughly the requested spread', () => {
    const rng = seededRng('normal');
    const draws = Array.from({ length: 4_000 }, () => normal(rng, 100, 15));
    const mean = draws.reduce((s, d) => s + d, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((s, d) => s + (d - mean) ** 2, 0) / draws.length);
    expect(Math.abs(mean - 100)).toBeLessThan(2);
    expect(Math.abs(sd - 15)).toBeLessThan(2);
  });

  it('logNormal is strictly positive and right-skewed', () => {
    // The skew is the point: human intervals are mostly fast with a heavy slow tail, which a
    // symmetric or uniform jitter band cannot reproduce.
    const rng = seededRng('lognormal');
    const draws = Array.from({ length: 4_000 }, () => logNormal(rng, Math.log(130), 0.38));
    expect(Math.min(...draws)).toBeGreaterThan(0);
    const sorted = [...draws].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const mean = draws.reduce((s, d) => s + d, 0) / draws.length;
    expect(median).toBeGreaterThan(110);
    expect(median).toBeLessThan(155);
    expect(mean).toBeGreaterThan(median);
  });

  it('chance fires at roughly the requested rate, and never outside [0,1]', () => {
    const rng = seededRng('chance');
    const hits = Array.from({ length: 5_000 }, () => chance(rng, 0.05)).filter(Boolean).length;
    expect(hits / 5_000).toBeGreaterThan(0.03);
    expect(hits / 5_000).toBeLessThan(0.07);
    expect(chance(rng, 0)).toBe(false);
    expect(chance(rng, 1)).toBe(true);
  });

  it('pick returns a member and throws on an empty list', () => {
    const rng = seededRng('pick');
    expect(['a', 'b', 'c']).toContain(pick(rng, ['a', 'b', 'c']));
    expect(() => pick(rng, [])).toThrow(/non-empty/);
  });

  it('clamp bounds both ends', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
