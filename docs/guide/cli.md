# Command line

```
browserhive [serve] [flags]            start the server (default command)
browserhive init [flags]               install browsers, create the data dir, verify the host
browserhive doctor [flags]             diagnose the host and configuration
browserhive purge [flags]              delete local state (inventory, then confirmation)
browserhive config show|schema|validate
browserhive db status|backup|restore <file>|migrate
browserhive admin reset-password
browserhive admin tokens list|create <name>|revoke <name>
browserhive version | --version | -v
browserhive help [command] | --help | -h
```

If the first argument is not a command word, `serve` is assumed and every argument is a flag. Each command accepts only its own flags; passing a server flag to `purge` is a usage error. `--help` wins over everything, `--version` over everything except `--help`, and `--` ends flag parsing.

Help text is generated from the configuration schema, so `browserhive --help` always lists every server flag with its type, default and environment variable. Flags are camelCase; see [Configuration](configuration.md).

## `serve`

Resolves the configuration, opens storage (migrating the database if needed), starts the listener and prints the banner:

```
 BrowserHive 0.1.0  ·  bun 1.4.2  ·  patchright 1.63.0
 MCP        http://127.0.0.1:9876/mcp            (auth: token)
 Dashboard  http://127.0.0.1:9876/               (admin)
 Data dir   /home/me/.local/share/browserhive     (db v1, 12 MiB, 3 backups)
 Config     env:2  file:/home/me/browserhive.config.json:9  cli:1
 Sessions   cap 8 (derived from 12 GiB RAM) · lease 2h · persistence memory
 Stealth    standard · patchright · humanize on · fingerprint off
 Telemetry  otel → http://127.0.0.1:4318 (http/protobuf)
 Vault      bitwarden (locked)

 config: maxSessions=8 (cli) shadows config-file=4
 Press Ctrl-C to stop.
```

The first-run dashboard password and the first agent token are printed once in this banner and never logged. `Ctrl-C` (or `SIGTERM`) stops gracefully within `--shutdownTimeout`: listeners, then sessions (traces are finalized), then storage. A second `Ctrl-C` exits immediately with code 130.

Output streams: under `--transport stdio`, stdout carries only MCP frames and everything else goes to stderr. Under HTTP, the banner and pretty logs go to stdout on a terminal, and JSON logs go to stderr, so `browserhive 2> logs.jsonl` captures them. Colour is on for terminals; `NO_COLOR` or `--color never` disables it.

All server flags are in the [configuration reference](../reference/configuration.md).

## `init`

One-time setup, safe to re-run:

1. Create the data directory (`0700`) and subdirectories.
2. Install Chromium for Playwright (honours `PLAYWRIGHT_BROWSERS_PATH`).
3. Install Patchright's Chromium when `stealthDriver` is `auto` or `patchright`.
4. Create or migrate the database.
5. Print next steps.

| Flag | Meaning |
|---|---|
| `--browsers chromium` | Browsers to install (only `chromium` today; Chrome and Edge channels use the OS installation). |
| `--force` | Re-download even if present. |
| `--dataDir <path>`, `--config <path>` | Where state and configuration live. |
| `--stealthDriver <auto\|patchright\|playwright>` | `playwright` skips the Patchright download. |
| `--writeSchema` | Write `browserhive.schema.json` next to a discovered config file. |

## `doctor`

Checks Bun, browsers, data directory permissions and disk space, configuration, port availability, `bw` when the vault is on, the database and pending migrations, the OTLP endpoint when telemetry is on, `maxSessions` against RAM, and config-file permissions when it holds secrets. It also warns when the data directory contains an unrecognised data file, which BrowserHive neither reads nor migrates.

`--json` prints `[{ check, status, detail }]`. Exit codes: `0` all good, `2` warnings only, `1` a check failed.

## `purge`

Deletes local state after showing what will go: row counts per table, directory sizes and absolute paths.

| Flag | Meaning |
|---|---|
| (none) | Delete the database (with its WAL files) and `sessions/`. You type `YES` to confirm. |
| `--all` | Also delete saved logins, uploads, backups and the admin credentials. Vault bindings and policies are lost with the database. Asks for a second `YES`. |
| `--dryRun` | Print the inventory and exit. |
| `--yes` | Skip the prompts. Without a terminal and without `--yes`, `purge` refuses. |

Stop the server first; `purge` warns if the database still lists open sessions.

## `config`

| Command | Output |
|---|---|
| `config show [--json]` | Every key with its effective value, source and shadowed values. Secrets are `<redacted>`. `--json` prints `{ key: { value, source, shadowed } }`. |
| `config schema` | The JSON Schema for `browserhive.config.json`. |
| `config validate [--config <path>]` | Runs the full resolver and prints exactly what `serve` would; exit `64` on error. |

## `db`

| Command | Meaning |
|---|---|
| `db status` | Schema version, oldest compatible reader version, pending migrations, size, last backup, integrity check. |
| `db backup [--out <file>]` | Consistent copy of the database (`VACUUM INTO`). |
| `db restore <file> [--yes]` | Replace the database with a backup. Refuses while a server is running, checks the file is a BrowserHive database, and backs up the current file first. |
| `db migrate [--dryRun]` | Apply pending migrations (normally done by `serve`). |

See [Upgrading](upgrading.md).

## `admin`

| Command | Meaning |
|---|---|
| `admin reset-password` | New seed password for the dashboard, printed once and written to `admin/credentials.txt` (`0600`); a change is forced at next login. Refuses while the server is running. |
| `admin tokens list [--json]` | Agent bearer tokens: name, public prefix, created, last used. |
| `admin tokens create <name> [--json]` | Issue a token. The plaintext is shown only now. |
| `admin tokens revoke <name>` | Revoke immediately. |

Token commands work on the database directly when the server is stopped, or through the REST API of a running server with `--url <server>` and an operator credential.

## `version`

```
browserhive 0.1.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright 1.63.0)
```

`--json` for scripts.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or clean shutdown after a signal. |
| `1` | Fatal runtime error (a boot phase failed after configuration, storage corruption, `purge` or `doctor` failure). |
| `2` | `doctor` found warnings only. |
| `3` | Policy refusal at startup: [`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED), [`ADMIN_REQUIRES_HTTP`](../reference/errors.md#ADMIN_REQUIRES_HTTP), [`BLOCKLIST_LOAD_FAILED`](../reference/errors.md#BLOCKLIST_LOAD_FAILED), [`PORT_IN_USE`](../reference/errors.md#PORT_IN_USE), [`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY). Printed as `[CODE] message`. |
| `64` | Usage error: unknown flag or key, invalid value, conflicting settings, missing argument. |
| `130` | A second interrupt arrived before graceful shutdown finished. |
