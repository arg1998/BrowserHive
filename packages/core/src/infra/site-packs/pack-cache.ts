/** @module infra/site-packs/pack-cache — the approved-copy cache (D-67): `<dataDir>/site-packs/cache/<source>/<pack id>/<sha256>.json`, written at approval and read when the source no longer offers the approved bytes; and the writer of unsigned packs into `sitePacksDir` (`POST /site-packs/import`). */

import { join } from 'node:path';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import type { SitePackSourceId } from '../../ports/persistence/site-packs.ts';
import type { LocalPackWriter, SitePackCache } from '../../ports/site-pack-files.ts';
import { isSafePackId, isSha256, readBounded, writeAtomic } from './pack-files.ts';

function checked(packId: string, sha256: string): void {
  if (!isSafePackId(packId) || !isSha256(sha256)) {
    throw new Error(`refused pack cache name '${packId}/${sha256}'`);
  }
}

/** `<cacheDir>/<source>/<id>/<sha256>.json` over the real filesystem. */
export function createSitePackCache(cacheDir: string): SitePackCache {
  const pathOf = (source: SitePackSourceId, packId: string, sha256: string) =>
    join(cacheDir, source, packId, `${sha256}.json`);
  return {
    pathOf,
    async put(source, packId, sha256, bytes) {
      checked(packId, sha256);
      const path = pathOf(source, packId, sha256);
      const existing = await readBounded(path, SITE_PACK_MAX_BYTES).catch(() => null);
      if (existing?.kind === 'bytes' && sameBytes(existing.bytes, bytes)) return;
      await writeAtomic(path, bytes);
    },
    async get(source, packId, sha256) {
      if (!isSafePackId(packId) || !isSha256(sha256)) return null;
      try {
        const read = await readBounded(pathOf(source, packId, sha256), SITE_PACK_MAX_BYTES);
        return read.kind === 'bytes' ? read.bytes : null;
      } catch {
        return null;
      }
    },
  };
}

/** Writes `<dir>/<pack id>.json` (the unsigned local layout, spec 13 §10.5). */
export function createLocalPackWriter(dir: string): LocalPackWriter {
  return {
    dir,
    async write(packId, bytes) {
      if (!isSafePackId(packId)) throw new Error(`refused pack id '${packId}'`);
      const path = join(dir, `${packId}.json`);
      await writeAtomic(path, bytes);
      return path;
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
