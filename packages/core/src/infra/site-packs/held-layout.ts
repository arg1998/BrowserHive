/** @module infra/site-packs/held-layout — the registry client's last good signed layout on disk (`<dataDir>/site-packs/remote/`, spec 13 §10.3 step 2): `keys.json`, `index.json` and their signatures, each replaced atomically, `index.json` last. Verified pack files live in the approved-copy cache (`cache/remote/…`, `cache/import/…`). */

import { join } from 'node:path';
import {
  REGISTRY_INDEX_MAX_BYTES,
  REGISTRY_KEYS_MAX_BYTES,
  REGISTRY_SIG_MAX_BYTES,
} from '@browserhive/contracts/site-packs';
import {
  HELD_LAYOUT_FILES,
  type HeldLayoutFile,
  type HeldLayoutStore,
} from '../../ports/site-pack-registry.ts';
import { readBounded, writeAtomic } from './pack-files.ts';

const MAX: Readonly<Record<HeldLayoutFile, number>> = {
  'keys.json': REGISTRY_KEYS_MAX_BYTES,
  'keys.json.sig': REGISTRY_SIG_MAX_BYTES,
  'index.json': REGISTRY_INDEX_MAX_BYTES,
  'index.json.sig': REGISTRY_SIG_MAX_BYTES,
};

/** The held layout in `dir`. */
export function createHeldLayoutStore(dir: string): HeldLayoutStore {
  return {
    dir,
    async read(file) {
      try {
        const read = await readBounded(join(dir, file), MAX[file]);
        return read.kind === 'bytes' ? read.bytes : null;
      } catch {
        return null;
      }
    },
    async write(files) {
      // index.json last: a crash between files leaves an index whose hash no longer matches the one
      // recorded in `meta`, which the client then ignores (it re-fetches).
      const order: HeldLayoutFile[] = [
        ...HELD_LAYOUT_FILES.filter((f) => f !== 'index.json'),
        'index.json',
      ];
      for (const file of order) {
        const bytes = files[file];
        if (bytes !== undefined) await writeAtomic(join(dir, file), bytes);
      }
    },
  };
}
