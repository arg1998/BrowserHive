/** @module ports/random — cryptographically secure randomness capability (tokens, seed passwords). */

/**
 * CSPRNG. `token` must be unbiased for any alphabet length (rejection sampling in the adapter);
 * tests inject a deterministic implementation.
 */
export interface Random {
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
  /** A string of `length` symbols drawn uniformly from `alphabet` (1–256 symbols). */
  token(alphabet: string, length: number): string;
}
