# Installation

BrowserHive ships as one npm package, `browserhive`, which provides the `browserhive` command and a programmatic API. It runs on **Bun**. You can install it with bun, npm or pnpm, but Bun must be installed to run it.

## Requirements

| Requirement | Why | How |
|---|---|---|
| **Bun ≥ 1.4** | The only supported runtime. BrowserHive uses Bun's HTTP server, SQLite and password hashing directly. | macOS/Linux: `curl -fsSL https://bun.sh/install \| bash`. Windows: `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Chromium** | The browser that runs sessions by default. | Installed once by `browserhive init`. It is never downloaded during `npm install`. |
| Google Chrome or Microsoft Edge | Optional: run sessions in the browser installed on the machine instead. | Found by `browserhive init`, which can also install Google Chrome for you. See [Choosing the browser](#choosing-the-browser). |
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
4. Reports the browsers on this machine and whether each can run inside Chromium's sandbox, then lets you pick the default browser (next section).
5. Creates the database and applies migrations.
6. Prints next steps.

Useful flags: `--force` re-downloads the browsers, `--dataDir <path>` and `--config <path>` choose where state lives. Network access is only needed for the downloads. Re-run `init` after upgrading BrowserHive; it only downloads what changed.

If you skip `init`, the first `launch_session` fails with [`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED) and the message names the command to run.

## Choosing the browser

Sessions can run in one of three browsers, called channels:

| Channel | What it is | Good for |
|---|---|---|
| `chromium` (default) | Chrome for Testing, downloaded by `init` and pinned to the version this BrowserHive release was tested with. Always kept. | Same build on every machine; nothing to install; works in CI, Docker and without admin rights. |
| `chrome` | The Google Chrome installed on the machine. | Stealth: it is the real browser at the version real users run, and on Ubuntu 23.10+ it can use Chromium's sandbox. Recommended for stealth. |
| `edge` | The Microsoft Edge installed on the machine. | Machines where Edge is the browser you have. |

On a terminal, `init` shows what it found and a menu:

```
✓ chromium    Chrome for Testing 153.0.8010.12 (bundled, always kept)
✓ chrome      Google Chrome 154.0.8037.57 at /opt/google/chrome/chrome
– edge        not installed
! sandbox     chrome: works · chromium: unavailable here (AppArmor), falls back

Which browser should sessions use by default?

  1) Chromium (bundled)                                   ← current
     + Same build everywhere; tested with this BrowserHive release
     + Nothing to install; works in CI, Docker and without admin rights
     − Reports its pinned full version (153.0.8010.12); your Google Chrome is 154.0.8037.57
     − Runs without the sandbox here unless you add an AppArmor profile

  2) Google Chrome (installed 154.0.8037.57)              recommended for stealth
     + The real browser at the version real users run; updates itself
     + Sandbox works on this machine
     − Updates on its own schedule: can get ahead of what BrowserHive was tested with
     − On a company-managed machine, browser policies apply (can block automation)
     − Persistent profiles made with a newer Google Chrome may not open in Chromium later

Choice [1]:
```

The pros and cons are worked out for your machine: which browsers can sandbox, which versions you have, managed policies, how far an installed browser is ahead of the tested build. Pressing **Enter keeps the current browser and changes nothing**. Picking another one asks before it saves `defaultChannel` to your config file (the one in use, or `<data-dir>/browserhive.config.json`); other settings in the file are kept.

When Google Chrome is not installed, the menu offers **Install Google Chrome**. That runs Google's official installer through Playwright (`playwright install chrome`) and needs administrator rights; nothing is installed unless you pick it.

In scripts, CI and containers `init` never asks anything:

```bash
browserhive init --installChrome                 # install Google Chrome, keep the default
browserhive init --channel chrome --yes          # make Chrome the default and save it
```

`--channel` without `--yes` does not write anything. A channel that is not installed is refused; BrowserHive never switches to another browser on its own. You can also set the default any time with `--defaultChannel` or `BROWSERHIVE_DEFAULT_CHANNEL`, and agents can choose per session with `launch_session`'s `channel`.

Installed browsers update themselves. `doctor` warns when the browser you use is more than one major version ahead of the build BrowserHive was tested with; update BrowserHive, or use the bundled Chromium.

## Check the host

```bash
browserhive doctor
```

`doctor` prints a table with one row per check and the fix for each failure:

- Bun version is at least 1.4.
- Chromium is installed for the resolved stealth driver (Playwright and Patchright), with exact versions.
- Google Chrome and Microsoft Edge: version and path, or "not installed" (fine).
- The configured `defaultChannel` is installed (a failure otherwise, with the install command).
- The browser in use is not more than one major version ahead of the tested build (a warning).
- No managed browser policy blocks automation, such as `RemoteDebuggingAllowed=false` (a failure for the configured browser).
- Chromium's sandbox, per installed browser: each one is launched once to find out (under the default `--sandbox auto` a browser that falls back is reported, not counted as a warning). When the configured browser cannot sandbox, the guidance under the table says why and what to do. See [Security: the browser sandbox](security.md#the-browser-sandbox).
- Whether BrowserHive runs as root or in a container, which rules out the sandbox.
- The data directory exists, has owner-only permissions and has free disk space.
- The configuration is valid. It runs the full resolver and prints any shadow lines.
- The port is free on the configured host.
- `bw` is on `PATH` when `vault=bitwarden`.
- The database opens, with its schema version, pending migrations and last backup.
- The OTLP endpoint is reachable when `otel=true` (a warning only).
- `maxSessions` makes sense for the host's RAM.
- A config file that contains `authTokens` is not readable by other users.

Exit code `0` means every check passed, `2` means warnings only, `1` means at least one check failed. `browserhive doctor --json` prints the same data as an array of `{ check, status, detail }`. `browserhive doctor --printApparmorProfile` prints an AppArmor profile that lets the configured browser sandbox on Ubuntu 23.10+; it installs nothing.

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
