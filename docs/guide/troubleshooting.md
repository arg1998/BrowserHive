# Troubleshooting

Start with:

```bash
browserhive doctor
```

It prints a ✓ or ✗ per check and the fix for each ✗. Every error code, its cause and resolution is in the [error reference](../reference/errors.md).

## Startup

**[`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED)**
Run `browserhive init`. If you keep browsers elsewhere, set `PLAYWRIGHT_BROWSERS_PATH` the same way for `init` and the server. With `--stealthDriver patchright`, Patchright's Chromium must be installed too. For `--defaultChannel chrome` (or a session asking for `channel: "chrome"`), install Google Chrome: `browserhive init --installChrome`. BrowserHive never falls back to another browser when the one asked for is missing.

**[`SANDBOX_UNAVAILABLE`](../reference/errors.md#SANDBOX_UNAVAILABLE)** at startup (exit code 3)
You set `--sandbox on` and the configured browser cannot run inside Chromium's sandbox on this machine. The message below the first line names the browser, Chrome's own reason, the cause on your OS, and what you can do, easiest first. On Ubuntu 23.10 and later that is usually: use the installed Google Chrome (`--defaultChannel chrome`), or give the bundled browser an AppArmor profile with `browserhive doctor --printApparmorProfile`. See [Security: the browser sandbox](security.md#the-browser-sandbox). `--sandbox auto` (the default) sandboxes where possible and never refuses to start.

**[`PORT_IN_USE`](../reference/errors.md#PORT_IN_USE)**
Another process holds the port, often a BrowserHive you started earlier. Find it with `lsof -i :9876` (macOS, Linux) or `netstat -ano | findstr 9876` (Windows), or use `--port`.

**[`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED)**
You bound a non-loopback host without authentication. Add `--auth token`, or `--allowInsecureBind` on a network you control. See [Security](security.md).

