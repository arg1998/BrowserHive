/** @module app/site-packs/client/held — reading the held layout back at start (`<dataDir>/site-packs/remote/`, trusted only when its `index.json` hash is the one recorded in `meta`), the four files of a fetch or import, and the release snapshot's floors (spec 13 §10.9: a fresh install starts from the snapshot's versions). */

import {
  RegistryIndexV1,
  RegistryKeysV1,
  SITE_PACK_MAX_BYTES,
} from '@browserhive/contracts/site-packs';
import { plainListings } from '../../../domain/site-packs/registry-listing.ts';
import type { HeldLayoutStore, RegistryVerifier } from '../../../ports/site-pack-registry.ts';
import type { LayoutFiles } from './accept.ts';
import type { ClientRecord } from './client-state.ts';
import type { HeldState } from './client-types.ts';

/** Largest pack file read from a folder or a request (one byte over is refused). */
export const PACK_READ_MAX = SITE_PACK_MAX_BYTES;

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The four files of a store, or `null` when one is missing. */
export async function readLayoutFiles(store: HeldLayoutStore): Promise<LayoutFiles | null> {
  const [keys, keysSig, index, indexSig] = await Promise.all([
    store.read('keys.json'),
    store.read('keys.json.sig'),
    store.read('index.json'),
    store.read('index.json.sig'),
  ]);
  if (keys === null || keysSig === null || index === null || indexSig === null) return null;
  return { keys, keysSig, index, indexSig };
}

/** The held layout, when its files are there and `index.json` is the one recorded. */
export async function loadHeld(
  store: HeldLayoutStore,
  record: ClientRecord,
  sha256: (bytes: Uint8Array) => string,
): Promise<HeldState | null> {
  if (record.index_sha256 === null || record.signed_by === null) return null;
  const files = await readLayoutFiles(store);
  if (files === null || sha256(files.index) !== record.index_sha256) return null;
  const keys = RegistryKeysV1.safeParse(json(files.keys));
  const index = RegistryIndexV1.safeParse(json(files.index));
  if (!keys.success || !index.success) return null;
  return {
    files,
    keys: keys.data,
    ...plainHeld(index.data),
    signedBy: record.signed_by,
    origin: record.index_origin ?? 'registry',
    originName: record.origin_name,
  };
}

/** What the release snapshot says (`status.snapshot`), with the floors it sets on a fresh install. */
export interface SnapshotFacts {
  readonly indexVersion: number;
  readonly keysVersion: number;
  readonly verified: boolean;
  readonly detail: string | null;
}

/**
 * Verifies the release snapshot as of the instant its index was issued (its integrity is the
 * release's; freshness is what the update check is for), so its versions can seed the floors.
 */
export async function readSnapshot(
  store: HeldLayoutStore,
  verifier: RegistryVerifier,
): Promise<SnapshotFacts | null> {
  const files = await readLayoutFiles(store);
  if (files === null) return null;
  const index = RegistryIndexV1.safeParse(json(files.index));
  if (!index.success) {
    return { indexVersion: 0, keysVersion: 0, verified: false, detail: 'index.json is malformed' };
  }
  const at = Date.parse(index.data.issued_at);
  const keys = verifier.verifyKeys({ bytes: files.keys, sig: files.keysSig, now: at, floor: null });
  if (!keys.ok) {
    return {
      indexVersion: index.data.version,
      keysVersion: 0,
      verified: false,
      detail: `${keys.error.file}: ${keys.error.reason} (${keys.error.detail})`,
    };
  }
  const checked = verifier.verifyIndex({
    bytes: files.index,
    sig: files.indexSig,
    keys: keys.value.value,
    now: at,
    floor: null,
  });
  return {
    indexVersion: index.data.version,
    keysVersion: keys.value.value.version,
    verified: checked.ok,
    detail: checked.ok
      ? null
      : `${checked.error.file}: ${checked.error.reason} (${checked.error.detail})`,
  };
}

/** The held index's plain listings and what was left out. */
export function plainHeld(index: RegistryIndexV1) {
  const plain = plainListings(index);
  return { index: plain.index, unsafe: plain.unsafe };
}
