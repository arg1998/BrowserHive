/** @module infra/site-packs/verify.test — the registry trust chain (spec 13 §10.3 steps 1–3) with keys made at run time: each refusal of `keys.json`, `index.json` and a listed pack file (expired, rolled back, fast-forwarded, issued in the future, an online key past `not_after`, a wrong or unknown key, a swapped or oversized file, lifetimes past the §10.2 bounds). */

import { describe, expect, it } from 'bun:test';
import type { RegistryKeysV1 } from '@browserhive/contracts/site-packs';
import { RegistryIndexV1 } from '@browserhive/contracts/site-packs';
import {
  buildLayout,
  canonical,
  iso,
  rootOf,
  sigOf,
  testKey,
} from '../../../test/helpers/registry-kit.ts';
import { packBytes, sitePack } from '../../../test/helpers/site-pack-kit.ts';
import { PINNED_TRUST_ROOT, trustsNothing } from './trust-root.ts';
import { verifyIndex, verifyKeys, verifyListedPack } from './verify.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const DAY = 86_400_000;
const PACK = sitePack('site-a.test', 3);

function files(layout: ReturnType<typeof buildLayout>, name: string): Uint8Array {
  const bytes = layout.files.get(name);
  if (bytes === undefined) throw new Error(name);
  return bytes;
}

function keysOf(layout: ReturnType<typeof buildLayout>, now = NOW, floor: number | null = null) {
  return verifyKeys({
    bytes: files(layout, 'keys.json'),
    sig: files(layout, 'keys.json.sig'),
    root: layout.trustRoot,
    now,
    floor,
  });
}

function indexOf(layout: ReturnType<typeof buildLayout>, now = NOW, floor: number | null = null) {
  const keys = keysOf(layout, now);
  if (!keys.ok) throw new Error(keys.error.reason);
  return verifyIndex({
    bytes: files(layout, 'index.json'),
    sig: files(layout, 'index.json.sig'),
    keys: keys.value.value,
    now,
    floor,
  });
}

function reason(result: { ok: boolean; error?: { reason: string } }): string | null {
  return result.ok ? null : (result.error?.reason ?? null);
}

describe('keys.json (step 1)', () => {
  it('verifies against either pinned root key', () => {
    const layout = buildLayout({ now: NOW, packs: [PACK] });
    const second = testKey();
    const keys = verifyKeys({
      bytes: files(layout, 'keys.json'),
      sig: files(layout, 'keys.json.sig'),
      root: rootOf(second, layout.root),
      now: NOW,
      floor: null,
    });
    expect(keys.ok && keys.value.signedBy).toBe(layout.root.keyId);
  });

  it('this build pins no root yet: every layout is refused', () => {
    const layout = buildLayout({ now: NOW });
    expect(trustsNothing(PINNED_TRUST_ROOT)).toBe(PINNED_TRUST_ROOT.keys.length === 0);
    const pinned = verifyKeys({
      bytes: files(layout, 'keys.json'),
      sig: files(layout, 'keys.json.sig'),
      root: PINNED_TRUST_ROOT,
      now: NOW,
      floor: null,
    });
    expect(pinned.ok).toBe(false);
  });

  it('refuses an unknown key, a bad signature and a changed file', () => {
    const layout = buildLayout({ now: NOW });
    expect(
      reason(
        verifyKeys({
          bytes: files(layout, 'keys.json'),
          sig: files(layout, 'keys.json.sig'),
          root: rootOf(testKey()),
          now: NOW,
          floor: null,
        }),
      ),
    ).toBe('unknown_key');
    const changed = canonical({ ...layout.keysDoc, version: 2 });
    expect(
      reason(
        verifyKeys({
          bytes: changed,
          sig: files(layout, 'keys.json.sig'),
          root: layout.trustRoot,
          now: NOW,
          floor: null,
        }),
      ),
    ).toBe('bad_signature');
    expect(
      reason(
        verifyKeys({
          bytes: files(layout, 'keys.json'),
          sig: new TextEncoder().encode('{'),
          root: layout.trustRoot,
          now: NOW,
          floor: null,
        }),
      ),
    ).toBe('malformed');
  });

  it('refuses an expired file (past the hour of skew), a rollback, and a lifetime past 120 days', () => {
    const layout = buildLayout({ now: NOW });
    const expires = Date.parse(String(layout.keysDoc['expires']));
    expect(keysOf(layout, expires + 59 * 60_000).ok).toBe(true);
    expect(reason(keysOf(layout, expires + 61 * 60_000))).toBe('expired');
    expect(reason(keysOf(buildLayout({ now: NOW, keys: { version: 4 } }), NOW, 5))).toBe(
      'rollback',
    );
    expect(keysOf(buildLayout({ now: NOW, keys: { version: 5 } }), NOW, 5).ok).toBe(true);
    expect(reason(keysOf(buildLayout({ now: NOW, keys: { expires: iso(NOW + 130 * DAY) } })))).toBe(
      'out_of_bounds',
    );
  });
});

