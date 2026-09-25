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

### Patch Changes

- [#22](https://github.com/arg1998/BrowserHive/pull/22) [`a7a79d8`](https://github.com/arg1998/BrowserHive/commit/a7a79d8ecf93c76950ede4d56f36a609222aebf1) Thanks [@arg1998](https://github.com/arg1998)! - The System page's **MCP connections** list now shows 10 connections per page, with the usual pager underneath (10, 25 or 50 rows per page, previous/next, "1–10 of 23"). Before, it showed up to 50 at once with no way to see older ones. For API clients, `GET /api/v1/system/mcp/connections` accepts an `offset` for paging and returns `total`, the number of stored connections; existing calls behave exactly as before.

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
