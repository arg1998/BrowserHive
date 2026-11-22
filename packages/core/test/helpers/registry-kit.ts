/** @module test/helpers/registry-kit — a signed registry layout for tests (spec 13 §10.1, §10.2), built at run time: throwaway Ed25519 root and online keys (never stored), `keys.json`, `index.json`, their `.sig` files and content-addressed pack files, each part overridable so a test can tamper with exactly one thing. */

import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { sha256Hex } from '../../src/domain/site-packs/load.ts';
import type { LayoutReader } from '../../src/infra/site-packs/verify-layout.ts';
import type { SitePacksTrustRoot } from '../../src/ports/site-packs.ts';
import { packBytes } from './site-pack-kit.ts';

/** A throwaway key. */
export interface TestKey {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  readonly keyId: string;
}

/** A new throwaway Ed25519 key. */
export function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(12);
  return {
    privateKey,
    publicKey: raw.toString('base64'),
    keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  };
}

/** The trust root of `keys`. */
export function rootOf(...keys: TestKey[]): SitePacksTrustRoot {
  return { keys: keys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })) };
}

/** Canonical JSON bytes (sorted keys, two spaces, final newline), as the producers write. */
export function canonical(value: unknown): Uint8Array {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return new TextEncoder().encode(`${JSON.stringify(sort(value), null, 2)}\n`);
}

/** A `.sig` file over `bytes` by `keys`. */
export function sigOf(bytes: Uint8Array, ...keys: TestKey[]): Uint8Array {
  return canonical({
    schema: 1,
    signatures: keys.map((k) => ({
      key_id: k.keyId,
      sig: sign(null, bytes, k.privateKey).toString('base64'),
    })),
  });
}

/** `2026-11-22T10:00:00Z` for epoch ms. */
export function iso(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

const DAY = 86_400_000;

/** What {@link buildLayout} takes; every part has a valid default relative to `now`. */
export interface LayoutOptions {
  readonly now: number;
  readonly packs?: readonly SitePackV1Input[];
  readonly root?: TestKey;
  readonly online?: TestKey;
  readonly keys?: Record<string, unknown>;
  readonly index?: Record<string, unknown>;
}

/** A layout: its files by path, the keys, and the trust root that accepts it. */
export interface TestLayout {
  readonly files: Map<string, Uint8Array>;
  readonly root: TestKey;
  readonly online: TestKey;
  readonly trustRoot: SitePacksTrustRoot;
  /** The index entries, for tests that re-sign a changed index. */
  readonly indexDoc: Record<string, unknown>;
  readonly keysDoc: Record<string, unknown>;
}

/** Builds a valid signed layout. */
export function buildLayout(options: LayoutOptions): TestLayout {
  const root = options.root ?? testKey();
  const online = options.online ?? testKey();
  const files = new Map<string, Uint8Array>();
  const packs = (options.packs ?? []).map((pack) => {
    const bytes = packBytes(pack);
    const sha256 = sha256Hex(bytes);
    const path = `packs/${pack.id}/${sha256}.json`;
    files.set(path, bytes);
    return {
      id: pack.id,
      title: pack.title,
      versions: [
        {
          v: pack.version,
          min_client: pack.min_client,
          sha256,
          size: bytes.byteLength,
          path,
          released: '2026-11-20',
          notes: 'A test version.',
        },
      ],
    };
  });
  const keysDoc = {
    schema: 1,
    version: 1,
    expires: iso(options.now + 60 * DAY),
    online: [
      {
        key_id: online.keyId,
        public_key: online.publicKey,
        not_after: iso(options.now + 30 * DAY),
      },
    ],
    ...options.keys,
  };
  const indexDoc = {
    schema: 1,
    version: 10,
    issued_at: iso(options.now - 60_000),
    expires: iso(options.now + 7 * DAY),
    packs,
    ...options.index,
  };
  const keys = canonical(keysDoc);
  const index = canonical(indexDoc);
  files.set('keys.json', keys);
  files.set('keys.json.sig', sigOf(keys, root));
  files.set('index.json', index);
  files.set('index.json.sig', sigOf(index, online));
  return { files, root, online, trustRoot: rootOf(root), indexDoc, keysDoc };
}

/** A reader over `files`. */
export function readerOf(files: ReadonlyMap<string, Uint8Array>): LayoutReader {
  return async (path, maxBytes) => {
    const bytes = files.get(path);
    if (bytes === undefined) return null;
    return bytes.byteLength > maxBytes ? 'too_large' : bytes;
  };
}
