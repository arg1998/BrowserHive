# Troubleshooting

Start with:

```bash
browserhive doctor
```

It prints a ✓ or ✗ per check and the fix for each ✗. Every error code, its cause and resolution is in the [error reference](../reference/errors.md).

## Startup

**`bh` runs something else, or `doctor` says "is not BrowserHive's, so bh runs it"**
Another `bh` comes first on your `PATH`, or your shell has a `bh` alias or function (which `doctor` cannot see). `browserhive` always works. To make `bh` ours, rename or remove the other one, or move BrowserHive's bin directory earlier on `PATH`. `type -a bh` (bash, zsh) or `Get-Command bh -All` (PowerShell) lists every candidate. See [the `bh` shorthand](installation.md#the-bh-shorthand).

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

## The app says BrowserHive isn't running

Once you have opened the dashboard at an address, your browser keeps a small help page for it. When BrowserHive does not answer there, the installed app (or the browser tab) shows that page instead of an error. It checks again by itself (after 1 s, 2 s, then every 3 s while the window is visible) and opens the dashboard as soon as BrowserHive is ready. **Retry now** checks at once. Each command on the page has a **Copy** button. See [Install as an app](dashboard.md#install-as-an-app).

What each message means, and what to do:

| The page says | What happened | Fix |
|---|---|---|
| **BrowserHive isn't running** | Nothing listens on this port on this computer. | Start it with `browserhive --admin` (the page adds `--port` when you use another one). If it was started by an MCP client, a service manager or a container, start it the way you usually do. `browserhive doctor` checks the setup. |
| **Can't reach BrowserHive** | Nothing answered at a remote address. | Check this device's network, any tunnel or proxy in between, and that BrowserHive runs on the other machine. Run the commands there. |
| **This device is offline** | The browser reports no network. | Reconnect; the page checks again by itself. |
| **BrowserHive isn't responding** | Something accepted the connection but sent nothing back within 5 seconds. | BrowserHive is stuck or overloaded: restart it. If it still hangs, read its log (see [Logs](#logs)) and run `browserhive doctor`. |
| **BrowserHive is starting** | BrowserHive answers but is not ready yet. | Wait: the dashboard opens by itself. If it stays here, `browserhive doctor` says why. |
| **BrowserHive is unreachable behind …** | A proxy or tunnel (nginx, Caddy, Cloudflare) answered with an error because BrowserHive behind it did not. | Check that BrowserHive runs and that the proxy points at its address and port (`browserhive config show`). |
| **BrowserHive turned this request away** | BrowserHive runs, but refused the address you used (for example HTTP 421). | Allow the new name with `--allowedHosts`, set `--publicUrl`, or open the address the startup banner prints. |
| **Another program is using this address** | A different program answers on this port. | If BrowserHive moved to another port, open that address and install the app from there. Use the port commands on the page to see what holds the port. |
| **BrowserHive answers, but the dashboard didn't load** | BrowserHive is ready, but the page reloaded three times within a minute without reaching the dashboard (or the browser blocks this site's storage), so it stopped reloading by itself. | Click **Reload**. If it comes back, restart BrowserHive and check `browserhive doctor`. |

**Forget this address** removes the help page from this address: from then on the browser shows its normal error page when nothing answers. The help page comes back the next time you open the dashboard there. The page also forgets an address by itself when a different program's web page answers on it.

To remove it by hand, open the browser's developer tools, then **Application › Service workers › Unregister**, or clear the site data for the address in the browser's settings.

The page stores only BrowserHive's public page files (the help page, its script, styles and fonts), never anything you see after signing in.

## Notifications

**A notification did not reach my phone** — open **Notifications → Delivery log**: every row that was not delivered says why in a sentence (filtered by the channel's rules, quiet hours, the channel was paused, the platform refused the token, …). `browserhive channels test <name>` sends a real test message and prints the platform's answer. See [the delivery log](notifications.md#delivery-log).

**The channel shows a variable as missing, or `doctor` says it is not set** — a channel stores only the name of the environment variable that holds its token. Set it in the environment of the process that runs BrowserHive (the shell, a systemd `Environment=` line, `docker run -e`) and restart. See [Channels](notifications.md#channels).

**A channel is marked broken** — five sends in a row failed, so its deliveries paused. Fix the cause shown on the card and in the delivery log, then resume the channel.

**Links in a notification do not open on my phone** — they point at this computer until you set `publicUrl`. The System page and `browserhive doctor` check whether it reaches this BrowserHive. See [Public address](notifications.md#public-address).

**Discord buttons say "This interaction failed", or the bot is offline** — see [Troubleshooting Discord bot mode](notifications.md#troubleshooting-discord-bot-mode).

**No digest arrived** — a period with no activity sends nothing, and the delivery log says *nothing happened in the period*. If BrowserHive was off at the scheduled time, only the most recent missed digest is sent when it starts, marked late. See [Daily digests and anomaly alerts](notifications.md#daily-digests-and-anomaly-alerts).

## MCP clients

**401 on `/mcp`** — `--auth token` is on and the client sent no token or a revoked one. See [MCP clients](mcp-clients.md#authentication-tokens).

**stdio client hangs or reports invalid JSON** — something is writing to stdout. BrowserHive never does under stdio; check wrapper scripts. Use absolute paths to `bun` and `browserhive` in desktop apps that do not inherit your shell's `PATH`.

**`request_attention` returns `ATTENTION_REQUIRES_HTTP`** — you are on stdio. Use the HTTP transport with `--admin`.

## Logs

- `--logLevel debug`, or per module: `--logLevel info,sessions=debug`. You can also change the level at runtime from the System page.
- `--logFormat json` for log collectors; JSON logs go to stderr.
- The dashboard's Logs page tails the last 5,000 records with filters.
