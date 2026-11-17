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
browserhive templates list | show | create | finish | login | probe | seed | versions | save | restore | host | disable | enable | rm | rekey
browserhive sitepacks list | show | diff | apply | reject | revert | pin | unpin | follow | approve-local | enable | disable | reload | import | verify
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
2. Install Chromium for Patchright, BrowserHive's browser driver (honours `PLAYWRIGHT_BROWSERS_PATH`).
3. Report the browsers on this machine (bundled Chromium, installed Google Chrome and Microsoft Edge) and whether each can run inside Chromium's sandbox; on a terminal, offer the default-browser menu (Enter keeps the current one). See [Installation: choosing the browser](installation.md#choosing-the-browser).
4. Create or migrate the database.
5. Print next steps.

| Flag | Meaning |
|---|---|
| `--browsers chromium` | Browsers to install (only `chromium` today; Chrome and Edge channels use the OS installation). |
| `--force` | Re-download even if present. |
| `--skipBrowsers` | Skip the browser download (data directory and database only). |
| `--dataDir <path>`, `--config <path>` | Where state and configuration live. |
| `--writeSchema` | Write `browserhive.schema.json` next to a discovered config file. |
| `--channel <chromium\|chrome\|edge>` | Make this the default browser and save `defaultChannel` to the config file. Without a terminal it needs `--yes`. |
| `--installChrome` | Install Google Chrome with Google's installer (`patchright install chrome`; needs administrator rights). |
| `--yes` | Save the `--channel` choice without asking. |

`init` never asks anything without a terminal, in CI (`CI` set) or in a container.

## `doctor`

