---
title: "Usage"
spec: "12"
status: Informative
scope: How a user of the `browserhive` package installs, runs, connects, operates and upgrades it; the outline of the shipped user guide in `docs/`.
audience: Writers of the user documentation; contributors who need the user's view of a feature.
related:
  - 02-mcp-and-tools.md
  - 08-cli-arguments-and-config.md
  - 10-error-handling-and-telemetry.md
  - 11-stealth.md
---

# 12 — Usage (User Documentation)

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

This document is informative: it outlines the shipped `docs/` user guide. The reference material it links to (`docs/reference/*`) is generated from the contracts, so it cannot drift; where this page names a flag, file or error code, the normative definition is in `08-cli-arguments-and-config.md`, `02-mcp-and-tools.md` or `10-error-handling-and-telemetry.md`.

---

## 1. What you get

BrowserHive is a local MCP server that gives any agent harness N parallel, fully isolated Chromium sessions: separate cookies, storage, IndexedDB and service workers per session, persistent profiles that survive restarts, credential injection from your password vault that the model never sees, a human-in-the-loop `request_attention` tool, and an operator dashboard with a live browser view, takeover, replayable traces and an audit trail. Everything runs on your machine; nothing leaves it unless you turn telemetry on.

## 2. Requirements

- **Bun ≥ 1.4** (D-01). BrowserHive runs on Bun only. Install: `curl -fsSL https://bun.sh/install | bash` (macOS/Linux) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows).
- **Chromium** installed once by `browserhive init` (never downloaded during `npm install`). Optionally **Google Chrome** or **Microsoft Edge**: `init` finds them and lets you make one the default (D-26).
- **Bitwarden CLI** (`bw`) on `PATH` only if you use `--vault bitwarden`.
- Platforms: macOS, Linux, Windows.

## 3. Install

```bash
bun install -g browserhive        # or: npm install -g browserhive / pnpm add -g browserhive
browserhive init                  # downloads Chromium, reports the browsers on this machine, lets you pick the default one
browserhive --help
```

`init` is idempotent and safe to re-run after upgrades. On a terminal it shows the browsers it found (the bundled Chromium, an installed Google Chrome or Microsoft Edge), whether each can run inside Chromium's sandbox on this machine, and a menu with the pros and cons of each for this OS; Enter keeps the current choice. It can install Google Chrome for you (Google's installer, administrator rights) when you pick that entry. In scripts: `browserhive init --channel chrome --yes` (or `--installChrome`); nothing is asked without a terminal. Use `browserhive doctor` any time to check Bun, browsers, data directory permissions, port availability and the database.

Without a global install: `bunx browserhive` (or `npx browserhive`).

## 4. Quick start

| Scenario | Command | Result |
|---|---|---|
| S1 Just run it | `browserhive` | MCP at `http://127.0.0.1:9876/mcp`, in-memory sessions, headless, no dashboard, no vault |
| S1b Single-agent stdio | `browserhive --transport stdio` | stdio MCP; no dashboard, no attention tools |
| S2 Sessions that survive restarts | `browserhive --persistence persistent` | profiles under `<data-dir>/sessions/<id>/userdata` |
| S3 Watch the agents | `browserhive --admin` | dashboard at `http://127.0.0.1:9876/` on the **same port** (D-02); seed password printed once; tracing on by default |
| S4 Log in without the model seeing the password | `bw login` then `browserhive --admin --vault bitwarden` | paste a session token from `bw unlock --raw` on the Vault page (or start with `BW_SESSION` exported), bind entries there; the agent calls `vault_fill` |
| S5 Replay yesterday's run | dashboard → Sessions → run → Files → Open trace viewer | Playwright Trace Viewer with DOM snapshots, network, console |
| S6 Keep agents off some sites | `browserhive --admin --blocklist ./blocklist.txt` | refused at the tool boundary and at the network layer; Blocklist page shows hits |
| S7 Start over | `browserhive purge` | inventory, then type `YES`; `--all` also removes saved logins, vault policy and the admin password |

Every flag has an env var and a config-file key (see §7).

### 4.1 First run with the dashboard