describe('index.json (step 2)', () => {
  it('verifies against an online key of the accepted keys.json', () => {
    const layout = buildLayout({ now: NOW, packs: [PACK] });
    const index = indexOf(layout);
    expect(index.ok && index.value.signedBy).toBe(layout.online.keyId);
    expect(index.ok && RegistryIndexV1.parse(index.value.value).packs[0]?.id).toBe('site-a.test');
  });

  it('refuses a wrong online key (signed by the root, or by a key keys.json does not list)', () => {
    const layout = buildLayout({ now: NOW });
    const index = files(layout, 'index.json');
    layout.files.set('index.json.sig', sigOf(index, layout.root));
    expect(reason(indexOf(layout))).toBe('unknown_key');
    layout.files.set('index.json.sig', sigOf(index, testKey()));
    expect(reason(indexOf(layout))).toBe('unknown_key');
  });

  it('refuses an expired index, a rollback, a fast-forward and an index issued in the future', () => {
    const layout = buildLayout({ now: NOW });
    const expires = Date.parse(String(layout.indexDoc['expires']));
    expect(reason(indexOf(layout, expires))).toBe('expired');
    expect(reason(indexOf(layout, NOW, 10))).toBe('rollback');
    expect(indexOf(layout, NOW, 9).ok).toBe(true);
    expect(reason(indexOf(buildLayout({ now: NOW, index: { version: 100_011 } }), NOW, 10))).toBe(
      'fast_forward',
    );
    expect(indexOf(buildLayout({ now: NOW, index: { version: 100_010 } }), NOW, 10).ok).toBe(true);
    const ahead = buildLayout({ now: NOW, index: { issued_at: iso(NOW + 6 * 60_000) } });
    expect(reason(indexOf(ahead))).toBe('issued_in_future');
    expect(indexOf(buildLayout({ now: NOW, index: { issued_at: iso(NOW + 4 * 60_000) } })).ok).toBe(
      true,
    );
  });

  it('refuses an index from an online key past not_after, or issued after it', () => {
    const late = buildLayout({ now: NOW });
    const notAfter = Date.parse(
      String((late.keysDoc['online'] as RegistryKeysV1['online'])[0]?.not_after),
    );
    expect(reason(indexOf(late, notAfter))).toBe('key_expired');
    const online = testKey();
    const issuedLate = buildLayout({
      now: NOW,
      online,
      keys: {
        online: [
          { key_id: online.keyId, public_key: online.publicKey, not_after: iso(NOW - 2 * 60_000) },
        ],
      },
    });
    expect(reason(indexOf(issuedLate))).toBe('key_expired');
  });

  it('refuses an expiry more than 14 days after issue, and an oversized index', () => {
    expect(
      reason(indexOf(buildLayout({ now: NOW, index: { expires: iso(NOW + 15 * DAY) } }))),
    ).toBe('out_of_bounds');
    const layout = buildLayout({ now: NOW });
    const keys = keysOf(layout);
    if (!keys.ok) throw new Error('keys');
    const big = new Uint8Array(256 * 1024 + 1);
    expect(
      reason(
        verifyIndex({
          bytes: big,
          sig: files(layout, 'index.json.sig'),
          keys: keys.value.value,
          now: NOW,
          floor: null,
        }),
      ),
    ).toBe('too_large');
  });
});

describe('a listed pack file (step 3)', () => {
  const layout = buildLayout({ now: NOW, packs: [PACK] });
  const index = indexOf(layout);
  if (!index.ok) throw new Error('index');
  const entry = index.value.value.packs[0]?.versions[0];
  if (entry === undefined) throw new Error('entry');

  it('verifies the file the index lists', () => {
    const checked = verifyListedPack(files(layout, entry.path), 'site-a.test', entry, '0.3.0');
    expect(checked.ok && 'pack' in checked.value && checked.value.pack.version).toBe(3);
  });

  it('refuses a swapped file: another version, the same size with other bytes, or another size', () => {
    const other = packBytes(sitePack('site-a.test', 40));
    expect(reason(verifyListedPack(other, 'site-a.test', entry, null))).toBe('size_mismatch');
    const same = new Uint8Array(files(layout, entry.path));
    same[same.byteLength - 2] = 0x20;
    expect(reason(verifyListedPack(same, 'site-a.test', entry, null))).toBe('hash_mismatch');
    expect(
      reason(verifyListedPack(new Uint8Array(64 * 1024 + 1), 'site-a.test', entry, null)),
    ).toBe('too_large');
  });

  it('refuses a pack the index lists under another id or version', () => {
    expect(reason(verifyListedPack(files(layout, entry.path), 'site-b.test', entry, null))).toBe(
      'invalid_pack',
    );
    expect(
      reason(verifyListedPack(files(layout, entry.path), 'site-a.test', { ...entry, v: 2 }, null)),
    ).toBe('pack_mismatch');
  });

  it('reports a version for another BrowserHive without refusing it', () => {
    const checked = verifyListedPack(files(layout, entry.path), 'site-a.test', entry, '0.0.1');
    expect(checked.ok && 'outOfRange' in checked.value).toBe(true);
  });
});