Checks Bun, that the first `bh` on `PATH` is BrowserHive's [shorthand](installation.md#the-bh-shorthand) (a warning when it is another program), browsers (the bundled Chromium, installed Chrome and Edge, that the configured `defaultChannel` is installed, version drift, managed policies that block automation), Chromium's sandbox for each installed browser (each is launched once), running as root or in a container, data directory permissions and disk space, configuration, port availability, `bw` when the vault is on, the database and pending migrations, agent tokens that act as a [reserved principal](mcp-clients.md#reserved-names) (a warning naming each token, which it never revokes), the OTLP endpoint when telemetry is on, `maxSessions` against RAM, `publicUrl` (whether it reaches this BrowserHive; see [public address](notifications.md#public-address)), notification channels (each `--notificationChannel` parses and every variable a channel names is set), and config-file permissions when it holds secrets (not when `authTokens` only [references](configuration.md#references) environment variables). It counts the values that came from references and warns about each referenced variable that was not set, so its default is in use. It also warns when the data directory contains an unrecognised data file, which BrowserHive neither reads nor migrates.

When [session templates](templates.md) exist, `doctor` also checks them. It reads the database without migrating it and starts no template browser.

| Check | Warns (`!`) when | Fails (`✗`) when |
|---|---|---|
| `templates data` | `templates/`, `admin/`, a template's directories or its version files are open to other users (it prints the `chmod` to run). Modes are not checked on Windows. | `templates/` cannot be read. |
| `template key` | `admin/template.key` is broader than `0600` or holds no valid key; `templateKey` is given as a command-line flag; files were written with a key BrowserHive does not hold (names the templates); files are still on `templateKeyPrevious` (run `templates rekey`). | Encrypted files exist and no key resolves ([`TEMPLATE_KEY_MISSING`](../reference/errors.md#TEMPLATE_KEY_MISSING)). |
| `template access` | Under `--auth token`, a template's access names only `local`, which no agent token can be. | — |
| `template display` | On Linux, `DISPLAY` is set without `XAUTHORITY` outside a desktop session (an Xvfb started without `-auth`). On macOS and Windows it prints what a headed browser needs. | On Linux, a headed template that has never started on this machine, and neither `DISPLAY` nor `WAYLAND_DISPLAY` is set. |
| `template agents` | The transport is `stdio` or `--auth` is `off`: agents that can run commands as this user can read the templates directly. | — |
| `template browsers` | A template's browser has a different major version than at its first start. | A template's browser channel is not installed (it names the install command). |
| `template profiles` | A template's profile holds saved passwords or autofill data. | — |
| `template proxies` | — | A proxy password variable a template names is not set (the name only, never a value). |
| `template memory` | `maxSessions` does not fit in RAM when each template used in the last 24 hours counts at `templateRecycleRss`. | — |

`--json` prints `[{ check, status, detail }]`. Exit codes: `0` all good, `2` warnings only, `1` a check failed. When the configured browser cannot run sandboxed, the text output ends with what to do on this machine. `--printApparmorProfile` prints an AppArmor profile for the configured browser (for Ubuntu 23.10+) and exits; install it yourself with `sudo tee /etc/apparmor.d/<name>` and `sudo apparmor_parser -r`.

## `purge`

Deletes local state after showing what will go: row counts per table, directory sizes and absolute paths.

| Flag | Meaning |
|---|---|
| (none) | Delete the database (with its WAL files) and `sessions/`. You type `YES` to confirm. |
| `--all` | Also delete saved logins, session templates (`templates/`: their browser profiles and versions), site packs (`site-packs/`), uploads, backups and `admin/` (the dashboard credentials and the template key, `admin/template.key`). Vault bindings and policies are lost with the database. Asks for a second `YES`. |
| `--dryRun` | Print the inventory and exit. |
| `--yes` | Skip the prompts. Without a terminal and without `--yes`, `purge` refuses. |

Stop the server first; `purge` warns if the database still lists open sessions. Without `--all`, it also warns when `templates/` holds template directories: purging the database alone orphans them (their rows go, the directories stay and are never used again). Pass `--all` to delete them too.

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

Manage [session templates](templates.md) on a running server started with `--admin`. Like `channels`, these commands use the REST API: `--url` defaults to the configured host and port, and `--token` (an operator API token with the `templates:*` scopes the command needs) or `--cookie` authenticates. `--json` prints the API's answer. The exception is `templates rekey`, which runs locally against the data directory with the server stopped.

| Command | Meaning |
|---|---|
| `templates list [--json]` | Every template: name, status (`setting up`, `ready`, `disabled`), each site with a mark for its sign-in state (✓ signed in, ✗ signed out, ? couldn't tell, · not checked), the state of its browser, sessions against the cap, and when it was last used. |
| `templates show <name> [--json]` | One template: its settings, access, live sessions, newest version and checkpoint; its browser (state, pages, memory, restarts, sandbox, last error); and each site's sign-in state. It warns when the profile holds saved passwords or autofill data. |
| `templates create <name> --sites <site,…> [flags]` | Create a template, open the sign-in window and wait for you to sign in (below), or seed it with `--fromState`. |
| `templates finish <name>` | Complete a template that is still setting up (after `--timeout`, a cancel or `--noLogin`): sites you never confirmed are kept and marked signed out, and the template becomes `ready`. |
| `templates login <name> --site <site> [flags]` | Sign the template in to one of its sites again, in a window on the server's machine or with the site's vault login ([below](#templates-login)). |
| `templates probe <name> [--site <site>] [--json]` | Check now whether the template's sites are signed in ([below](#templates-probe)). |
| `templates seed <name> <file> [--yes]` | Replace the template's sign-ins with a Playwright storage-state file ([below](#templates-seed-and-templates-restore)). |
| `templates versions <name> [--json]` | The template's [versions](templates.md#versions-and-the-checkpoint), newest first: number, reason, time, size, sites signed in, pinned, Last good and whether the current key can read it; then the checkpoint. |
| `templates save <name> [--json]` | Save the running browser's sign-ins as a `manual` version. When nothing changed since the newest version it writes nothing and says so. Fails (`409`) when the template's browser is not running. |
| `templates restore <name> <version\|latest> [--forceClose] [--yes]` | Roll the template back to a version, or to `latest` (the checkpoint) ([below](#templates-seed-and-templates-restore)). |
| `templates host <name> start\|stop\|restart [--json]` | Start, stop or restart the template's browser. `stop` writes a final checkpoint and ends its sessions; `restart` gives them up to `templateDrainTimeout`, and also clears a browser that gave up after five failures. |
| `templates clipboard <name> deny\|allow [--restart] [--json]` | Turn [Deny clipboard writes](templates.md#deny-clipboard-writes) on (`deny`) or off (`allow`): whether pages in the template's browser may write your clipboard. Reaches a running browser's pages at once; pages that were already open are fully covered only after a browser restart, which the command points out. `--restart` restarts the browser in that case (its live sessions close). |
| `templates disable <name>`, `templates enable <name>` | `disable` ends the template's live sessions and refuses new launches; `enable` allows them again. Both print how many sessions were closed. |
| `templates rm <name> [--force] [--yes]` | Delete a template: stop its browser and delete its directory. Asks you to type the name on a terminal and refuses without one unless `--yes`. With live sessions it fails (`TEMPLATE_IN_USE`) unless `--force`, which closes them. Deleting does not sign you out at the sites. |
| `templates rekey --oldKeyEnv <ENV> [--json]` | Re-encrypt every template file with the current key, with the server stopped ([below](#templates-rekey)). |

### `templates create`

```
browserhive templates create <name> --sites <site,…> [--displayName <text>] [--description <text>]
    [--channel <chromium|chrome|edge>] [--headless] [--stealth <off|standard|max>]
    [--proxy <url> --proxyUsername <name> --proxyPasswordEnv <ENV>] [--locale <tag> --timezone <iana>]
    [--maxConcurrent <1-20>] [--allPrincipals | --principal <subject>…] [--denyClipboardWrites]
    [--noLogin | --fromState <file>] [--timeout <duration>] [--yes]
```

| Flag | Meaning |
|---|---|
| `<name>` | What agents pass as `template`: 2 to 32 characters, lower-case letters, digits and `-`, starting with a letter. |
| `--sites` | 1 to 16 sites, comma-separated. Each is reduced to its registrable domain (`www.linkedin.com` is `linkedin.com`). |
| `--displayName`, `--description` | Shown in lists; agents see the description in `list_templates`. |
| `--channel` | The browser: the bundled `chromium`, or the installed `chrome` or `edge`. Default: `defaultChannel`. |
| `--headless` | No window. Sites challenge headless browsers more often, and you cannot sign in by hand. |
| `--stealth` | `standard` or `max`. Default: the server's `stealth`, or `standard` when that is `off`: templates always run with stealth on ([known limits](templates.md#known-limits)). |
| `--proxy`, `--proxyUsername`, `--proxyPasswordEnv` | One fixed proxy (`scheme://host:port`, no credentials in the URL). The password is the **name** of an environment variable on the server, not starting with `BROWSERHIVE_`. With `--proxy`, `--locale` and `--timezone` are required. |
| `--locale`, `--timezone` | The identity's language tag and IANA time zone. Default: this machine's. Fixed for the template's life. |
| `--maxConcurrent` | Sessions of this template at once, 1 to 20. Default 5. |
| `--allPrincipals` | Every agent may launch it. |
| `--principal <subject>` | Only this principal (an agent token's name) may launch it; repeat for more. Under `--auth token` one of `--allPrincipals` and `--principal` is required. |
| `--denyClipboardWrites` | Pages in the template's browser cannot write your clipboard ([Deny clipboard writes](templates.md#deny-clipboard-writes)); sites can detect it. Off by default; change it later with `templates clipboard`. |
| `--noLogin` | Create the template and exit without opening a window. |
| `--fromState <file>` | Seed the template from a Playwright storage-state file instead of opening a window ([seeding](templates.md#seeding-from-a-storage-state)). The file is checked before anything is created. It cannot be combined with `--noLogin`, and it asks for no confirmation. |
| `--timeout` | How long to wait for you, default `30m`. |
| `--yes` | Approve the [site packs](site-packs.md) of the sites without asking. Without a terminal it is required when a site has a pack to approve. |

What it does:

1. **Shows the site packs.** Before anything is created, it reads the site-pack catalog (the token needs `sitepacks:read`) and prints, for each site a pack covers, the pack's title and version, where it comes from, its SHA-256, the site's terms on automation and whether writes need confirmation (or that the pack has no write guards, so the write policy has no effect yet). Adding a site approves its pack for every template ([Approval and provenance](site-packs.md#approval-and-provenance)), so when a pack is not approved yet it asks you to type `yes`; without a terminal it refuses unless `--yes`, and nothing is created. A pack already approved is listed and needs no answer. It sends each site with the SHA-256 it printed (`pack_sha256`), so the server approves exactly that version.
2. Creates the template (status `setting up`) and opens the sign-in window **on the machine running the server**, with one tab per site. When `--url` points at another machine, the command warns that the window opens there.
3. Prints one line per site, and waits.
4. Ends when every site is signed in, when you press **Enter**, or at `--timeout`:
   - **Enter** confirms every site you have not confirmed yet ("I'm signed in"); a site where no new cookie appeared since the window opened stays signed out. It then lists unlisted sign-ins (`Also signed in to: mail.example — agents can use this`) and removes them unless you answer no, and sets the template `ready`.
   - **`--timeout`** leaves the template setting up; `templates finish <name>` completes it later.

With `--fromState`, the command creates the template and seeds it like `templates seed`, without a window. If seeding fails, the template stays setting up: seed it again with `templates seed <name> <file>`, or delete it.

Exit codes: `0` the template is ready with every site signed in; `1` failure (server unreachable, an API error printed as `[CODE] message`, the site packs not approved); `2` finished with a site not signed in, or timed out (with `--fromState`: a site is signed out or needs a check after seeding); `64` usage error.

### `templates seed` and `templates restore`

```
browserhive templates seed <name> <file> [--yes]
browserhive templates restore <name> <version|latest> [--forceClose] [--yes]
```

Both replace the sign-ins of a template that agents may be using, so on a terminal they print what will happen and ask you to type the template's name. Without a terminal they refuse unless `--yes`. Both run on the server as an operation; the command waits for it and checks it every second. Ctrl+C stops waiting, and the operation goes on.

- **`seed`** checks the file first: at most 16 MiB, JSON, in Playwright's storage-state shape (`{"cookies": […], "origins": […]}`). It then closes the template's live sessions, restarts its browser with the file's state and writes an `import` version; a template still setting up becomes `ready`. It prints each site's sign-in state. The file is read in memory and never stored in plain text. See [Seeding from a storage state](templates.md#seeding-from-a-storage-state).
- **`restore`** takes a version number from `templates versions`, or `latest` for the checkpoint. Live sessions get up to `templateDrainTimeout` to end, then close; `--forceClose` closes them at once. The browser restarts with that state, which is saved as a new `restore` version. See [Restoring a version](templates.md#restoring-a-version).

Exit codes: `0` done; `1` failure (an API error, a refused confirmation, a file that cannot be used, or Ctrl+C); `2` (`seed` only) a site is signed out or needs a check afterwards; `64` usage error.

### `templates rekey`

```
browserhive templates rekey --oldKeyEnv <ENV> [--json]
```

Re-encrypts every template checkpoint and version file with the current key and updates the version rows. Use it to finish [rotating the key](templates.md#rotating-the-key).

- `--oldKeyEnv` is the **name** of an environment variable holding the old key (base64 of 32 bytes), for example `BROWSERHIVE_TEMPLATE_KEY_PREVIOUS`. The key itself is never an argument.
- The current key is resolved like the server does: `templateKey` from the environment or the config file, else `<data-dir>/admin/template.key`. `rekey` never creates a key, and it refuses when the old and current keys are the same.
- It refuses while a server holds the data directory ([`DATA_DIR_LOCKED`](../reference/errors.md#DATA_DIR_LOCKED), exit `3`). Stop the server first.
- It prints, per template, how many files it re-encrypted, how many were already on the current key and how many failed. It is safe to run again: files already done are skipped, so a second run completes an interrupted one.

Exit codes: `0` every file is on the current key; `1` a file could not be re-encrypted, or a key is missing or invalid; `3` the data directory is in use; `64` usage error.

### `templates login`

```
browserhive templates login <name> --site <site> [--method window|vault] [--timeout <duration>] [--letAgentsContinue] [--json]
```

Signs a template in to one of its sites again ([Signing in again](templates.md#signing-in-again)).

| Flag | Meaning |
|---|---|
| `--site` | The site, one of the template's. Required. |
| `--method` | `window` (default): a window opens at the site **on the machine running the server**, and you sign in there. `vault`: BrowserHive fills the vault login linked to the site, in the background ([auto-relogin](vault.md#signing-template-sites-in-again)). |
| `--timeout` | How long the command waits, default `30m` (the window's own limit). At the timeout it cancels the re-login. |
| `--letAgentsContinue` | Do not pause the template's agents while the window is open ([Agents wait while you sign in](templates.md#agents-wait-while-you-sign-in)). |

What it does with a window:

1. Starts the re-login and says where the window opened, whether the template's agents are paused, and when the window closes. When `--url` points at another machine, it warns that the window opens there.
2. Waits, reading the re-login every 2 seconds. BrowserHive checks the site's sign-in cookies every 5 seconds, so a site whose sign-in cookies come back finishes by itself.
3. **Enter** sends **I'm signed in**. When no new cookie appeared on the site yet, it says so and keeps waiting: finish signing in and press Enter again.
4. When the site is signed in, it prints the version saved and any unlisted sign-ins (`Also signed in to: … — agents can use this`), with the REST call that removes each one.

With `--method vault` it says that the fill runs and waits for it; Enter does nothing. `--timeout` and Ctrl+C cancel the re-login, which closes its window, so agents continue. With `--json` it prints the finished re-login (`{session_id, relogin}`) and nothing else on stdout.

Exit codes: `0` the site is signed in again; `1` failure (server unreachable, an API error printed as `[CODE] message`, a site the template does not have, or Ctrl+C); `2` the re-login failed, timed out or was cancelled (also at `--timeout`); `64` usage error.

### `templates probe`

```
browserhive templates probe <name> [--site <site>] [--json]
```

Checks now whether the template's enabled sites (or only `--site`) are signed in ([Health checks](templates.md#health-checks)), starting the template's browser when it is stopped, and prints one line per site with the result and its reason:

```
Checking the sites of job-hunt…
linkedin.com  ✓ signed in  every sign-in cookie is there (learned_cookies)  38 ms
indeed.com    ✗ signed out  no sign-in cookie is left (cookies_absent)  41 ms

Sign in to indeed.com again: browserhive templates login job-hunt --site indeed.com
```

The server waits at most 2 minutes for the checks. `--json` prints `{results: [{site_id, outcome, reason, duration_ms}]}`.

Exit codes: `0` every checked site is signed in; `1` failure; `2` a site is signed out or BrowserHive couldn't tell; `64` usage error.

## `sitepacks`

Review, approve and manage [site packs](site-packs.md) on a running server started with `--admin`. Like `templates`, these commands use the REST API: `--url` defaults to the configured host and port, and `--token` (an operator API token with `sitepacks:read`, and `sitepacks:write` for changes) or `--cookie` authenticates. `--json` prints the API's answer. The exception is `sitepacks verify`, which works offline. `<pack>` is a pack id: the registrable domain the pack is for, such as `linkedin.com`.

| Command | Meaning |
|---|---|
| `sitepacks list [--source <local,registry,bundled,import>] [--pending] [--json]` | Every pack: the approved version (or "not approved (v3 offered)"), its source, the local file's state (approved, changed since approval — review, not yet approved), pending versions (or "pinned at v3, v4 available"), the follow setting, how many templates use it and whether it is enabled. Under the table: packs that were skipped and why, and the local folder. `--source` takes one or more sources, comma-separated. `--pending` lists only packs with something waiting for you. |
| `sitepacks show <pack> [--json]` | One pack: its domains, the approved version with its provenance ("bundled with BrowserHive 0.3.1", a local file's path), who approved it and when, its SHA-256, the version on offer, the previous version, the local file, pending versions, the follow setting, the templates using it, the write policy and the site's terms, its rule counts, what was verified and when, and every version it knows. |
| `sitepacks diff <pack> [--to <version\|local>] [--json]` | The field-by-field difference from the approved version to a pending version, or to the local file (`--to local`): one line per changed field with its old and new value, and any domain the candidate adds. Without `--to`, the only candidate; an error when there are several or none. |
| `sitepacks apply <pack> [version] [--yes]` | Approve a pending version (below). Without `version`, the only pending version. The version is an argument: `--version` after a `sitepacks` subcommand is a usage error (it would print BrowserHive's version). |
| `sitepacks reject <pack> [version]` | Dismiss a pending version; a newer one is offered again. Without `version`, the only pending version. |
| `sitepacks revert <pack> [--yes]` | Go back to the previous approved version (below). |
| `sitepacks pin <pack> <version>`, `sitepacks unpin <pack>` | Keep the approved version; newer ones are listed but not offered. |
| `sitepacks follow <pack> on\|off\|auto` | Whether the pack lists pending updates and notifies about them. `auto`: while a template uses it. |
| `sitepacks approve-local <pack> [--yes]` | Approve the current content of the pack's local file (below). |
| `sitepacks enable <pack>`, `sitepacks disable <pack> [--yes]` | A disabled pack applies nowhere: its guards stop applying for every template and its sites are generic sites. `disable` says what stops applying and asks for confirmation (below). |
| `sitepacks reload` | Read the bundled packs and the local folder (`sitePacksDir`) again, and print per source how many loaded and which were skipped and why. |
| `sitepacks import <file>` | Send one pack file (at most 1 MiB) to the server, byte for byte, which stores it in the local folder as `<pack id>.json` and prints its SHA-256: the same one `sitepacks verify` prints for the file. It applies only after `approve-local`. A signed layout (a folder with `keys.json`, `index.json` and `packs/`) is refused: signed layouts arrive with a later release. |
| `sitepacks verify <file>` | Check a pack file offline, without a server: the schema and every rule of [Why a bad pack can do little harm](site-packs.md#why-a-bad-pack-can-do-little-harm), each problem with its field. |

**Confirmations.** `apply`, `revert`, `approve-local` and `disable` change what every template using the pack does, so on a terminal they say what will happen and ask you to type the pack id. Without a terminal they refuse unless `--yes`. `apply` and `approve-local` print the difference first; `approve-local` then prints the file's path and the SHA-256 of the content whose difference it printed, and approves exactly that content: when the file changed in between, the command or the server refuses (`409 CONFLICT`) and you run it again to review the new content.

**Pack text on the terminal.** Every string the commands print from a pack or a server answer has its control characters (escape sequences) and Unicode bidi and format characters replaced by `�`, also in `--json` output, so a pack cannot recolour, hide or reorder what you review.

Exit codes: `0` done; `1` failure (server unreachable, an API error printed as `[CODE] message`, no pending version or several, a refused confirmation, a file that cannot be used); `2` `list --pending` found a pending update of a followed pack or a local file waiting for approval; `64` usage error.

## `version`

```
browserhive 0.3.0 (bun 1.4.2, sqlite 3.53.2, patchright 1.63.0)
```

`--json` for scripts.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or clean shutdown after a signal. |
| `1` | Fatal runtime error (a boot phase failed after configuration, storage corruption, `purge` or `doctor` failure). |
| `2` | `doctor` found warnings only; `templates create` finished with a site not signed in, or timed out; `templates seed` (or `create --fromState`) left a site signed out or needing a check; `templates login` did not sign the site in (failed, timed out or cancelled); `templates probe` found a site not signed in; `sitepacks list --pending` found something waiting for your approval. |
| `3` | Policy refusal at startup: [`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED), [`ADMIN_REQUIRES_HTTP`](../reference/errors.md#ADMIN_REQUIRES_HTTP), [`BLOCKLIST_LOAD_FAILED`](../reference/errors.md#BLOCKLIST_LOAD_FAILED), [`PORT_IN_USE`](../reference/errors.md#PORT_IN_USE), [`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY), [`SANDBOX_UNAVAILABLE`](../reference/errors.md#SANDBOX_UNAVAILABLE) (`--sandbox on`). Also a command that needs the server stopped while it runs, such as `templates rekey` ([`DATA_DIR_LOCKED`](../reference/errors.md#DATA_DIR_LOCKED)). Printed as `[CODE] message`. |
| `64` | Usage error: unknown flag or key, invalid value, conflicting settings, missing argument. |
| `130` | A second interrupt arrived before graceful shutdown finished. |