```
$ browserhive --admin
14:02:11.004 INFO  config resolved            source=cli:2 env:0 file:0
14:02:11.120 INFO  storage ready              schema=1 path=~/.local/share/browserhive/browserhive.db
14:02:11.300 INFO  listening                  url=http://127.0.0.1:9876 mcp=/mcp dashboard=/ api=/api/v1

  Dashboard:  http://127.0.0.1:9876/
  Password:   Kq7...   (also in ~/.local/share/browserhive/admin/credentials.txt — you must change it on first login)
```

Log in, set a new password (minimum 12 characters), and the seed file is shredded.

## 5. Connecting MCP clients

**Streamable HTTP (recommended, many clients share one daemon):** endpoint `http://127.0.0.1:9876/mcp`.

```jsonc
// Claude Code / Claude Desktop / Cursor style config
{
  "mcpServers": {
    "browserhive": {
      "type": "http",
      "url": "http://127.0.0.1:9876/mcp",
      "headers": { "Authorization": "Bearer <token>" }   // only with --auth token
    }
  }
}
```

**stdio (one client spawns the process):**

```jsonc
{
  "mcpServers": {
    "browserhive": { "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

**Tokens.** With `--auth token`, the first start prints a bearer token for principal `agent-1` and stores its hash. Manage tokens with `browserhive admin tokens list|create <name>|revoke <name>`. Non-loopback binds (`--host 0.0.0.0`) are refused without `--auth token` unless `--allowInsecureBind` is set.

**Attention tools** (`request_attention`, `get_attention_result`) and the dashboard need the HTTP transport; under stdio they return `ATTENTION_REQUIRES_HTTP`.

## 6. The dashboard tour

| Page | Use it for |
|---|---|
| Overview | fleet health over 24h/3d/7d/14d/30d: live sessions, calls, errors, open attention, blocked URLs, activity chart (click a bar to drill into sessions), live "websites visited" feed |
| Sessions | every session, live and finished; filters, sort, bulk archive/delete, lease countdowns, export |
| Session detail | tabs: **Live** (screencast, takeover while an attention request is open, resize agent browser, fullscreen, picture-in-picture), **Timeline** (tool calls with parameters/results/screenshots, navigations, vault access, blocked URLs, attention), **Vault**, **Identity** (presented UA, brands, locale, timezone, screen), **Files** (trace viewer, downloads, profile) |
| Attention | the human-in-the-loop queue: resolve/reject with a message back to the agent; history |
| Websites | every URL any agent visited, top domains, category tags for non-public destinations |
| Blocklist | loaded rules, how often each fires, every refused attempt; reload without restart |
| Vault | unlock the backend, folder policies, per-entry bindings (allowed origins, authorized sessions, confirm/no-evaluate/redact flags), the confirm queue, an origin tester |
| Vault log | the audit trail for every `vault_fill` |
| Logs | live tail of the server log with level/module/session filters and export |
| System | version, bind, capacity, stealth posture, retention, database and schema version, telemetry, effective configuration with provenance |
| Notifications | attention requested, tool errors, crashes, vault confirms; persisted |

Keyboard: `⌘K` command palette (pages, sessions, actions), `⌘B` sidebar, `/` filter, `?` shortcuts. Theme: system, light or dark.

## 7. Configuration in one page

Precedence (rightmost wins): **defaults < environment < `browserhive.config.json` < CLI flags** (D-06). When a key comes from more than one source, startup logs which value shadowed which. Names are mechanical: CLI `--maxSessions`, env `BROWSERHIVE_MAX_SESSIONS`, JSON `"maxSessions"`. Unknown or misspelled keys stop startup with a suggestion. A string in the config file may reference environment variables (`"authTokens": "ci:{env:CI_TOKEN}"`, `{env:NAME:-default}`), so a checked-in file can leave its secrets to the environment; `config show`, the startup log and the dashboard name the variable each value came from (D-29).

The config file is looked up as `--config <path>`, then `./browserhive.config.json`, then `<data-dir>/browserhive.config.json`. For editor completion, write the JSON Schema next to it (`browserhive config schema > browserhive.schema.json`, or `browserhive init --writeSchema`) and add `"$schema": "./browserhive.schema.json"`. Unsupported spellings such as `--max-sessions` stop startup with the correct name (`--maxSessions`).

Most used:

| CLI | Default | Purpose |
|---|---|---|
| `--transport http\|stdio` | `http` | transport |
| `--host`, `--port` | `127.0.0.1`, `9876` | bind (MCP, API, dashboard share it) |
| `--admin` | off | dashboard + API + live view |
| `--auth off\|token` | `off` | bearer auth and caller-scoped session ownership |
| `--persistence memory\|persistent\|storage-state` | `memory` | default persistence mode |
| `--vault off\|bitwarden` | `off` | credential backend |
| `--stealth off\|standard\|max` | `standard` | stealth profile; `--fingerprint`, `--humanize` toggles |
| `--maxSessions <n\|unbounded>` | host-derived | concurrent cap |
| `--sessionLease <dur>` | `2h` | sliding inactivity lease |
| `--blocklist <path>` | off | URL blocklist file |
| `--dataDir <path>` | OS default | data root |
| `--logLevel`, `--logFormat pretty\|json` | `info`, auto | logging |
| `--otel`, `--otelEndpoint` | off | OpenTelemetry export |

Full table with every key, type, validation and example: `docs/configuration.md` (generated; spec in `08-cli-arguments-and-config.md`).

Data directory defaults: `~/Library/Application Support/BrowserHive` (macOS), `%LOCALAPPDATA%\BrowserHive` (Windows), `$XDG_DATA_HOME/browserhive` or `~/.local/share/browserhive` (Linux). Layout in D-24.

## 8. Tool catalog (43 tools)

| Group | Tools |
|---|---|
| Lifecycle | `launch_session` · `close_session` · `list_sessions` |
| Introspection | `server_status` · `session_info` |
| Navigation | `navigate` · `go_back` · `go_forward` · `reload` · `wait_for_url` |
| Tabs | `new_tab` · `close_tab` · `switch_tab` · `list_tabs` |
| Interaction | `click` · `type_text` · `fill` · `press_key` · `hover` · `select_option` · `scroll` · `drag_and_drop` |
| Inspection | `screenshot` · `snapshot` · `get_content` · `evaluate` |
| Waits | `wait_for_selector` · `wait_for_load_state` |
| Files | `upload_file` · `download_file` |
| Dialogs | `accept_next_dialog` · `dismiss_next_dialog` |
| Cookies & state | `get_cookies` · `set_cookies` · `set_viewport` · `set_extra_http_headers` |
| Auth state | `save_storage_state` · `save_full_profile` · `list_saved_auths` |
| Vault | `vault_list_available` · `vault_fill` |
| Attention (HTTP only) | `request_attention` · `get_attention_result` |

Every page-targeting tool accepts an optional `tab_id`. Contracts, parameters and error codes: `docs/tools.md` (generated; spec in `02-mcp-and-tools.md`).

A minimal session:

```jsonc
launch_session({ "slug": "shop", "persistence_mode": "persistent" })   // → { session_id: "shop-a1b2c3d4", ... }
navigate({ "session_id": "shop-a1b2c3d4", "url": "https://example.com" })
snapshot({ "session_id": "shop-a1b2c3d4" })
vault_fill({ "session_id": "shop-a1b2c3d4", "entry_name": "Logins/example",
             "username_selector": "#user", "password_selector": "#pass", "submit_selector": "button[type=submit]" })
