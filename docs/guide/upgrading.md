# Upgrading and downgrading

BrowserHive follows semantic versioning from `0.1.0`. While the major version is `0`, breaking changes bump the minor version. Release notes are in the changelog and on GitHub Releases.

## Upgrade

```bash
bun add -g browserhive@latest     # or: npm i -g browserhive@latest / pnpm add -g browserhive@latest
browserhive init                  # refreshes browsers if the Playwright version moved
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

`db restore` refuses while a server is running, checks that the file is a BrowserHive database, and copies the current database aside before replacing it. Anything recorded since the backup (sessions, audit rows, vault bindings changed in the meantime) is not in the restored file.

Take a manual backup before risky changes:

```bash
browserhive db backup --out ./browserhive-before-change.db
```

## Browser versions

Playwright and Patchright are pinned per release. After an upgrade that moves the pin, the installed browser build does not match the driver, and `launch_session` fails with [`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED) until you run `browserhive init`.
