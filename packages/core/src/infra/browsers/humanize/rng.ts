/** @module infra/browsers/humanize/rng — seeded (mulberry32) and system randomness for identity derivation and humanized input. */

/**
 * Seeded pseudo-randomness for the stealth layer.
 *
 * Two subsystems need randomness that is **reproducible from a seed** rather than from `Math.random`:
 *
 *   - **Identity derivation** — a session's presented screen/viewport/`hardwareConcurrency` must be
 *     stable for the life of that identity, so a restored profile resurrects the *same* machine it
 *     was saved as. Persisting the seed and re-deriving is smaller and less brittle than persisting
 *     every derived field.
 *   - **Humanized input** — a curved pointer path is only useful if it is unpredictable to the page,
 *     but a test that asserts anything about it needs it to be predictable to *us*. A seeded stream
 *     gives both.
 *
 * `mulberry32` is the generator: 32-bit state, four operations per draw, a full 2^32 period, and it
 * passes gjrand's smallcrush — far beyond what path jitter needs, and small enough to read in one
 * sitting. It is **not** cryptographic and must never be used for anything that is (the vault's
 * secrets go through `node:crypto`).
 */

/** A stream of uniform `[0, 1)` draws. */
export interface Rng {
  /** Next uniform draw in `[0, 1)`. */
  next(): number;
}

/**
 * FNV-1a (32-bit) — hash an arbitrary seed string into the 32-bit integer `mulberry32` wants. Chosen
 * for being byte-exact reproducible across platforms and trivially auditable, not for collision
 * resistance (a collision here means two sessions share a screen size).
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    // 32-bit FNV prime multiply, expressed as shifts so it stays inside a 32-bit int.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic {@link Rng} seeded by a string (a session id, a persisted identity seed, a test
 * constant). The same seed always yields the same sequence.
 */
export function seededRng(seed: string): Rng {
  let state = hashSeed(seed);
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Non-deterministic {@link Rng} backed by `Math.random`. The production default for *pointer/typing*
 * jitter, where predictability is the thing we are trying to avoid. Identity derivation always uses
 * {@link seededRng} instead, because identities must be reproducible.
 */
export function systemRng(): Rng {
  return { next: () => Math.random() };
}

/** Uniform draw in `[min, max)`. */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}

/** Uniform integer in `[min, max]` (both inclusive). */
export function uniformInt(rng: Rng, min: number, max: number): number {
  return Math.floor(uniform(rng, min, max + 1));
}

/**
 * Standard-normal draw via the Box–Muller transform. `rng.next()` can return exactly `0`, whose
 * `log` is `-Infinity`, so the draw is nudged off zero.
 */
export function standardNormal(rng: Rng): number {
  const u = Math.max(rng.next(), Number.MIN_VALUE);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Normal draw with mean `mu` and standard deviation `sigma`. */
export function normal(rng: Rng, mu: number, sigma: number): number {
  return mu + sigma * standardNormal(rng);
}

/**
 * Log-normal draw: `exp(normal(mu, sigma))`, where `mu`/`sigma` are the parameters of the
 * **underlying normal**, not of the resulting distribution. This is the standard model for human
 * inter-keystroke and reaction-time intervals — strictly positive, right-skewed, with the heavy tail
 * that makes occasional long pauses look natural instead of like a uniform jitter band.
 */
export function logNormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(normal(rng, mu, sigma));
}

/**
 * Uniformly pick one element.
 *
 * @throws `INTERNAL_ERROR`-free plain `Error` on an empty list — a caller bug, never a runtime condition.
 */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[uniformInt(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error('pick() requires a non-empty list');
  return item;
}

/** True with probability `p`. `p <= 0` never fires, `p >= 1` always does. */
export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
