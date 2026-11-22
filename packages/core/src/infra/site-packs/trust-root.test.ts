/** @module infra/site-packs/trust-root.test — the pinned root keys are exactly `registry/keys/root-1.pub` and `root-2.pub` (spec 13 §10.2): both placeholders and nothing pinned before the key ceremony, or both real keys, pinned with their ids, never a throwaway test key. */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { keyIdOf } from './ed25519.ts';
import { PINNED_ROOT_KEYS, PINNED_TRUST_ROOT, trustsNothing } from './trust-root.ts';

/** `registry/keys` at the repository root (this file lives at packages/core/src/infra/site-packs). */
const KEYS = resolve(import.meta.dir, '..', '..', '..', '..', '..', 'registry', 'keys');

const PubFile = z.union([
  z.object({ placeholder: z.literal(true), slot: z.number() }),
  z.object({
    slot: z.number(),
    key_id: z.string(),
    public_key: z.string(),
    test: z.boolean().optional(),
  }),
]);

const pubs = [1, 2].map((slot) =>
  PubFile.parse(JSON.parse(readFileSync(join(KEYS, `root-${slot}.pub`), 'utf8'))),
);

describe('the pinned trust root', () => {
  it('both .pub files exist, one per slot', () => {
    expect(existsSync(join(KEYS, 'root-1.pub')) && existsSync(join(KEYS, 'root-2.pub'))).toBe(true);
    expect(pubs.map((p) => p.slot)).toEqual([1, 2]);
  });

  it('pins exactly the keys of registry/keys (nothing while they are placeholders)', () => {
    const real = pubs.flatMap((p) =>
      'public_key' in p ? [{ keyId: p.key_id, publicKey: p.public_key }] : [],
    );
    expect(real.length === 0 || real.length === 2).toBe(true);
    expect([...PINNED_ROOT_KEYS]).toEqual(real);
    expect(trustsNothing(PINNED_TRUST_ROOT)).toBe(real.length === 0);
  });

  it('every pinned key carries its own id and is no test key', () => {
    for (const key of PINNED_ROOT_KEYS) expect(keyIdOf(key.publicKey)).toBe(key.keyId);
    for (const pub of pubs) expect('test' in pub && pub.test === true).toBe(false);
    expect(new Set(PINNED_ROOT_KEYS.map((k) => k.keyId)).size).toBe(PINNED_ROOT_KEYS.length);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(PINNED_TRUST_ROOT)).toBe(true);
    expect(Object.isFrozen(PINNED_TRUST_ROOT.keys)).toBe(true);
  });
});