close_session({ "session_id": "shop-a1b2c3d4" })
```

## 9. Security model and gotchas

BrowserHive treats **the agent as untrusted and the operator as trusted**.

- **Redaction is substring-based** over tool text results for a window after a fill. An agent that base64-encodes a value bypasses it. It is a guardrail, not a boundary.
- **`evaluate` + vault.** With `evaluate` on, the DOM is readable after the cooldown. Use `disable_evaluate: true` per session, `require_no_evaluate` per entry, or `--allowEvaluate false` server-wide (every `evaluate` call then returns `EVALUATE_DISABLED`).
- **Traces do not contain typed credentials.** Tracing pauses around a `vault_fill` (D-13), so `trace.zip` never records the password keystrokes. Screenshots and the live view still show raw pixels; operators are trusted.
- **Takeover is full control**, only while an attention request is open, re-checked on every input.
- **Chromium's sandbox is on wherever this machine allows it** (`sandbox=auto`, D-27). Where it cannot run (Ubuntu 23.10+ with the bundled browser, running as root, default Docker) sessions fall back to no sandbox and `doctor` says why and how to fix it; `--sandbox on` makes it a requirement the server checks before it starts. Agents cannot turn it off (`chromiumSandbox: false` is refused).
- **Non-loopback binds are refused** without `--auth token` (or `--allowInsecureBind`). The dashboard shares the port and the same rule; put TLS in front for remote use.
- **The blocklist stops navigation, not egress.** Document loads are aborted; subresources are not. An `evaluate`-enabled agent can still `fetch()` a blocked URL.
- **Cookie values are never stored** in the database or sent over the dashboard feed (D-20). Saved auth states on disk (`0600`) are your responsibility.
- **WebAuthn/passkeys cannot be replayed** from saved state.

Every error code, its cause and resolution: `docs/errors.md` (generated).

## 10. Telemetry (OpenTelemetry)

Off by default; nothing leaves the host. Turn it on and point it at any OTLP/HTTP collector:

```bash
browserhive --admin --otel --otelEndpoint http://127.0.0.1:4318 --otelServiceName browserhive-dev
# or standard env: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 BROWSERHIVE_OTEL=true browserhive --admin
```

Exports traces (one trace per tool call with browser/CDP/DB spans; `session_id`, `tool`, `principal` attributes), metrics (sessions, tool latency, errors by code, WS backpressure, DB size) and logs. Each dashboard timeline row shows its `trace_id` and, when `--otelTraceUrlTemplate` is set, a link into your APM.

Local stack in one file:

```yaml
# docker-compose.yml — Grafana + Tempo + Loki + Prometheus via the OTel collector
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    ports: ["4318:4318"]
    volumes: ["./otel-collector.yaml:/etc/otelcol-contrib/config.yaml"]
  tempo:  { image: grafana/tempo:latest,      command: ["-config.file=/etc/tempo.yaml"] }
  loki:   { image: grafana/loki:latest }
  grafana:
    image: grafana/grafana:latest
    ports: ["3000:3000"]
