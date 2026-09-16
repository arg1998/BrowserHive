/** @module infra/auth/bun-password-hasher.test — Argon2id parameters, verify, needsRehash. */

import { describe, expect, it } from 'bun:test';
import {
  ARGON2_PARAMS,
  createBunPasswordHasher,
  parseArgon2Params,
} from './bun-password-hasher.ts';

describe('bun password hasher', () => {
  it('hashes with argon2id m=65536 t=3 and verifies', async () => {
    const hasher = createBunPasswordHasher();
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(parseArgon2Params(hash)).toEqual({ memoryCost: 65536, timeCost: 3 });
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
    expect(await hasher.verify('wrong', hash)).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  }, 20_000);

  it('verify never throws on garbage and needsRehash flags weaker parameters', async () => {
    const hasher = createBunPasswordHasher();
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(hasher.needsRehash('not-a-hash')).toBe(true);
    const weaker = `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost / 2},t=3,p=1$c2FsdA$aGFzaA`;
    expect(hasher.needsRehash(weaker)).toBe(true);
    expect(hasher.needsRehash('$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(hasher.needsRehash('$argon2id$v=19$m=131072,t=4,p=1$c2FsdA$aGFzaA')).toBe(false);
  });
});
