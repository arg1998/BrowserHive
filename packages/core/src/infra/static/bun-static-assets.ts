/** @module infra/static/bun-static-assets — the dashboard bundle provider (`assets/` is content-hashed). */

import type { StaticAssets } from '../../ports/static-assets.ts';
import { createDirectoryAssets } from './directory-assets.ts';

/** Serves the Vite build in `dir`; `undefined` or a missing directory → unavailable. */
export function createBunStaticAssets(dir: string | undefined): StaticAssets {
  return createDirectoryAssets(dir, { immutablePrefix: 'assets/' });
}
