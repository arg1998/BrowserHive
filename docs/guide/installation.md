# Installation

BrowserHive ships as one npm package, `browserhive`, which provides the `browserhive` command and a programmatic API. It runs on **Bun**. You can install it with bun, npm or pnpm, but Bun must be installed to run it.

## Requirements

| Requirement | Why | How |
|---|---|---|
| **Bun ≥ 1.4** | The only supported runtime. BrowserHive uses Bun's HTTP server, SQLite and password hashing directly. | macOS/Linux: `curl -fsSL https://bun.sh/install \| bash`. Windows: `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Chromium** | The browser that runs every session. | Installed once by `browserhive init`. It is never downloaded during `npm install`. |
| **Bitwarden CLI (`bw`)** | Only if you use the vault (`--vault bitwarden`). | See [the vault guide](vault.md). |
| macOS, Linux or Windows | | |

Node.js is not a supported runtime. `npm` and `pnpm` work for installing because the `browserhive` command starts with `#!/usr/bin/env bun`.

## Install the package

Pick one:

```bash
bun add -g browserhive
npm i -g browserhive
pnpm add -g browserhive
```

Without a global install, `bunx browserhive` (or `npx browserhive`, with Bun on `PATH`) works for every command below.

## Install the browser and prepare the data directory

```bash
browserhive init
```

`init` is the one-time setup. Each step is idempotent and reported with ✓ or ✗:

1. Creates the data directory (mode `0700`) and its subdirectories.
2. Downloads Chromium for the pinned Playwright version. `PLAYWRIGHT_BROWSERS_PATH` is honoured.
3. Downloads the Patchright build of Chromium, used by stealth sessions, unless `--stealthDriver playwright` is set.
4. Creates the database and applies migrations.
5. Prints next steps.

Useful flags: `--force` re-downloads the browsers, `--dataDir <path>` and `--config <path>` choose where state lives. Network access is only needed for the browser download. Re-run `init` after upgrading BrowserHive; it only downloads what changed.

If you skip `init`, the first `launch_session` fails with [`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED) and the message names the command to run.

## Check the host

```bash
browserhive doctor
```

`doctor` prints a table with one row per check and the fix for each failure:

- Bun version is at least 1.4.
- Chromium is installed for the resolved stealth driver (Playwright and Patchright), with exact versions.
- The data directory exists, has owner-only permissions and has free disk space.
- The configuration is valid. It runs the full resolver and prints any shadow lines.
- The port is free on the configured host.
- `bw` is on `PATH` when `vault=bitwarden`.
- The database opens, with its schema version, pending migrations and last backup.
- The OTLP endpoint is reachable when `otel=true` (a warning only).
- `maxSessions` makes sense for the host's RAM.
- A config file that contains `authTokens` is not readable by other users.

Exit code `0` means every check passed, `2` means warnings only, `1` means at least one check failed. `browserhive doctor --json` prints the same data as an array of `{ check, status, detail }`.

## Where BrowserHive keeps its data

| OS | Default data directory |
|---|---|
| macOS | `~/Library/Application Support/BrowserHive` |
| Windows | `%LOCALAPPDATA%\BrowserHive` |
| Linux | `$XDG_DATA_HOME/browserhive`, or `~/.local/share/browserhive` |

Override it with `--dataDir` or `BROWSERHIVE_DATA_DIR`. The layout:

```
<data-dir>/
  browserhive.db                 SQLite: sessions, audit trail, auth, vault policy, notifications
  backups/                       database backups written before migrations
  admin/credentials.txt          first-run dashboard password (removed after you change it)
  sessions/<id>/                 userdata, trace.zip, screenshots/, downloads/
  auth-states/                   saved logins (storage states, profile zips)
  uploads/
  browserhive.config.json        optional configuration file
```

Directories are created with mode `0700` and secret files with `0600`.

## Next

- [Quick start](quick-start.md)
- [Connect your MCP client](mcp-clients.md)
