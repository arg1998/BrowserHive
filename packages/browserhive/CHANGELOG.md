# browserhive

## 0.1.1

### Patch Changes

- [#5](https://github.com/arg1998/BrowserHive/pull/5) [`1bd3de0`](https://github.com/arg1998/BrowserHive/commit/1bd3de0ca905a990c84b18fd07496382326fbd97) Thanks [@arg1998](https://github.com/arg1998)! - Point README, changelog, and dashboard documentation links at the real repository, github.com/arg1998/BrowserHive.

## 0.1.0

### Minor Changes

Initial release of BrowserHive, a local Model Context Protocol server that runs isolated, observable Chromium sessions for AI agents.

- MCP server (official SDK) with 43 browser tools over Streamable HTTP or stdio: session lifecycle, navigation, page interaction, content and snapshots, tabs, cookies and storage, downloads and uploads, saved logins, attention and vault. Tools carry titles, annotations and `outputSchema`/`structuredContent`; failed calls return the `[CODE] message` text with the structured error in `_meta["browserhive.ai/error"]`.
- Runs on Bun ≥ 1.4. MCP, the admin REST API, the realtime WebSocket and the dashboard share one port (`127.0.0.1:9876` by default); non-loopback binds require bearer tokens.
- Each session is its own Chromium process and browser context, with a sliding lease, memory or persistent profiles, and per-principal ownership on every tool.
- Admin dashboard (React 19): sessions with live view and human takeover, timeline, websites, blocklist with hot reload, vault, logs, system status and persisted notifications.
- Human attention: `request_attention` hands the page to an operator and blocks until it is resolved, with timeouts and a configurable minimum wait.
- Vault credential injection through Bitwarden: bindings and folder policies stored in the database, origin, session and principal checks, optional confirmations with deadlines, redacted tool results, credential typing excluded from Playwright traces, and one audit row per fill.
- Stealth: full Chromium in new-headless mode, Patchright when installed, automation signals removed, a coherent identity derived from the host, optional display fingerprint and human-like input.
- One configuration schema: every key works as a camelCase CLI flag, a `BROWSERHIVE_*` environment variable and a `browserhive.config.json` key, with precedence defaults < env < file < CLI, shadow logging, "did you mean" hints and fail-fast validation.
- CLI: `serve` (default), `init` (installs Chromium; nothing is downloaded at install time), `doctor`, `purge`, `config show|schema|validate`, `db status|backup|restore|migrate`, `admin reset-password`, `admin tokens list|create|revoke`.
- SQLite storage via `bun:sqlite` with forward-only migrations, automatic pre-migration backups and a downgrade compatibility window (`DB_NEWER_THAN_BINARY`, `db restore`).
- Operator authentication with Argon2id, a one-time seed password and forced change; hashed bearer tokens for agents.
- Opt-in OpenTelemetry export of traces, metrics and logs over OTLP/HTTP.
- Configurable recording (`--recordToolResults full|shape|none`) and retention; cookie values are never stored and URL query strings are stripped unless allow-listed.
- Programmatic API: `createServer()` with typed configuration, error codes and tool contracts.