**[`ADMIN_REQUIRES_HTTP`](../reference/errors.md#ADMIN_REQUIRES_HTTP)**
The dashboard is not available under `--transport stdio`. Run the HTTP transport.

**[`CONFIG_INVALID`](../reference/errors.md#CONFIG_INVALID) or [`CONFIG_UNKNOWN_KEY`](../reference/errors.md#CONFIG_UNKNOWN_KEY)**
The message names the key, the source it came from (flag, environment variable or file and key) and the accepted values. Common causes: a kebab-case flag, a leftover `BROWSERHIVE_*` variable in your shell, an empty value, or a boolean written as `--admin false` instead of `--admin=false`. `browserhive config validate` reproduces the check, and `browserhive config show` shows which source won.

**`… references {env:NAME}, but NAME is not set`**
A value in `browserhive.config.json` reads an environment variable that the server's environment does not have. Export it in the shell or service that starts BrowserHive (a systemd `Environment=` line, `docker run -e`), or give the reference a default: `{env:NAME:-value}`. `unknown reference scheme` means text such as `{file:…}` or `{ENV:NAME}` looked like a reference; write `{{…}}` to keep it literal. See [References](configuration.md#references).

**[`BLOCKLIST_LOAD_FAILED`](../reference/errors.md#BLOCKLIST_LOAD_FAILED)**
The `--blocklist` file is missing or unreadable. A configured blocklist that cannot be read is fatal on purpose.

**[`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY)**
The database was written by a newer BrowserHive. Upgrade again, or restore the pre-upgrade backup: see [Upgrading](upgrading.md#downgrade).

**[`MIGRATION_FAILED`](../reference/errors.md#MIGRATION_FAILED), [`DB_CORRUPT`](../reference/errors.md#DB_CORRUPT)**
Nothing was changed; a backup exists in `<data-dir>/backups/`. Run `browserhive db status`, and open an issue with the output.

**[`DATA_DIR_UNWRITABLE`](../reference/errors.md#DATA_DIR_UNWRITABLE)**
Fix ownership of the data directory, or point `--dataDir` somewhere you own.

## Sessions and tools

**[`SANDBOX_UNAVAILABLE`](../reference/errors.md#SANDBOX_UNAVAILABLE)** from `launch_session`
The sandbox was required for this session (the server runs with `--sandbox on`, or the agent passed `launch_options: { chromiumSandbox: true }`) and this browser cannot provide it here. Retrying does not help. The message names the channels that do sandbox on this machine; otherwise drop `chromiumSandbox` or ask the operator to run `browserhive doctor`.

**`doctor` says "cannot run sandboxed here, falls back to no sandbox"**
Under the default `--sandbox auto`, that browser runs without Chromium's sandbox on this machine (typical on Ubuntu 23.10+ with the bundled browser, as root, or in Docker). Sessions work; the guidance under the table says how to get the sandbox. The log says `sandbox fell back` once per browser.

**A managed policy blocks automation**
`doctor` reports policies such as `RemoteDebuggingAllowed=false` set by your organisation for Chrome or Edge. BrowserHive cannot drive that browser; use the bundled Chromium (`--defaultChannel chromium`) or ask your administrator.

**[`SESSION_LIMIT_REACHED`](../reference/errors.md#SESSION_LIMIT_REACHED)**
The cap is derived from RAM by default. Close idle sessions, shorten `--sessionLease`, or raise `--maxSessions` if the host can take it.

**Sessions disappear**
Idle sessions are closed after `--sessionLease` (default `2h`). The dashboard's session list shows the lease countdown and the closed reason.

**[`URL_BLOCKED`](../reference/errors.md#URL_BLOCKED)**
The operator's blocklist matched. The Blocklist page shows which pattern.

**[`EVALUATE_DISABLED`](../reference/errors.md#EVALUATE_DISABLED)**
`--allowEvaluate false` on the server, or `disable_evaluate: true` on the session.

**Elements not found or not actionable**
Use `snapshot` to see the page as the agent does, `wait_for_selector` before interacting, and check the tool call's screenshot on the session's Timeline tab.

**Sites detect automation**
Check the session's Identity tab. Make sure `browserhive init` installed Patchright and `--stealth` is not `off`. Read the [stealth ceilings](stealth.md#ceilings); some checks need [human takeover](attention.md).

## Vault

**[`VAULT_LOCKED`](../reference/errors.md#VAULT_LOCKED)** — paste a session token from `bw unlock --raw` on the dashboard's Vault page, or start the server with `BW_SESSION` exported.

**[`VAULT_UNLOCK_FAILED`](../reference/errors.md#VAULT_UNLOCK_FAILED)** — the pasted session token was rejected by `bw status`. It expires on `bw lock` or `bw logout`, and only works for the `bw` login of the user running BrowserHive. Run `bw unlock --raw` again and paste the new token.

**[`VAULT_BACKEND_ERROR`](../reference/errors.md#VAULT_BACKEND_ERROR)** — `bw` is missing, timed out, or failed. Run `bw status` in the same environment as the server.

**`vault_fill` returns `blocked` / `not_authorized`** — the entry has no binding for this session slug or principal, or its folder is `reject_all`. Use the origin tester on the Vault page.

**`origin_mismatch`** — the page is not on the binding's allowed origins. Remember that `github.com` does not match `gist.github.com`; use `*.github.com`.

## Dashboard

**"offline" or back at the login page** — the server restarted or your session expired (15 minutes idle, 8 hours total). Sign in again.

**"reconnecting…" for more than a minute** — the server is down or unreachable.

**Forgot the password** — stop the server and run `browserhive admin reset-password`.

**Live view is black or says "Screencast failed"** — the session is closed or crashed, or the screencast could not start; the panel shows the code.

**Takeover input is ignored** — input is only accepted while an attention request is open for that session ([`INPUT_NOT_PERMITTED`](../reference/errors.md#INPUT_NOT_PERMITTED)).

## MCP clients

**401 on `/mcp`** — `--auth token` is on and the client sent no token or a revoked one. See [MCP clients](mcp-clients.md#authentication-tokens).

**stdio client hangs or reports invalid JSON** — something is writing to stdout. BrowserHive never does under stdio; check wrapper scripts. Use absolute paths to `bun` and `browserhive` in desktop apps that do not inherit your shell's `PATH`.

**`request_attention` returns `ATTENTION_REQUIRES_HTTP`** — you are on stdio. Use the HTTP transport with `--admin`.

## Logs

- `--logLevel debug`, or per module: `--logLevel info,sessions=debug`. You can also change the level at runtime from the System page.
- `--logFormat json` for log collectors; JSON logs go to stderr.
- The dashboard's Logs page tails the last 5,000 records with filters.