```

(`docs/telemetry.md` ships the collector config and a Grafana dashboard JSON.) Jaeger works the same way (`jaegertracing/all-in-one` exposes 4318).

## 11. CLI reference

```
browserhive [serve] [flags]          start the server (default command)
browserhive init [--browsers chromium] [--skipBrowsers] [--channel <chromium|chrome|edge>] [--installChrome] [--yes]
                                     install browsers, choose the default one, create the data dir
browserhive doctor [--json] [--printApparmorProfile]
                                     check Bun, browsers, the sandbox, data dir, port, database, config
browserhive config [--json] [--config <path>]
                                     print the effective configuration with the source of every value
browserhive purge [--all] [--dryRun] [--yes]
                                     delete local state after an inventory and a typed YES
browserhive db status | backup [--to <file>] | restore <file> [--yes] | migrate [--dryRun]
browserhive admin reset-password | tokens list | tokens create <name> | tokens revoke <name>
browserhive version | -v             print versions (app, schema, Playwright, Chromium)
browserhive help [command] | -h
```

Exit codes: `0` ok, `1` fatal, `3` policy refusal (insecure bind, admin under stdio), `64` usage/config error. Colour is on when stdout is a TTY; `NO_COLOR` and `--color false` disable it; under `--transport stdio` all output goes to stderr.

## 12. Programmatic API

```ts
import { createServer } from "browserhive";

