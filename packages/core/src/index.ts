/** @module core — `@browserhive/core` root entry.
 *
 * The package surface is split into explicit subpath
 * entries so a command loads only what it needs (package.json `exports`):
 *
 * - `@browserhive/core/kernel` — errors, results, redaction, URL/path helpers (no I/O).
 * - `@browserhive/core/config` — the config resolver and provenance views (spec 08).
 * - `@browserhive/core/ports/<name>` — port interfaces (types only).
 * - `@browserhive/core/persistence` — SQLite adapter: open, migrations, repositories, maintenance.
 * - `@browserhive/core/maintenance` — purge inventory, schedulers, startup reconcile.
 * - `@browserhive/core/runtime` — logging, telemetry, clock/ids, auth, degradations (no browser/HTTP/MCP).
 * - `@browserhive/core/server` — browsers, sessions, vault, attention, MCP, HTTP, WS, static assets.
 *
 * Every entry re-exports by name (no `export *`).
 */
export { VERSION } from './version.ts';
