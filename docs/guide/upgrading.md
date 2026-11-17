# Upgrading and downgrading

BrowserHive follows semantic versioning from `0.1.0`. While the major version is `0`, breaking changes bump the minor version. Release notes are in the changelog and on GitHub Releases.

## Upgrade

```bash
bun add -g browserhive@latest     # or: npm i -g browserhive@latest / pnpm add -g browserhive@latest
browserhive init                  # refreshes the browser if the Patchright version moved
browserhive doctor
```

Then restart the server. On the first start of the new version:

1. The database is checked. If migrations are pending, a backup is written **first** to `<data-dir>/backups/browserhive-v<old>-<timestamp>.db`.
2. Pending migrations run inside one transaction. If any step fails, nothing is applied and the server exits with [`MIGRATION_FAILED`](../reference/errors.md#MIGRATION_FAILED); your data is untouched and the backup is there.
3. Only the newest backups are kept (`--backupsKeep`, default 5).

See what happened with `browserhive db status`, which shows the schema version, the migration history and the last backup. The dashboard's System page shows the same.

To migrate without starting the server, for example in a deployment script:

```bash
browserhive db migrate --dryRun   # list what would run
browserhive db migrate
```

Prereleases are published under the `next` tag: `bun add -g browserhive@next`.

### From 0.1.x to 0.2

The first start of 0.2 migrates the database from schema v2 to v6, after writing the backup. Every step only adds tables or columns, so a 0.1.x release can still open the upgraded database, and nothing is invented for existing rows:

- **Harness identity (schema v3).** Sessions and MCP connections record which agent was connected ([harness identity](mcp-clients.md#harness-identity)). Sessions from before the upgrade read **Unknown**.
- **The browser and its sandbox per session (schema v4).** Each session stores whether it ran inside Chromium's sandbox and the browser's real version when its browser launches, so closed sessions keep showing them. Sessions from before the upgrade show "not recorded", which does not mean the sandbox was off.
- **Notifications gain a message contract (schema v5).** Every notification gets the contract's fields (kind, category, severity, state, revision, thread), and three tables hold delivery to chat apps (channels, the delivery outbox and the sent-message index). Existing notifications are classified from what they already recorded; an attention request's notification reads as resolved or expired when the request was. See [Notifications](notifications.md).
- **Answering from your phone (schema v6).** Three tables are added: the act-button tokens (hashes only), the audit of button presses, and where each chat connection resumes. See [Answer from your phone](notifications.md#answer-from-your-phone). Daily digests, anomaly alerts and the Reports tab need no further migration.

Two behaviour changes to know about:

- **The browser sandbox is on by default.** Sessions now run inside Chromium's sandbox wherever the machine allows it (`--sandbox auto`). Where it cannot (Ubuntu 23.10+ with the bundled browser, root, Docker), sessions run as before and `browserhive doctor` explains why and how to fix it (still exit code 0). `--sandbox off` restores the previous behaviour exactly. See [Security: the browser sandbox](security.md#the-browser-sandbox).
- **Environment variables in the config file.** A string in `browserhive.config.json` that contains `{env:NAME}` is now read as a [reference](configuration.md#references) to that variable, and `${env:NAME}`, `{ENV:NAME}` or `{file:…}` stop startup with a hint. Other braces, such as `{trace_id}` in `otelTraceUrlTemplate`, are left alone; write `{{…}}` to keep text that looks like a reference literal.

### Saved logins move per principal

From 0.2.3, saved logins are kept per principal ([Security: saved logins are per principal](security.md#saved-logins-are-per-principal)). The no-auth `local` principal keeps the flat `auth-states/<name>.*` layout, so single-user installs see no change. Snapshots of token principals live in `auth-states/p/<id>/<name>.*`.

On the first start of 0.2.3, every snapshot in the flat layout whose manifest names another owner is moved into that owner's directory, with its identity seed. The move is safe to interrupt: whatever was not moved yet is finished on the next start.

If you use more than one token: before 0.2.3, an agent that saved a login under a name another principal already used took that name over (the snapshot and its owner were replaced). Such a takeover cannot be detected after the upgrade, because the files then belong to whoever saved last. Ask each agent to call `list_saved_auths`, check that each saved login is the one it expects, and save again any that is missing or wrong.

### To 0.3: Patchright is the only browser driver

From 0.3.0 every session runs on Patchright, whatever its stealth level. Stock Playwright is no longer used, and the `stealthDriver` setting is gone.

What you may need to change:

- **Remove `stealthDriver`** from your config file, environment (`BROWSERHIVE_STEALTH_DRIVER`) and command line.
  - `stealthDriver: playwright` now stops startup (exit code 64) with a message that says to remove it.
  - `auto` and `patchright` still start, with a warning that the setting is ignored. From 0.4.0 the name is an unknown key and stops startup like any other.
- **Run `browserhive init` again** if you had set `stealthDriver: playwright` and never installed Patchright's Chromium. Patchright and Playwright of the same version use the same Chromium build and the same browser folder, so on most machines there is nothing to download.
- **For a browser without BrowserHive's stealth, use `--stealth off`.** It no longer means "stock Playwright": the session still runs on Patchright, so `navigator.webdriver` is `false` there too. See [what `off` still includes](stealth.md#what-off-still-includes).
- **Pages' console messages and uncaught page errors are not reported.** Patchright never enables the browser's console and runtime domains, at any stealth level, so a trace's console tab stays empty and page errors (`pageerror`) never fire. If you relied on either, log from the page another way.
- **Chromium's popup blocker is on in every session.** A page opens a popup only from a user gesture, as in a normal browser: popups a page opens from a timer or after an `await` (some sign-in flows) are blocked. Clicks an agent makes count as gestures. Patchright also leaves Chromium's component updates, default apps and extensions enabled.
- **The trace viewer is unchanged.** It is now served from Patchright's package; traces look the same.
- **`/api/v1/system`**: `runtime.patchright` is the driver's version (`null` only when its package cannot be read). `runtime.playwright` is a deprecated alias of it (the same string, or `unknown` when `runtime.patchright` is `null`) and will be removed with the next API version. `stealth.driver` is always `patchright`. New `stealth.cors_preflights` says whether routed browsers send real CORS preflights (`enforced`, `pending` before the first one starts, `refused` with the `PREFLIGHTS_NOT_ENFORCED` degradation).
- **CORS preflights are honoured with request interception too.** Before 0.3.0, a session with a configured blocklist let the browser driver answer CORS preflights itself, so a page could send a cross-origin write the site refused at preflight. Now the browser sends every preflight to the site and honours its answer at every stealth level, with or without interception (a configured blocklist, every template browser). A page that relied on the old behaviour to reach an API that refuses its origin will now get a CORS error, as in a normal browser. With interception, BrowserHive keeps the site's preflight answers for the time the site allows, because the HTTP cache is off. See the templates guide's [known limits](templates.md#known-limits).
- `browserhive version` lists Patchright only, and `browserhive doctor` has one browser row, `chromium (patchright)`.

## Downgrade

Nothing is ever migrated downward in place. Instead, each database records two numbers: its schema version, and the **oldest schema version whose code can still read it**. Purely additive migrations (new tables or columns) do not raise the second number.

- **Within the compatibility window:** an older release opens a newer database normally.
- **Outside the window:** the older release refuses to start with [`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY) (exit code 3). The message names the backup that was written before the upgrade.

To go back:

```bash
browserhive db status                                       # with the newer version, if still installed
bun add -g browserhive@<older-version>
browserhive db restore ~/.local/share/browserhive/backups/browserhive-v3-20260914T101500Z.db
```

A release older than 0.2.3 does not know the per-principal saved-login directories: after a downgrade, token principals' saved logins under `auth-states/p/` are invisible to it (they are not deleted, and reappear after upgrading again). Logins saved by the `local` principal keep working. A login a token principal saves while downgraded goes to the shared flat layout again and is moved on the next upgrade; if that principal also has a copy of the same name from before the downgrade, the newer one is kept.

`db restore` refuses while a server is running, checks that the file is a BrowserHive database, and copies the current database aside before replacing it. Anything recorded since the backup (sessions, audit rows, vault bindings changed in the meantime) is not in the restored file.

Take a manual backup before risky changes:

```bash
browserhive db backup --out ./browserhive-before-change.db
```

## Browser versions

Patchright, the browser driver, is pinned per release. After an upgrade that moves the pin, the installed browser build does not match the driver, and `launch_session` fails with [`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED) until you run `browserhive init`.