const server = await createServer({
  transport: "http", host: "127.0.0.1", port: 9876,
  admin: true, auth: "token", vault: "bitwarden",
  sessionLease: "2h",
  // every config key, camelCase, same validation as the CLI
});
await server.listen();     // resolves when /health is ready
console.log(server.url);   // http://127.0.0.1:9876
await server.stop();       // graceful, idempotent
```

Types ship with the package (`browserhive` exports `createServer`, `ServerOptions`, `BrowserHiveServer`, the tool contract types and the error code union from `@browserhive/contracts`).

## 13. Troubleshooting

- `browserhive doctor` first. It prints a table with ✓/✗ per check and the fix for each ✗.
- **`BROWSER_NOT_INSTALLED`**: run `browserhive init` (or the exact `playwright install chromium@<ver>` it prints); for `chrome`, `browserhive init --installChrome`. `PLAYWRIGHT_BROWSERS_PATH` is honoured. BrowserHive never launches a different browser than the one configured.
- **`SANDBOX_UNAVAILABLE`**: the sandbox was required (`--sandbox on`, or an agent's `launch_options.chromiumSandbox: true`) and the browser cannot run with it on this machine. The message lists what works here, easiest first: on Ubuntu 23.10+ use the installed Google Chrome (`--defaultChannel chrome`), or give the bundled browser an AppArmor profile (`browserhive doctor --printApparmorProfile | sudo tee /etc/apparmor.d/browserhive-chromium`, then `sudo apparmor_parser -r /etc/apparmor.d/browserhive-chromium`); as root, run as a normal user; or use `--sandbox auto` (the default: sandbox where possible) or `--sandbox off`. Retrying does not help.
- `doctor` reports **"cannot run sandboxed here, falls back"**: under the default `sandbox=auto` that browser runs without Chromium's sandbox on this machine; the guidance under the table says how to change that.
- **`PORT_IN_USE`**: another process holds the port; `--port` or `lsof -i :9876`. **`BIND_FAILED`**: the address cannot be bound for another reason (permissions, an address not on this host); the message carries the errno.
- **`INSECURE_BIND_REFUSED`**: add `--auth token` or `--allowInsecureBind`.
- **`CONFIG_INVALID`** / **`CONFIG_UNKNOWN_KEY`**: the message names the key, the source it came from and the accepted values or the suggested spelling.
- **`DATA_DIR_LOCKED`**: another BrowserHive server already uses this data directory; stop it or pass a different `--dataDir`.
- **`DB_NEWER_THAN_BINARY`**, **`MIGRATION_FAILED`**: see §14.
- `doctor` warns about an **unrecognised data file** (such as `events.db`) in the data directory: BrowserHive does not read or migrate it; remove or move it once you know what created it.
- Dashboard shows `offline`: the daemon restarted or the cookie expired; log in again. `reconnecting…` for more than a minute means the daemon is down.
- Live view is black: the session is closed or the screencast failed; the panel shows the code.
- Logs: `--logLevel debug` and the Logs page; `--logFormat json` for collectors.

## 14. Upgrading and downgrading

- Upgrade: `bun install -g browserhive@latest` (or `npm`/`pnpm`), then `browserhive init` to refresh browsers if the Playwright pin moved. On first start the database is migrated automatically; a backup is written first to `<data-dir>/backups/browserhive-v<schema version>-<timestamp>.db` (the last `backupsKeep`, default 5, are retained). If a migration fails, startup stops with `MIGRATION_FAILED`, the database is left at its previous version, and the message names the backup. `browserhive db status` shows the schema version and migration history; the System page shows the same.
- Downgrade (D-04): an older release opens a newer database as long as the newer schema is within its compatibility window (purely additive changes). Otherwise it refuses with `DB_NEWER_THAN_BINARY`, names the backup that matches the older release, and you restore it with `browserhive db restore <file>` (a copy of the current file is kept). Nothing is ever migrated downward in place.
- Prereleases: `bun install -g browserhive@next`.
- Release notes: `CHANGELOG.md` (Changesets) and GitHub Releases; versions follow semver from `0.1.0`.

## 15. FAQ

- **Does it work on Node?** No. Bun is the runtime (D-01); install via npm/pnpm is fine, running needs Bun.
- **Why one port?** MCP, API, WebSocket and the dashboard share `--port` so there is one bind rule, one auth surface and one health check (D-02).
- **Can several agents share a session?** Sessions are owned by the principal that created them when `--auth token` is on; without auth everyone is `local`.
- **Where are my passwords?** In your vault backend. BrowserHive stores only bindings (which entry may fill which origins for which sessions) and an audit log without secrets.
- **Does it phone home?** No. Telemetry is opt-in and points where you say.
- **Firefox/WebKit?** Not yet; the engine seam exists (D-25).
- **Proxies?** Pass Playwright's `proxy` in `launch_options` today (loopback is always bypassed); a managed pool is planned (D-13).

---

## Notes for documentation writers

- Every error code named on this page exists in the contracts error registry (D-07); link to its generated entry in `docs/reference/errors.md` rather than restating its cause.
- `browserhive admin tokens …` and `--otelTraceUrlTemplate` are specified in `08-cli-arguments-and-config.md` §7.1 and §5.3.
- The log renderer is chosen with `--logFormat auto|pretty|json`.
