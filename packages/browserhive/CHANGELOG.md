# browserhive

## 0.2.0

### Minor Changes

- [#17](https://github.com/arg1998/BrowserHive/pull/17) [`a4b5b8a`](https://github.com/arg1998/BrowserHive/commit/a4b5b8a83c785b7fdba29a003325de90a49e1b95) Thanks [@arg1998](https://github.com/arg1998)! - Choose which browser sessions use, and run it inside Chromium's sandbox.

  - **Sessions run inside Chromium's sandbox wherever your machine allows it.** The new `--sandbox` setting (`BROWSERHIVE_SANDBOX`) defaults to `auto`: each browser is tried with the sandbox on its first launch and keeps it where it works (macOS, Windows, most Linux, and Google Chrome on Ubuntu). Where it cannot (Ubuntu 23.10+ with the bundled browser, running as root, Docker), sessions run as before, with one warning in the log, and `browserhive doctor` explains why with the fix for your machine. `--sandbox off` is exactly the old behaviour.
  - **`--sandbox on` makes the sandbox a guarantee.** The server checks the configured browser before it opens its port and refuses to start (exit code 3) when it cannot sandbox, printing the reason and what to do on your machine, easiest first: an installed browser that does sandbox, an AppArmor profile, running as a normal user, or `--sandbox auto`.
  - **A sandbox the machine cannot provide is now a clear error.** `launch_session` with `launch_options: { chromiumSandbox: true }` on such a host used to answer `INTERNAL_ERROR` with "retry with backoff"; it now answers `SANDBOX_UNAVAILABLE`, "retrying will not help", with the channels that do work.
  - **`browserhive init` shows the browsers on your machine and lets you pick one.** It lists the bundled Chromium, an installed Google Chrome or Microsoft Edge, whether each can run sandboxed, and the pros and cons of each for your system. Enter keeps the current choice; a new choice is saved to your config file after you confirm. It can also install Google Chrome for you (Google's installer, administrator rights). In scripts: `--channel chrome --yes`, `--installChrome`; nothing is asked without a terminal.
  - **`browserhive doctor` checks the browser you configured.** A `defaultChannel=chrome` without Chrome installed is now a failure instead of a green check. New checks: installed Chrome and Edge, a browser that has moved more than one major version ahead of the tested build, managed policies that block automation, the sandbox per browser with the fix for your OS, and running as root or in a container. `doctor --printApparmorProfile` prints (never installs) the profile that lets the bundled browser sandbox on Ubuntu.
  - **The dashboard shows browsers and the sandbox.** The System page lists the browsers found, their versions and whether each runs sandboxed; a session's Details tab shows its browser version and sandbox state.
  - A missing Google Chrome now names the command that installs it (`browserhive init --installChrome`), and `--no-sandbox` suggests `--sandbox`.

- [#20](https://github.com/arg1998/BrowserHive/pull/20) [`15871c2`](https://github.com/arg1998/BrowserHive/commit/15871c22d16732cb18058aebac0fadcbbcb68597) Thanks [@arg1998](https://github.com/arg1998)! - Read environment variables in `browserhive.config.json`, and see which variable every value came from.

  - **Keep secrets out of the config file.** A string in `browserhive.config.json` can now contain `{env:NAME}`, and BrowserHive reads that environment variable when it starts: `"authTokens": "ci-runner:{env:CI_TOKEN}"`, `"otelHeaders": { "Authorization": "Bearer {env:OTLP_TOKEN}" }`, `"otelEndpoint": "http://{env:OTLP_HOST}:4318"`. The file can be committed and shared while tokens and per-machine values stay in the environment. It works for every key, in whole values, inside longer strings, in lists and in header maps; `"maxSessions": "{env:MAX_SESSIONS}"` accepts exactly what `BROWSERHIVE_MAX_SESSIONS` would.
  - **Defaults for one file everywhere.** `{env:NAME:-default}` uses `default` when `NAME` is not set or is empty, so the same file works on a laptop and on a server. `{env:NAME}` without a default is required: if the variable is missing, startup stops and says which key, which file and which variable, and how to add a default.
  - **Every place shows where a value came from.** The startup log reads `config: otelEndpoint=… (config-file via $OTLP_HOST) shadows env=…`, `browserhive config show` prints `config-file via $OTLP_HOST` in the SOURCE column, `config show --json` and `GET /api/v1/system/config` add `refs` and `template` fields, and the dashboard's System page shows a `$OTLP_HOST` chip next to the source. Select it to see the value as written in the file; a new **Only values from references** switch lists just those keys.
  - **Secrets stay hidden.** For `authTokens`, `otelHeaders`, and any value whose variable name looks like a credential (it contains `token`, `secret`, `password` and the like), you see the variable's name, never its value, and the value is scrubbed from logs. `browserhive doctor` no longer asks you to `chmod 600` a config file whose `authTokens` only reference variables, and it warns when a variable was not set so its default is in use.
  - **Mistakes are caught, not ignored.** `${env:NAME}` (the OpenTelemetry Collector's spelling) stops startup with "Did you mean '{env:NAME}'?"; `{ENV:NAME}` or `{file:…}` stop it too, with how to keep such text literal (`{{…}}`). Braces that are not references, like `{trace_id}` in `otelTraceUrlTemplate`, are left alone, so existing config files work as before. References are not expanded in `BROWSERHIVE_*` variables or command-line flags (your shell does that); BrowserHive warns if it finds one there.
  - The JSON Schema for the config file (`browserhive config schema`) accepts a reference for every key, so editors no longer underline `"stealth": "{env:STEALTH}"`.

- [#21](https://github.com/arg1998/BrowserHive/pull/21) [`43d2f5e`](https://github.com/arg1998/BrowserHive/commit/43d2f5e8a061d52905886c15c784233c1cd2f6c2) Thanks [@arg1998](https://github.com/arg1998)! - See which agent is connected (Claude Code, Codex, Cursor, OpenCode, Gemini CLI and others), count sessions and tool calls per agent, and filter by it.

  - **Recognised with nothing to configure.** Claude Code and Gemini CLI over stdio, and Claude Code, Codex, OpenCode, Cursor, VS Code, Cline, Continue and Zed over HTTP, are recognised from what they already send. Anything BrowserHive can't place is shown as **Unknown**, which is counted and filterable like any other agent, never an empty cell.
  - **Name any agent in one line.** Add an `X-BH-Agent-Harness` header, a `BROWSERHIVE_HARNESS` variable in a stdio server's `env` block, or `?harness=<name>` to the MCP URL when a client only has a URL field. `X-BH-Agent-Model` / `BROWSERHIVE_MODEL` and `X-BH-Workspace` / `BROWSERHIVE_WORKSPACE` label the model and the workspace; `X-BH-Meta-<Name>` headers add a few extra labels. Tool calls can carry the same in `_meta` (`ai.browserhive/harness`, `ai.browserhive/model`, `ai.browserhive/workspace`), read on every call.
  - **In the dashboard.** The sessions list has a Harness filter and an Agent column; a session's Details tab has a Client panel (the agent and how it was recognised, the model or "not reported", the workspace, the client's name, version and protocol); the Overview has a Harnesses card with sessions and tool calls per agent; the System page lists live and recent MCP connections, with the User-Agent, IP, conflicting signals and extra labels of each. A tool call's details show which agent made it.
  - **In the API and telemetry.** `GET /api/v1/sessions` accepts `harness=` and returns a `harnesses` facet, each session has a `harness`, tool calls carry `harness` (and `GET /api/v1/tool-calls` filters by it), and there are two new endpoints: `GET /api/v1/metrics/harnesses` and `GET /api/v1/system/mcp/connections`. Traces carry `browserhive.harness` (and the declared model); the tool-call and live-session metrics gain a `harness` attribute limited to known names plus `other` and `unknown`.
  - **Reported, not verified.** All of this is what the client or your own configuration says. BrowserHive shows it faithfully and never uses it to allow or refuse anything. MCP gives a server no way to learn the model, so a model is shown only when one is declared.
  - Existing sessions and databases keep working: the database upgrades on start (schema v3), sessions from before read Unknown, and every field that was there before is still there. `BROWSERHIVE_HARNESS`, `BROWSERHIVE_MODEL` and `BROWSERHIVE_WORKSPACE` are not configuration settings, so they are no longer rejected as unknown, and a misspelled one gets a suggestion.

- [#28](https://github.com/arg1998/BrowserHive/pull/28) [`9470feb`](https://github.com/arg1998/BrowserHive/commit/9470feb26f740a6cf9c2cf009c3124241d737fc5) Thanks [@arg1998](https://github.com/arg1998)! - Answer from your phone: Approve, Reject and Mark resolved right in Telegram, Discord and ntfy, and richer Telegram messages.

  - **Answer without opening the dashboard.** Switch on **Answer from the chat** for a channel, and a notification that waits for you carries buttons that act: **Mark resolved** and **Reject** for an attention request, **Approve** and **Deny** for a vault fill. Press one and BrowserHive does what the same button in the dashboard does, then edits the message: the buttons disappear and it says who answered ("Resolved on Telegram by … after 42 s"). Off by default.
  - **Only the right person, only once.** On Telegram and Discord only the accounts on the channel's allow-list may press; by default that is the person who connected the chat, and anyone else is told their id so you can add them. Every button works once, for 24 hours, only in its own chat, and only while the request still waits. Every press is listed under the new **Notifications → Actions**. The agent learns that you answered from Telegram, Discord or ntfy, never your chat identity.
  - **Discord bot mode.** A Discord channel can now use a bot instead of a webhook, the only way to press buttons in Discord. The wizard walks through the Developer Portal, builds the invite link with the minimal permissions, lists your servers and channels, and links your account with a **This is me** button. The channel card shows whether the bot is connected.
  - **ntfy answers through a second topic.** Give an ntfy channel a reply topic, and its buttons make your phone post the answer there; BrowserHive listens and updates the notification. Works on Android and iOS.
  - **Nothing to expose.** Every connection goes out from your machine (Telegram long polling, the Discord gateway, an ntfy subscription). Presses made while BrowserHive was stopped are handled at the next start when the platform kept them. The webhook channel carries the act actions as they are, and your receiver answers through the REST API.
  - **Telegram Rich Messages.** Telegram notifications now have a heading, the facts as a table, real tables, collapsible quotes and coloured buttons, with the screenshot inside the message. If Telegram refuses one, the classic format is sent instead.
  - **Setup and terminal.** Startup channels take `actButtons=true` and `allow=<user ids>`, `mode=bot` for Discord and `reply=` for ntfy. `browserhive channels list` shows whether answers reach BrowserHive.
  - New REST endpoints: `GET /api/v1/channels/actions` and the Discord bot setup under `/api/v1/channels/discord/…`; channels report `connection`; the `channels` WebSocket topic adds `action.recorded`. The database moves to schema v6 (three new tables; an older release still opens it).

- [#27](https://github.com/arg1998/BrowserHive/pull/27) [`fb94fbc`](https://github.com/arg1998/BrowserHive/commit/fb94fbcfcc3aadb310a933d0d4cfa02217491e63) Thanks [@arg1998](https://github.com/arg1998)! - Notifications on your phone: Telegram, Discord, ntfy and webhook channels, with screenshots, live updates and messages that delete themselves.

  - **Get a message when an agent needs you.** Add a channel under **Notifications → Channels**: a Telegram bot (one-tap connect, no chat id to look up), a Discord webhook, an ntfy topic (scan a QR code with the ntfy app) or a webhook of your own. A wizard shows the exact line to set the token for how you run BrowserHive, checks that it is set, previews the message exactly as it will look, and sends a test. Presets pick what to send (_Needs me now_, _Problems_, _Wrap-ups_); **Advanced** adds minimum severity, session patterns, harness, quiet hours with a time zone and the content level.
  - **Messages keep up.** When you resolve an attention request, the chat message is edited in place, silently, and its buttons disappear; a growing group of tool errors updates its count. Every send, edit and delete is in the new **Delivery log**, live, with a sentence for anything that was not sent ("quiet hours", "the platform refused the token").
  - **Screenshots, when you want them.** Off by default, per channel and category: the page when an agent asked for help (CAPTCHAs included), the login page before a vault fill (never during one), a crashed session's last frame. Form fields can be masked.
  - **Self-destruct.** Delete messages after a time you choose per category, or once they are resolved. Telegram only allows 48 hours, so its timers stop at 47.
  - **Links that open on your phone.** The new `publicUrl` key (`--publicUrl`, `BROWSERHIVE_PUBLIC_URL`) is the address where you reach the dashboard (a Tailscale name, your reverse proxy, a Cloudflare tunnel). Notification links use it, its host is trusted without `allowedHosts`, and the CSRF check accepts it even when your proxy rewrites `Host`. The System page and `browserhive doctor` check that it really reaches this BrowserHive.
  - **Your accounts, your tokens.** BrowserHive runs no servers or shared bots. Tokens stay in environment variables; channels store only the variable names, so a database backup never contains one.
  - **For servers and containers**, declare channels at startup with `--notificationChannel "telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456"` (repeatable; a token typed into the flag is refused). They show in the dashboard with a "from startup" badge.
  - **From a terminal:** `browserhive channels list`, `channels test <name>` and `channels preview <name>`; `browserhive doctor` checks every channel's variables and `publicUrl`.
  - New REST endpoints under `/api/v1/channels` (scopes `channels:read`, `channels:write`), `GET /api/v1/system/public-url`, a `channels` WebSocket topic, and `instance_id` in `GET /health`.

- [#25](https://github.com/arg1998/BrowserHive/pull/25) [`9fce259`](https://github.com/arg1998/BrowserHive/commit/9fce259c7e059faa35bed49540be5094927c4f3d) Thanks [@arg1998](https://github.com/arg1998)! - Notifications now follow what they announce, and every notification is a versioned message that can be delivered reliably to other apps.

  - **A notification keeps its place as things change.** When you resolve an attention request or a vault confirmation, reject it, or it times out, its notification shows the outcome (**resolved**, **expired**) as a small pill in the bell and on the Notifications page, instead of staying as if it were still waiting. A toast still on screen for it closes. A recovered subsystem marks its degradation notification resolved the same way.
  - **Richer notification data in the API.** `GET /api/v1/notifications` and the `notifications` WebSocket topic add `kind`, `category`, `severity`, `state`, `revision` and `thread` to every notification. Existing fields are unchanged.
  - **Safer text.** An agent's attention reason and other text copied into a notification now go through the same redaction as the logs, and page addresses lose their query strings.
  - **Built for delivery to your phone.** Every notification is also a versioned message document, whose JSON Schema is published in the reference docs (the webhook channel sends it as is). Delivery to Telegram, Discord, ntfy and webhooks goes through a new outbox in the database, with retries and a circuit breaker, so nothing is lost when a service is down. With no channel configured nothing extra runs.
  - The database upgrades on start (schema v5: new columns on notifications and three new tables; a backup is written first). Older releases can still open it. Existing notifications are classified from what they already recorded; nothing is invented for them.

- [#29](https://github.com/arg1998/BrowserHive/pull/29) [`7873a06`](https://github.com/arg1998/BrowserHive/commit/7873a06679d4aae924a447779e5ad2cd423d0a56) Thanks [@arg1998](https://github.com/arg1998)! - A daily summary and a heads-up when something's off.

  - **Daily or weekly digest.** Give a channel a digest (every day at 09:00, optionally weekdays only with Monday covering the weekend, or every week on Friday at 17:00; day and time are yours to change) and it gets the period in numbers: sessions, tool calls and errors with the rate, attention requests and how fast they were answered, vault fills, blocked requests, the slowest tool against the period before, the top errors, open problems, a small chart of tool calls per hour and a table per harness, with a link to the Overview for exactly that period. The new **Daily digest** preset sets it up in one click.
  - **In your time zone.** Each channel has a time zone, BrowserHive's own unless you pick another, and digests and quiet hours follow it through daylight saving time.
  - **Nothing lost, nothing spammed.** If BrowserHive was off when a digest was due, the most recent one arrives when it starts again, marked late, with how many earlier ones were skipped. A day with no activity sends nothing (the delivery log says so). A digest due in quiet hours arrives silently.
  - **Tell me when something looks off.** An hourly check that stays silent until a threshold is crossed: many tool calls failing, a request waiting too long, sessions at the limit, a spike in blocked requests, BrowserHive degraded. The alert updates itself and says **Back to normal** when things recover, without flapping. Thresholds can be tuned per channel.
  - **Reports in BrowserHive.** Every digest and anomaly alert also lands in the dashboard once per period, however many channels it reached: in the bell and the inbox (a new **Reports** filter), quietly for digests (no pop-up, no badge) and like a System notification for anomaly alerts. The new **Notifications → Reports** tab keeps them for 90 days, even after you dismiss them, with filters and a page per report (its numbers, chart and tables, the channels it reached, and Open Overview for this period). It can also run a digest and anomaly alerts for the dashboard alone, with no channel at all.
  - **Send a digest now.** Preview the real digest exactly as your phone will show it, then send it on demand, from the channel card or `POST /api/v1/channels/{id}/digest`.
  - **Setup and terminal.** Startup channels take `digest=daily@09:00`, `digest=daily:weekdays` or `digest=weekly` (Friday 17:00; `weekly:mon@08:30` for another day), `tz=` and `anomaly=on` with `anomaly.*` thresholds; `browserhive channels list` shows each channel's next digest, and `channels preview --sample digest|anomaly` renders the samples.
  - **Also:** the Allow this person button explains when you lack `channels:write`, a deleted channel's reply-topic cursor goes with it, the live delivery log no longer shows stale superseded rows, and the public address check reports a proxy's 5xx page as unreachable. The message contract gains the `digest.weekly` kind, a `chart` block and an optional `report` field (schema 1, additive); `GET /api/v1/notifications` takes a `category` filter; new `GET /api/v1/notifications/reports`, `GET /api/v1/notifications/reports/{id}` and `GET`/`PUT /api/v1/notifications/report-settings`; no database migration.

- [#24](https://github.com/arg1998/BrowserHive/pull/24) [`6c90ade`](https://github.com/arg1998/BrowserHive/commit/6c90adef085a166c2b72cf0a54023bed842f8aeb) Thanks [@arg1998](https://github.com/arg1998)! - Closed sessions now keep showing whether they ran inside Chromium's sandbox, and with which browser version.

  - **Recorded at launch.** When a session's browser starts, BrowserHive stores whether it runs sandboxed and the browser's real version with the session. Under the default `--sandbox auto` the answer depends on the browser and the machine (on Ubuntu, Google Chrome sandboxes and the bundled Chromium falls back), so it is recorded rather than worked out later.
  - **In the dashboard.** A session's Details tab shows the browser version and a **sandboxed** / **not sandboxed** state for finished sessions too, not only while they run. Sessions from before this release show **not recorded**, with a note that this does not mean the sandbox was off; a session whose browser never started shows **not launched**.
  - **In the API.** `browser: { version, sandboxed }` on `GET /api/v1/sessions` and `GET /api/v1/sessions/{id}` is now filled for closed sessions from what was recorded at launch. It is still left out when nothing was recorded, so read a missing `browser` as "unknown", never as "not sandboxed".
  - The database upgrades on start (schema v4, two new columns, a backup is written first); older releases can still open it. Nothing is guessed for existing sessions.

### Patch Changes

- [#22](https://github.com/arg1998/BrowserHive/pull/22) [`a7a79d8`](https://github.com/arg1998/BrowserHive/commit/a7a79d8ecf93c76950ede4d56f36a609222aebf1) Thanks [@arg1998](https://github.com/arg1998)! - The System page's **MCP connections** list now shows 10 connections per page, with the usual pager underneath (10, 25 or 50 rows per page, previous/next, "1–10 of 23"). Before, it showed up to 50 at once with no way to see older ones. For API clients, `GET /api/v1/system/mcp/connections` accepts an `offset` for paging and returns `total`, the number of stored connections; existing calls behave exactly as before.

- [#33](https://github.com/arg1998/BrowserHive/pull/33) [`f4ebe1a`](https://github.com/arg1998/BrowserHive/commit/f4ebe1ad68e7bab526f9c7b81d9574d0d0aa37e0) Thanks [@arg1998](https://github.com/arg1998)! - OpenTelemetry now exports the notification, attention, session-launch, WebSocket, write-queue and browser-memory metrics the docs describe.

  - **Metrics that were documented but never sent** now reach your collector: `browserhive.attention.wait`, `browserhive.session.launch.duration`, `browserhive.ws.connections`, `browserhive.ws.buffered_bytes`, `browserhive.ws.frames_dropped`, `browserhive.db.dropped_writes`, `browserhive.browser.rss_bytes` (each session's browser with all its processes, every 10 seconds; Linux and macOS) and `browserhive.process.event_loop_lag`.
  - **Attributes the docs promised** are now set: `closed_reason` on `browserhive.session.lifetime`, `kind` on `browserhive.attention.open` (vault confirmations count too), `table` on `browserhive.retention.pruned_rows`.
  - **The notification metrics** `browserhive.notifications.deliveries`, `.actions` and `.reports` are now in the [telemetry guide](https://browserhive.ai/docs/guide/telemetry). `.reports` now counts on-demand digests as `manual`, as documented, and no longer counts a silent revision of an open in-app anomaly alert.
  - **Gauges only report what exists**: a closed session's browser memory or a closed WebSocket's buffered bytes disappears from the next export instead of repeating its last value. `browserhive.db.dropped_writes` reports every recorder table from the start, at 0.
  - **Every metric has a unit** (`ms`, `By`, or a count such as `{call}`), and the guide's table lists each one with its type, unit and attributes. With telemetry off nothing is measured, as before.

- [#15](https://github.com/arg1998/BrowserHive/pull/15) [`280ec1f`](https://github.com/arg1998/BrowserHive/commit/280ec1f68e42f839afb248380e51020f368d9f73) Thanks [@arg1998](https://github.com/arg1998)! - Fixes found while researching the next features.

  - **MCP works behind a port mapping or SSH tunnel.** `/mcp` rejected every request whose `Host` named a different port (`localhost:8080` for a server on 9876) while the dashboard kept working. Both now use the same check, which ignores the port.
  - **New `--allowedHosts` setting** (`BROWSERHIVE_ALLOWED_HOSTS`) for the name a reverse proxy forwards, so the recommended TLS proxy setup works without rewriting `Host`.
  - **Session details show the MCP client that launched the session** — its name and version, plus the model and workspace when it sends `X-BH-Agent-Model` / `X-BH-Workspace`. `X-BH-Agent-Harness` no longer overwrites the workspace. Stdio connections record their client too.
  - **Saved storage states keep IndexedDB**, so sites that store their login there (Firebase Auth, among others) restore logged in.
  - **A malformed secret setting is no longer printed in the error.** `BROWSERHIVE_AUTH_TOKENS` and `otelHeaders` values from env or the config file are also scrubbed from logs and telemetry now.
  - **Takeover input is audited**: one audit row per session and second with counts only, never the keys typed.
  - **`maxSessions` respects container and systemd memory limits** instead of deriving from the host's full RAM.
  - **A data directory on a filesystem that refuses `chmod`** (network shares, some bind mounts) no longer stops the server from starting; it logs a warning.
  - **Toggling fullscreen in the live view no longer restarts the stream.**
  - Old MCP connection records are now pruned by retention.
  - A helper process (such as the Bitwarden CLI) that exits before reading its input no longer raises a spurious `UNHANDLED` degradation.

## 0.1.3

### Patch Changes

- [#13](https://github.com/arg1998/BrowserHive/pull/13) [`3752bc9`](https://github.com/arg1998/BrowserHive/commit/3752bc9ea714c5c87baaf4f84e683d5d18bb90b3) Thanks [@arg1998](https://github.com/arg1998)! - Dashboard: links to the documentation on browserhive.ai, the website and GitHub.

  - A Help menu in the top bar opens the guide for the current page, the dashboard guide, MCP client setup, troubleshooting, release notes and issue reporting.
  - The sidebar footer links to Docs, GitHub and the website, and the version links to its release notes.
  - The command palette can open the docs, the tool reference, the website and GitHub.
  - Info popovers are fixed: inline code and bold text no longer break onto their own lines. They now have paragraph spacing and a "Read the docs" link.
  - New explainers were added across Overview, Websites, Vault, Vault log, System (tokens, configuration, storage, migrations, degradations) and session details.
  - System setting hints now use the real camelCase flags (`--maxSessions`, `--allowEvaluate`, `--retentionDays`) and link to each key in the configuration reference.

## 0.1.2

### Patch Changes

- [#9](https://github.com/arg1998/BrowserHive/pull/9) [`52929f9`](https://github.com/arg1998/BrowserHive/commit/52929f9974cffee31a5213f8708ed8d6568e42d1) Thanks [@arg1998](https://github.com/arg1998)! - The npm package homepage now points at https://browserhive.ai.

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
