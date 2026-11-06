/** @module dev-proxy — the paths the Vite dev server forwards to the daemon (spec 06 §2.1, 04 §18.5.6). Imported by `vite.config.ts` and by its test, which pins it to `NON_SPA_PREFIXES`. */

/** Paths forwarded to the daemon in development; `/api` covers `/api/v1/ws` (`ws: true`). */
export const PROXIED_PATHS = ['/api', '/mcp', '/health', '/trace-viewer'] as const;
