# Command line

```
browserhive [serve] [flags]            start the server (default command)
browserhive init [flags]               install browsers, choose the default one, create the data dir
browserhive doctor [flags]             diagnose the host and configuration
browserhive purge [flags]              delete local state (inventory, then confirmation)
browserhive config show|schema|validate
browserhive db status|backup|restore <file>|migrate
browserhive admin reset-password
browserhive admin tokens list|create <name>|revoke <name>
browserhive channels list | test <name> | preview <name> [--sample <kind>]
browserhive templates list | create <name> --sites <site,…> | finish <name> | rm <name>
browserhive version | --version | -v
browserhive help [command] | --help | -h
```

`bh` is installed as a shorthand for `browserhive` and takes the same arguments: `bh doctor` is `browserhive doctor`. These docs use the full name, which is what scripts and MCP client configurations should use too (see [the `bh` shorthand](installation.md#the-bh-shorthand)).

If the first argument is not a command word, `serve` is assumed and every argument is a flag. Each command accepts only its own flags; passing a server flag to `purge` is a usage error. `--help` wins over everything, `--version` over everything except `--help`, and `--` ends flag parsing.

Help text is generated from the configuration schema, so `browserhive --help` always lists every server flag with its type, default and environment variable. Flags are camelCase; see [Configuration](configuration.md).

## `serve`

Resolves the configuration, opens storage (migrating the database if needed), starts the listener and prints the banner:

```
 BrowserHive 0.2.0  ·  bun 1.4.2  ·  patchright 1.63.0
 MCP        http://127.0.0.1:9876/mcp            (auth: token)
 Dashboard  http://127.0.0.1:9876/               (admin)
 Data dir   /home/me/.local/share/browserhive     (db v6, 12 MiB, 3 backups)
 Config     env:2  file:/home/me/browserhive.config.json:9  cli:1
 Sessions   cap 8 (derived from 12 GiB RAM) · lease 2h · persistence memory
 Stealth    standard · patchright · humanize on · fingerprint off
 Telemetry  otel → http://127.0.0.1:4318 (http/protobuf)
 Vault      bitwarden (locked)
 Notify     2 channels (1 from startup) · links → https://browserhive.example.net

 config: maxSessions=8 (cli) shadows config-file=4
 Press Ctrl-C to stop.
```

The **Notify** row appears once a [notification channel](notifications.md#channels) or [`publicUrl`](notifications.md#public-address) is set. The first-run dashboard password and the first agent token are printed once in this banner and never logged. `Ctrl-C` (or `SIGTERM`) stops gracefully within `--shutdownTimeout`: listeners, then sessions (traces are finalized), then storage. A second `Ctrl-C` exits immediately with code 130.

Output streams: under `--transport stdio`, stdout carries only MCP frames and everything else goes to stderr. Under HTTP, the banner and pretty logs go to stdout on a terminal, and JSON logs go to stderr, so `browserhive 2> logs.jsonl` captures them. Colour is on for terminals; `NO_COLOR` or `--color never` disables it.

All server flags are in the [configuration reference](../reference/configuration.md).

### Notification channels

`--notificationChannel` declares a notification channel for this run ([startup channels](notifications.md#startup-channels)). Repeat it for several channels. It is a flag only: there is no environment variable or config-file key for it.

```
--notificationChannel "<platform>:<param>=<value>,<param>=<value>…"
```

A list value joins its items with `+`; a value cannot contain `,` (write `%2C`). Secret parameters are always `env:NAME`, the name of an environment variable (not starting with `BROWSERHIVE_`); a secret written into the flag is refused with exit 64, because process arguments are visible to other users of the machine.

| Platform | Parameters |
|---|---|
| `telegram` | `name`, `token=env:NAME`, `chat` (a chat id), optional `thread` (a forum topic id) |
| `discord` | webhook mode: `name`, `webhook=env:NAME` (the webhook URL). Bot mode: `name`, `mode=bot`, `token=env:NAME` (the bot token), `channel` (the channel id), optional `guild` (the server id) |
| `ntfy` | `name`, `topic` (a topic, or `env:NAME`), optional `server` (default `https://ntfy.sh`), `token=env:NAME`, `reply` (the [reply topic](notifications.md#ntfy-a-second-topic-for-answers) for act buttons, or `env:NAME`), `replyToken=env:NAME` |
| `webhook` | `name`, `url` (a URL, or `env:NAME`), optional `secret=env:NAME` (the signing key) |

Rules, all optional: `categories` (`needs-you+problems+wrap-ups+reports+system`), `min` (`info`, `warn`, `error`, `critical`), `sessions` (session name patterns such as `shop-*`), `harness`, `content` (`counts`, `titles`, `full`), `quiet=22:00-07:00`, `tz=Europe/Berlin` (the channel's time zone, for quiet hours and reports; default BrowserHive's), `digest` (`daily@09:00`, `daily:weekdays@09:00` for Monday to Friday, `weekly:fri@17:00`; the day and time may be left out: `daily` is every day at 09:00, `weekly` is Friday at 17:00), `anomaly=on` with `anomaly.errorRate` (percent or `off`), `anomaly.minCalls`, `anomaly.attention` (minutes or `off`), `anomaly.blocked` (the spike factor or `off`), `anomaly.blockedMin`, `anomaly.capacity` and `anomaly.degraded` (`on`/`off`) ([daily digests and anomaly alerts](notifications.md#daily-digests-and-anomaly-alerts)), `ttl.<category>=2h` (Telegram at most `47h`), `deleteWhenResolved` (`true`, or a `+` list of categories), `images` (a `+` list of categories; needs `content=full`), `maskImages=true`, `actButtons=true` ([answer from your phone](notifications.md#answer-from-your-phone); Telegram, Discord bot mode, ntfy with `reply`, webhook) and `allow` (a `+` list of Telegram or Discord user ids allowed to press them; not for ntfy).

## `init`

One-time setup, safe to re-run:

1. Create the data directory (`0700`) and subdirectories.
2. Install Chromium for Playwright (honours `PLAYWRIGHT_BROWSERS_PATH`).
3. Install Patchright's Chromium when `stealthDriver` is `auto` or `patchright`.
4. Report the browsers on this machine (bundled Chromium, installed Google Chrome and Microsoft Edge) and whether each can run inside Chromium's sandbox; on a terminal, offer the default-browser menu (Enter keeps the current one). See [Installation: choosing the browser](installation.md#choosing-the-browser).
5. Create or migrate the database.
6. Print next steps.

| Flag | Meaning |
|---|---|
| `--browsers chromium` | Browsers to install (only `chromium` today; Chrome and Edge channels use the OS installation). |
| `--force` | Re-download even if present. |
| `--skipBrowsers` | Skip the browser downloads (data directory and database only). |
| `--dataDir <path>`, `--config <path>` | Where state and configuration live. |
| `--stealthDriver <auto\|patchright\|playwright>` | `playwright` skips the Patchright download. |
| `--writeSchema` | Write `browserhive.schema.json` next to a discovered config file. |
| `--channel <chromium\|chrome\|edge>` | Make this the default browser and save `defaultChannel` to the config file. Without a terminal it needs `--yes`. |
| `--installChrome` | Install Google Chrome with Google's installer (`playwright install chrome`; needs administrator rights). |
| `--yes` | Save the `--channel` choice without asking. |

`init` never asks anything without a terminal, in CI (`CI` set) or in a container.

## `doctor`

Checks Bun, that the first `bh` on `PATH` is BrowserHive's [shorthand](installation.md#the-bh-shorthand) (a warning when it is another program), browsers (the bundled Chromium, installed Chrome and Edge, that the configured `defaultChannel` is installed, version drift, managed policies that block automation), Chromium's sandbox for each installed browser (each is launched once), running as root or in a container, data directory permissions and disk space, configuration, port availability, `bw` when the vault is on, the database and pending migrations, agent tokens that act as a [reserved principal](mcp-clients.md#reserved-names) (a warning naming each token, which it never revokes), the OTLP endpoint when telemetry is on, `maxSessions` against RAM, `publicUrl` (whether it reaches this BrowserHive; see [public address](notifications.md#public-address)), notification channels (each `--notificationChannel` parses and every variable a channel names is set), and config-file permissions when it holds secrets (not when `authTokens` only [references](configuration.md#references) environment variables). It counts the values that came from references and warns about each referenced variable that was not set, so its default is in use. It also warns when the data directory contains an unrecognised data file, which BrowserHive neither reads nor migrates.

`--json` prints `[{ check, status, detail }]`. Exit codes: `0` all good, `2` warnings only, `1` a check failed. When the configured browser cannot run sandboxed, the text output ends with what to do on this machine. `--printApparmorProfile` prints an AppArmor profile for the configured browser (for Ubuntu 23.10+) and exits; install it yourself with `sudo tee /etc/apparmor.d/<name>` and `sudo apparmor_parser -r`.

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
| `config show [--json]` | Every key with its effective value, source and shadowed values. Secrets are `<redacted>`. A value read from an environment variable through a [reference](configuration.md#references) shows `config-file via $NAME`. `--json` prints `{ key: { value, source, shadowed, … } }`, with `refs` and `template` for referenced values. |
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

## `channels`

| Command | Meaning |
|---|---|
| `channels list [--json]` | Every notification channel: platform (with the Discord mode), status (and "from startup"), where it sends, whether its variables are set, whether chat answers reach BrowserHive (`connected`, `reconnecting`, `offline (reason)`, or `—` when act buttons are off), the last delivery and the last 24 hours; under the table, each channel's next digest in its time zone and its anomaly state. |
| `channels test <name> [--json]` | Sends a real test message. Exit `0` when the platform accepted it, `1` with the reason when it did not. |
| `channels preview <name> [--sample <kind>] [--json]` | Prints the platform request a send would make (secrets shown as variable names); sends nothing. Samples: `attention` (default), `attention-resolved`, `vault-confirm`, `tool-errors`, `crash`, `degraded`, `test`, `digest`, `anomaly` (the report samples follow the channel's schedule, zone and content level). |

They talk to the running server: `--url` defaults to the configured host and port, and `--token` (an operator API token) or `--cookie` authenticates. See [Notifications](notifications.md).

## `templates`

Manage [session templates](templates.md) on a running server started with `--admin`. Like `channels`, these commands use the REST API: `--url` defaults to the configured host and port, and `--token` (an operator API token with the `templates:*` scopes the command needs) or `--cookie` authenticates. `--json` prints the API's answer.

| Command | Meaning |
|---|---|
| `templates list [--json]` | Every template: name, status (`setting up`, `ready`, `disabled`), each site with a mark for its sign-in state (✓ signed in, ✗ signed out, · not checked), the state of its browser, sessions against the cap, and when it was last used. |
| `templates create <name> --sites <site,…> [flags]` | Create a template, open the sign-in window and wait for you to sign in (below). |
| `templates finish <name>` | Complete a template that is still setting up (after `--timeout`, a cancel or `--noLogin`): sites you never confirmed are kept and marked signed out, and the template becomes `ready`. |
| `templates rm <name> [--force] [--yes]` | Delete a template: stop its browser and delete its directory. Asks you to type the name on a terminal and refuses without one unless `--yes`. With live sessions it fails (`TEMPLATE_IN_USE`) unless `--force`, which closes them. Deleting does not sign you out at the sites. |

### `templates create`

```
browserhive templates create <name> --sites <site,…> [--displayName <text>] [--description <text>]
    [--channel <chromium|chrome|edge>] [--headless] [--stealth <off|standard|max>]
    [--proxy <url> --proxyUsername <name> --proxyPasswordEnv <ENV>] [--locale <tag> --timezone <iana>]
    [--maxConcurrent <1-20>] [--allPrincipals | --principal <subject>…] [--noLogin] [--timeout <duration>]
```

| Flag | Meaning |
|---|---|
| `<name>` | What agents pass as `template`: 2 to 32 characters, lower-case letters, digits and `-`, starting with a letter. |
| `--sites` | 1 to 16 sites, comma-separated. Each is reduced to its registrable domain (`www.linkedin.com` is `linkedin.com`). |
| `--displayName`, `--description` | Shown in lists; agents see the description in `list_templates`. |
| `--channel` | The browser: the bundled `chromium`, or the installed `chrome` or `edge`. Default: `defaultChannel`. |
| `--headless` | No window. Sites challenge headless browsers more often, and you cannot sign in by hand. |
| `--stealth` | Default: the server's `stealth`. Avoid `off`, which runs on the stock driver ([known limits](templates.md#known-limits)). |
| `--proxy`, `--proxyUsername`, `--proxyPasswordEnv` | One fixed proxy (`scheme://host:port`, no credentials in the URL). The password is the **name** of an environment variable on the server, not starting with `BROWSERHIVE_`. With `--proxy`, `--locale` and `--timezone` are required. |
| `--locale`, `--timezone` | The identity's language tag and IANA time zone. Default: this machine's. Fixed for the template's life. |
| `--maxConcurrent` | Sessions of this template at once, 1 to 20. Default 5. |
| `--allPrincipals` | Every agent may launch it. |
| `--principal <subject>` | Only this principal (an agent token's name) may launch it; repeat for more. Under `--auth token` one of `--allPrincipals` and `--principal` is required. |
| `--noLogin` | Create the template and exit without opening a window. |
| `--timeout` | How long to wait for you, default `30m`. |

What it does:

1. Creates the template (status `setting up`) and opens the sign-in window **on the machine running the server**, with one tab per site. When `--url` points at another machine, the command warns that the window opens there.
2. Prints one line per site, and waits.
3. Ends when every site is signed in, when you press **Enter**, or at `--timeout`:
   - **Enter** confirms every site you have not confirmed yet ("I'm signed in"); a site where no new cookie appeared since the window opened stays signed out. It then lists unlisted sign-ins (`Also signed in to: mail.example — agents can use this`) and removes them unless you answer no, and sets the template `ready`.
   - **`--timeout`** leaves the template setting up; `templates finish <name>` completes it later.

Exit codes: `0` the template is ready with every site signed in; `1` failure (server unreachable, an API error printed as `[CODE] message`); `2` finished with a site not signed in, or timed out; `64` usage error.

`templates show`, `seed`, `login`, `probe`, `versions`, `restore`, `host`, `disable`, `enable` and `rekey`, and seeding with `--fromState`, arrive in later releases.

## `version`

```
browserhive 0.2.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright 1.63.0)
```

`--json` for scripts.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or clean shutdown after a signal. |
| `1` | Fatal runtime error (a boot phase failed after configuration, storage corruption, `purge` or `doctor` failure). |
| `2` | `doctor` found warnings only; `templates create` finished with a site not signed in, or timed out. |
| `3` | Policy refusal at startup: [`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED), [`ADMIN_REQUIRES_HTTP`](../reference/errors.md#ADMIN_REQUIRES_HTTP), [`BLOCKLIST_LOAD_FAILED`](../reference/errors.md#BLOCKLIST_LOAD_FAILED), [`PORT_IN_USE`](../reference/errors.md#PORT_IN_USE), [`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY), [`SANDBOX_UNAVAILABLE`](../reference/errors.md#SANDBOX_UNAVAILABLE) (`--sandbox on`). Printed as `[CODE] message`. |
| `64` | Usage error: unknown flag or key, invalid value, conflicting settings, missing argument. |
| `130` | A second interrupt arrived before graceful shutdown finished. |
