/** @module ports/password-hasher — slow password hashing capability (Argon2id in production, spec 03 §3.4). */

/**
 * Hashes and verifies operator passwords. The production adapter is `Bun.password` with
 * explicit Argon2id parameters; tests use a transparent fake.
 */
export interface PasswordHasher {
  /** Returns a self-describing (PHC) hash of `secret`. */
  hash(secret: string): Promise<string>;
  /** True when `secret` matches `hash`; never throws on malformed hashes (returns false). */
  verify(secret: string, hash: string): Promise<boolean>;
  /** True when `hash` was produced with weaker parameters than the current ones. */
  needsRehash(hash: string): boolean;
}
