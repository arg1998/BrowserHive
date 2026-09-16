/** @module infra/auth/bun-password-hasher — Argon2id via `Bun.password` with the explicit spec 03 §3.4 parameters. */

import type { PasswordHasher } from '../../ports/password-hasher.ts';

/** Argon2id parameters (spec 03 §3.4): 64 MiB, 3 passes. */
export const ARGON2_PARAMS = {
  algorithm: 'argon2id',
  memoryCost: 65536,
  timeCost: 3,
} as const;

const PHC_RE = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=\d+\$/;

/** Parses the cost parameters of a PHC-encoded Argon2id hash. */
export function parseArgon2Params(hash: string): { memoryCost: number; timeCost: number } | null {
  const match = PHC_RE.exec(hash);
  if (match === null) return null;
  return { memoryCost: Number(match[1]), timeCost: Number(match[2]) };
}

/** Builds the production {@link PasswordHasher}. */
export function createBunPasswordHasher(): PasswordHasher {
  return {
    hash(secret) {
      return Bun.password.hash(secret, ARGON2_PARAMS);
    },
    async verify(secret, hash) {
      try {
        return await Bun.password.verify(secret, hash);
      } catch {
        return false;
      }
    },
    needsRehash(hash) {
      const params = parseArgon2Params(hash);
      if (params === null) return true;
      return (
        params.memoryCost < ARGON2_PARAMS.memoryCost || params.timeCost < ARGON2_PARAMS.timeCost
      );
    },
  };
}
