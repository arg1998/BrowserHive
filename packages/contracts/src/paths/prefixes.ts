/** @module contracts/paths/prefixes — the reserved path prefixes that never belong to the dashboard SPA (spec 03 §8, D-59). A zod-free leaf with no imports, so the dashboard's service worker can bundle it. */

/**
 * Path prefixes the daemon owns itself: they never fall back to `index.html`, the Vite dev server
 * proxies them to the daemon, and the dashboard's service worker never touches them (04 §18.5.4).
 */
export const NON_SPA_PREFIXES = ['/api', '/mcp', '/health', '/trace-viewer'] as const;

/** One reserved prefix. */
export type NonSpaPrefix = (typeof NON_SPA_PREFIXES)[number];

/** True when `pathname` equals a reserved prefix or lies under one (`/api` and `/api/…`, never `/apix`). */
export function isNonSpaPath(pathname: string): boolean {
  return NON_SPA_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
