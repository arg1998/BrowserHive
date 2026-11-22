/** @module infra/site-packs/verify-layout — verifies a whole signed layout (spec 13 §10.1): `keys.json`, `index.json`, their signatures and every listed pack file, through a reader, so `sitepacks verify <dir>`, the release snapshot and imports (T4b) check a folder exactly as a fetch would. A layout is valid when the chain verifies and every listed file is present and verifies; a version for another BrowserHive is reported, not refused. */

import type { RegistryIndexV1, RegistryKeysV1 } from '@browserhive/contracts/site-packs';
import { REGISTRY_INDEX_MAX_BYTES, SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import type { SitePacksTrustRoot } from '../../ports/site-packs.ts';
import {
  type RegistryRefusal,
  type Verified,
  verifyIndex,
  verifyKeys,
  verifyListedPack,
} from './verify.ts';

/** Reads one file of the layout (path relative to `registry/v1/`): its bytes, `null` when absent, `'too_large'` past `maxBytes`. */
export type LayoutReader = (
  path: string,
  maxBytes: number,
) => Promise<Uint8Array | null | 'too_large'>;

/** The rollback floors a client stored (spec 13 §10.3); `null` members are not checked. */
export interface RegistryFloors {
  readonly keysVersion: number | null;
  readonly indexVersion: number | null;
}

/** The outcome of one listed pack version. */
export interface LayoutPackResult {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly path: string;
  readonly status: 'ok' | 'absent' | 'refused' | 'other_client';
  /** Why it was refused, or which BrowserHive it needs. */
  readonly detail: string | null;
  readonly revoked: boolean;
}

/** What {@link verifySignedLayout} found. */
export interface SignedLayoutReport {
  readonly ok: boolean;
  readonly keys: Verified<RegistryKeysV1> | null;
  readonly index: Verified<RegistryIndexV1> | null;
  /** The first refusal of the chain (keys or index), `null` when the chain verified. */
  readonly refusal: RegistryRefusal | null;
  readonly packs: readonly LayoutPackResult[];
}

/** Inputs of {@link verifySignedLayout}. */
export interface VerifyLayoutInput {
  readonly read: LayoutReader;
  readonly root: SitePacksTrustRoot;
  /** Epoch ms. */
  readonly now: number;
  /** This binary's version for the client-range check; `null` checks no range. */
  readonly binaryVersion: string | null;
  readonly floors?: RegistryFloors;
}

const SIG_READ_MAX = 64 * 1024;

async function readChecked(
  read: LayoutReader,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array } | { refusal: RegistryRefusal }> {
  const bytes = await read(path, maxBytes).catch(() => null);
  if (bytes === null) return { refusal: { file: path, reason: 'missing', detail: 'not found' } };
  if (bytes === 'too_large') {
    return {
      refusal: { file: path, reason: 'too_large', detail: `larger than ${maxBytes} bytes` },
    };
  }
  return { bytes };
}

/** Verifies a signed layout. Never throws. */
export async function verifySignedLayout(input: VerifyLayoutInput): Promise<SignedLayoutReport> {
  const failed = (
    refusal: RegistryRefusal,
    keys: Verified<RegistryKeysV1> | null = null,
  ): SignedLayoutReport => ({ ok: false, keys, index: null, refusal, packs: [] });
  const floors = input.floors ?? { keysVersion: null, indexVersion: null };

  const keysFile = await readChecked(input.read, 'keys.json', SIG_READ_MAX);
  if ('refusal' in keysFile) return failed(keysFile.refusal);
  const keysSig = await readChecked(input.read, 'keys.json.sig', SIG_READ_MAX);
  if ('refusal' in keysSig) return failed(keysSig.refusal);
  const keys = verifyKeys({
    bytes: keysFile.bytes,
    sig: keysSig.bytes,
    root: input.root,
    now: input.now,
    floor: floors.keysVersion,
  });
  if (!keys.ok) return failed(keys.error);

  const indexFile = await readChecked(input.read, 'index.json', REGISTRY_INDEX_MAX_BYTES + 1);
  if ('refusal' in indexFile) return failed(indexFile.refusal, keys.value);
  const indexSig = await readChecked(input.read, 'index.json.sig', SIG_READ_MAX);
  if ('refusal' in indexSig) return failed(indexSig.refusal, keys.value);
  const index = verifyIndex({
    bytes: indexFile.bytes,
    sig: indexSig.bytes,
    keys: keys.value.value,
    now: input.now,
    // `index_floor` resets the stored floor (the only way down after a fast-forward attack).
    floor: keys.value.value.index_floor ?? floors.indexVersion,
  });
  if (!index.ok) return failed(index.error, keys.value);

  const packs: LayoutPackResult[] = [];
  for (const pack of index.value.value.packs) {
    for (const entry of pack.versions) {
      const base = {
        id: pack.id,
        version: entry.v,
        sha256: entry.sha256,
        path: entry.path,
        revoked: entry.revoked === true,
      };
      const file = await input.read(entry.path, SITE_PACK_MAX_BYTES + 1).catch(() => null);
      if (file === null) {
        packs.push({ ...base, status: 'absent', detail: null });
        continue;
      }
      if (file === 'too_large') {
        packs.push({ ...base, status: 'refused', detail: 'too_large' });
        continue;
      }
      const checked = verifyListedPack(file, pack.id, entry, input.binaryVersion);
      if (!checked.ok) {
        packs.push({
          ...base,
          status: 'refused',
          detail: `${checked.error.reason}: ${checked.error.detail}`,
        });
      } else if ('outOfRange' in checked.value) {
        packs.push({ ...base, status: 'other_client', detail: checked.value.outOfRange });
      } else {
        packs.push({ ...base, status: 'ok', detail: null });
      }
    }
  }
  const ok = packs.every((p) => p.status === 'ok' || p.status === 'other_client');
  return { ok, keys: keys.value, index: index.value, refusal: null, packs };
}
