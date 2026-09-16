/** @module composition/dashboard-dir — locates the built dashboard SPA: `dist/dashboard` next to the bundled package, or `packages/dashboard/dist` when running from source. */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How far up from this module the search walks. */
const MAX_DEPTH = 6;

/**
 * Returns the directory holding the dashboard's `index.html`, or `undefined` when no build exists
 * (the HTTP layer then serves 404 for SPA routes; `bun run --filter @browserhive/dashboard build`).
 */
export function resolveDashboardDir(
  fromUrl: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    // `dashboard/dist` first: from source, walking up reaches `packages/` whose `dashboard/` holds the
    // Vite *source* `index.html` (it loads `/src/main.tsx`). A build always has an `assets/` folder.
    for (const candidate of [join(dir, 'dashboard', 'dist'), join(dir, 'dashboard')]) {
      if (exists(join(candidate, 'index.html')) && exists(join(candidate, 'assets')))
        return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
