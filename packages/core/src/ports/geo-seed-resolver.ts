/** @module ports/geo-seed-resolver — per-session geo seed resolution (spec 11 §2.5); async so a proxy-exit resolver is a one-line swap. */

import type { GeoSeed } from './browser-driver.ts';

/** Resolves the locale/timezone story for a session. Never process-memoised. */
export interface GeoSeedResolver {
  resolve(input: { readonly sessionId: string; readonly proxyServer?: string }): Promise<GeoSeed>;
}
