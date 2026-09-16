/** @module domain/auth/token-format.test — token grammar, prefix, digest and constant-time compare. */

import { describe, expect, it } from 'bun:test';
import { BEARER_TOKEN_RE } from '@browserhive/contracts/http';
import { createSeededRandom } from '../../../test/helpers/fake-auth.ts';
import { constantTimeEqual, matchesHash, sha256Hex } from './digest.ts';
import {
  generateSeedPassword,
  idPrefix,
  mintSecret,
  mintToken,
  parseToken,
  SEED_ALPHABET,
} from './token-format.ts';

const random = createSeededRandom();

describe('token grammar', () => {
  it('mints bh_<kind>_<43 base64url> tokens that match the contracts regex', () => {
    for (const kind of ['agent', 'operator', 'grant'] as const) {
      const { token, publicPrefix } = mintToken(random, kind);
      expect(token.startsWith(`bh_${kind}_`)).toBe(true);
      expect(BEARER_TOKEN_RE.test(token)).toBe(true);
      expect(publicPrefix).toHaveLength(8);
      expect(token.slice(`bh_${kind}_`.length, `bh_${kind}_`.length + 8)).toBe(publicPrefix);
      const parsed = parseToken(token);
      expect(parsed).toEqual({ kind, publicPrefix, secret: token.slice(`bh_${kind}_`.length) });
    }
  });

  it('rejects malformed literals', () => {
    expect(parseToken('')).toBeNull();
    expect(parseToken('bh_agent_short')).toBeNull();
    expect(parseToken(`bh_service_${'a'.repeat(43)}`)).toBeNull();
    expect(parseToken(`xx_agent_${'a'.repeat(43)}`)).toBeNull();
    expect(parseToken(`bh_agent_${'a'.repeat(42)}=`)).toBeNull();
  });

  it('session secrets are 43 chars of base64url', () => {
    const s = mintSecret(random);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintSecret(random)).not.toBe(s);
  });

  it('id prefix is the first eight characters', () => {
    expect(idPrefix('abcdefghijkl')).toBe('abcdefgh');
  });

  it('seed passwords are 24 chars from the look-alike-free alphabet', () => {
    const pw = generateSeedPassword(random);
    expect(pw).toHaveLength(24);
    for (const ch of pw) expect(SEED_ALPHABET.includes(ch)).toBe(true);
    expect(SEED_ALPHABET).not.toMatch(/[0O1lI]/);
  });
});

describe('digest', () => {
  it('sha256Hex is deterministic hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('constantTimeEqual compares equal and unequal strings, any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('matchesHash verifies a literal against its stored digest', () => {
    const hash = sha256Hex('tok');
    expect(matchesHash('tok', hash)).toBe(true);
    expect(matchesHash('tok2', hash)).toBe(false);
  });
});
