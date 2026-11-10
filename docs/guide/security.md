# Security model

BrowserHive runs on your machine and treats **the agent as untrusted and the operator as trusted**. Websites are hostile. This page explains what protects what, and the limits you should know about.

## One port, one bind rule

MCP, the REST API, the WebSocket and the dashboard share `--host` and `--port`. The default bind is `127.0.0.1`.

Binding a non-loopback address (for example `--host 0.0.0.0`) is **refused** unless one of these is true:

- `--auth token` is set, or
- `--allowInsecureBind` is set, which you should only do on a network you fully control. The startup banner then shows a red warning.

The refusal is [`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED) with exit code 3. BrowserHive does not terminate TLS; for remote access, put a reverse proxy with TLS in front and list it in `--trustedProxies` so client addresses and `X-Forwarded-Proto` are honoured. Requests whose `Host` header names anything other than loopback, the bind address or an entry of `--allowedHosts` are rejected (DNS rebinding), so add the public name the proxy forwards, for example `--allowedHosts browserhive.example.com`. The port is never compared. Setting `--publicUrl` (the address you reach the dashboard at, used for [notification links](notifications.md#public-address)) trusts its host the same way and also accepts its origin in the CSRF check, which a proxy that rewrites `Host` needs.

## Authentication

### Agents (`/mcp`)

| `--auth` | Behaviour |
|---|---|
| `off` (default) | No credentials. Every caller is the principal `local` and sees every session. Loopback binds only. |
| `token` | `Authorization: Bearer <token>` on every request, including `initialize`. A missing or unknown token gets HTTP 401. Each token belongs to a principal, and a principal only sees and controls the sessions, saved logins and attention requests it created. A reconnecting client with the same token keeps its sessions. |

Tokens:

- On the first start with `--auth token`, a token for the principal `agent-1` is generated and printed once.
- `browserhive admin tokens create <name>` issues more; `list` shows name, public prefix, creation and last use; `revoke` is immediate. The dashboard's System page offers the same.
- The names `local`, `browserhive`, `system` and `template:…` are reserved and refused, because an agent with such a name would own what BrowserHive's own principals own (for example everything created with `--auth off`). `browserhive doctor` warns about tokens an earlier version created under one; see [reserved names](mcp-clients.md#reserved-names).
- Tokens are stored as SHA-256 hashes with an 8-character public prefix for lookup; the plaintext is only shown at creation.
- `BROWSERHIVE_AUTH_TOKENS=name:token,…` adds tokens (at least 32 characters) that are never stored.

`--auth token` requires `--transport http`. Under stdio the only caller is the process that spawned BrowserHive.

Size limits on `/mcp`, so one request cannot exhaust the daemon's memory:

- A request body over 4 MiB gets HTTP 413; a JSON-RPC batch of more than 100 messages gets HTTP 400.
- A tool call whose arguments hold more than 100,000 array elements and object members (counted at every depth) fails with [`INVALID_ARGUMENTS`](../reference/errors.md#INVALID_ARGUMENTS) before it is validated. This applies under stdio too.

### Operators (dashboard and REST API)

The dashboard always requires a password, independent of `--auth`.

1. **Seed password.** On the first start with `--admin`, a 24-character password is generated from a cryptographic random source, printed once (never under stdio), and written to `<data-dir>/admin/credentials.txt` with mode `0600`.
2. **Forced change.** Until you set a new password (12 to 256 characters, different from the current one), only the change-password flow is reachable. After the change, the seed file is overwritten with zeros and deleted.
3. **Storage.** Passwords are hashed with Argon2id.
4. **Sessions.** Signing in sets an `HttpOnly`, `SameSite=Strict` cookie. Sessions expire after 15 minutes idle or 8 hours total. Changing the password signs out every other session.
5. **Recovery.** `browserhive admin reset-password` (with the server stopped) issues a new seed password.

Operator API tokens let scripts call the REST API without a browser. Every login, logout, password change and token issue or revocation is recorded in an audit table and logged.

### Authorization

Signed in to the dashboard, an operator holds every scope. Agent tokens only hold the tool scope: they cannot read the dashboard API, resolve their own attention requests, or change vault policy. Scopes per REST route are listed in the [API reference](../reference/api.md).

**Scopes limit operator API tokens too.** A token is limited to the scopes it was issued with, whoever owns it, on the REST API, the WebSocket and `/mcp`. For example, `POST /api/v1/auth/tokens` with this body issues a read-only monitoring token:

```json
{ "owner_kind": "operator", "display": "monitoring", "scopes": ["system:read", "sessions:read"] }
```

That token can read `/system` and the session list, and gets 403 `FORBIDDEN` on anything else. `GET /api/v1/auth/me` shows the scopes it holds.

- A token issued without `scopes` holds every operator scope, including scopes added by later releases. Tokens issued that way before 0.2.3 keep holding every scope after the upgrade.
- Managing tokens, grants, dashboard sessions and the password needs the whole operator: the dashboard, or a token that holds every scope. A narrowed token cannot issue a wider one.
- `/mcp` needs the `mcp:tools` scope.

## The vault: credentials the model never sees

With `--vault bitwarden`, the agent calls `vault_fill` with an **entry name and CSS selectors**. BrowserHive fetches the credential from your vault and types it into the page. The password never appears in the tool call, the tool result, the logs or the database.

Every fill passes these gates, in order, and each outcome writes exactly one audit row:

1. The session allows the vault (`vault_enabled`).
2. The caller is authorized for the entry: both the session slug and the calling principal must match the binding.
3. If the entry requires it, `evaluate` must be off for the session.
4. The page's origin is in the entry's allowed origins, matched on the registrable domain (so `evil-example.com` and `example.com.attacker.net` never match `*.example.com`).
5. If the entry requires confirmation, an operator approves it on the dashboard.
6. The credential is fetched and a redaction window opens before anything is typed.
7. The form's `action` must not post to another origin, checked before filling and before submitting.

Failures are returned as a status and reason (`origin_mismatch`, `not_authorized`, …), never as the credential or backend error text. Unknown entries and unauthorized entries give the same answer, so an agent cannot probe what exists. See [the vault guide](vault.md).

## Redaction and its limits

- **Redaction is substring-based.** For a few seconds after a fill (and until the page navigates off the entry's origins), exact occurrences of the password (and the username, if the entry says so) are replaced by `[REDACTED]` in tool results. An agent that base64-encodes a value bypasses it. It is a guardrail, not a boundary.
- **`evaluate` can read the DOM.** After the window closes, an agent with `evaluate` can read a field that still holds the credential. Use `clear_after_fill: true`, `disable_evaluate: true` per session, `require_no_evaluate` per vault entry, or `--allowEvaluate false` server-wide, which makes every `evaluate` call fail with [`EVALUATE_DISABLED`](../reference/errors.md#EVALUATE_DISABLED).
- **Traces do not contain typed credentials.** Playwright tracing is stopped before the first credential keystroke and restarted after submit, and the parts are merged when the session closes. The replay has a gap instead of the login POST.
- **Pixels are not redacted.** The live view and screenshots show exactly what the browser shows. Screenshot tracing skips frames while a redaction window is open, but operators are trusted with the live view.
- Every secret BrowserHive creates or handles (seed password, tokens, cookies, vault session tokens, OTLP headers) is registered with a redactor that scrubs logs, database rows, WebSocket frames, MCP results and OTLP exports. That includes secrets the config file reads from environment variables (`{env:CI_TOKEN}`, see [References](configuration.md#references)): the variable's name is shown so you know what to set, never its value or the file's text around it.
- **Notifications are redacted before they are stored or sent.** Every text a notification copies from an event (an agent's attention reason, a page address, an error) goes through the same redactor, and URLs lose their query strings. A notification channel keeps its tokens in environment variables; BrowserHive stores only the variable names, so a database backup never contains one. See [Notifications](notifications.md).
- **Answering from a chat is opt-in and checked.** Act buttons are off per channel until you switch them on. Each button carries a single-use token that expires after 24 hours, works only in the chat it was sent to and only while the request waits; only a hash is stored. On Telegram and Discord only the accounts on the channel's allow-list may press (by default the person who connected the chat). ntfy has no user identity, so its notification topic must stay private. Every press is audited under Notifications → Actions, and the agent never learns who answered. See [Answer from your phone](notifications.md#answer-from-your-phone).
- **Channels send only what you allow.** Each channel has a content level (counts, titles or full); screenshots are off by default, need `full`, are never taken during a vault fill and can mask form fields; the webhook channel can sign its requests. Links in notifications never carry a token. See [what leaves your machine](notifications.md#what-leaves-your-machine).

## What is recorded

Local-first means you own the records. With the defaults:

| Recorded | Not recorded |
|---|---|
| Every tool call: name, arguments (up to 64 KiB; larger ones keep their size and as much of their start as fits in 64 KiB), timing, outcome, error code, trace id | Cookie **values**. Only name, domain, path and expiry are stored or shown. |
| Tool results as text, capped at 16 KiB | URL query strings and fragments, unless the parameter is in `--urlQueryAllowlist` |
| Navigations, blocked attempts, attention requests, vault access (without secrets) | Passwords, tokens, vault credentials, `Authorization` headers |
| Screenshots taken by the agent; one frame per tool call with `--screenshotTrace` | Fields marked sensitive in the contracts, redacted before any sink |
| A Playwright trace per session when `trace` is on (default with `--admin`) | Error messages are passed through the same redaction first |
| Notifications, their deliveries to channels and act-button presses; channel settings with the **names** of their token variables | Channel tokens, which stay in environment variables; act-button tokens are stored only as hashes |

Stricter deployments can reduce what tool results store:

| `--recordToolResults` | Stored |
|---|---|
| `full` (default) | the result text, capped at 16 KiB |
| `shape` | keys and sizes only |
| `none` | nothing from the result |

Records are pruned after `--retentionDays` (default 7) or when the database and artifacts exceed `--retentionBytes` (default 1 GiB). `browserhive purge` deletes local state on demand.

## Files on disk

The data directory is `0700` and secret files are `0600`. Saved logins (`auth-states/`) contain real cookies and storage; protect them like passwords. They are protected by your OS user account, not encrypted by BrowserHive. Of a [session template](templates.md), only the checkpoint and versions are encrypted ([Encryption at rest](#encryption-at-rest)).

### Saved logins are per principal

Each principal has its own saved-login names. The no-auth `local` principal keeps its files directly in `auth-states/`; every token principal has `auth-states/p/<id>/`, where `<id>` is the first 16 hex characters of the SHA-256 of its subject. So two agents with different tokens can both save a login called `work` and never see, restore or overwrite each other's:

- `list_saved_auths` lists only the caller's own.
- A restore (`context_options.storageState` or `restore_profile`) finds only the caller's own snapshot, and only of the kind asked for. Anything else answers `AUTH_STATE_NOT_FOUND` with the same text as a name that does not exist, so a caller cannot probe for other principals' names.
- Saving under a name replaces the caller's earlier snapshot of that name, whichever kind it was, including the identity seed saved beside a full profile.

Before 0.2.3 all principals shared one directory, and one could overwrite another's snapshot of the same name. See [Upgrading: saved logins move per principal](upgrading.md#saved-logins-move-per-principal).

## Agents open web URLs only

`navigate` and `new_tab` open `http://`, `https://`, `about:blank` and `data:` URLs, and nothing else (sessions launched from a [template](templates.md) do not open `data:` either). Every other scheme is refused with [`URL_SCHEME_NOT_ALLOWED`](../reference/errors.md#URL_SCHEME_NOT_ALLOWED) before the browser is touched:

- `file:` and `view-source:` would read any file BrowserHive's user can read, including its own data directory.
- `chrome:`, `chrome-untrusted:`, `chrome-extension:` and `devtools:` pages expose the browser's history, settings and saved passwords.
- `javascript:` would run agent-written script in the page, even in a session launched with `disable_evaluate: true` or on a server with `allowEvaluate=false`.
- `mailto:`, `tel:` and app schemes (`slack://`, `zoommtg://`) would launch programs on the host.
- `blob:`, `filesystem:` and every `about:` page other than `about:blank` are refused too.
- Input without a scheme is refused rather than guessed: `example.com` and `localhost:3000` must be written as `https://example.com/` and `http://localhost:3000/`.

The scheme is read the way a browser reads it: case, surrounding whitespace, tabs and newlines do not get a URL past the check (`JAVA<tab>SCRIPT:` is `javascript:`). The browser is then given the normalized URL.

This is a fixed rule, not configuration. As a backstop for navigations no tool asked for, BrowserHive closes any tab whose page ends up on a non-web URL (anything but `http:`, `https:`, `about:blank`, `about:srcdoc`, `blob:`, `data:` and Chromium's error page) and logs `non-web scheme page closed` with the session id and scheme. Pages a site opens as `blob:` or `data:` documents, and downloads, are unaffected.

## The blocklist is not an egress firewall

`--blocklist` stops navigations at the tool boundary and aborts document requests in the browser. Subresources still load, and an agent with `evaluate` can `fetch()` a blocked URL. Use it to keep agents off pages, not to contain them. While a blocklist is configured (even an empty one), sessions run with browser request interception on: their HTTP cache is off, and cross-origin requests skip the site's CORS preflight answer (the automation layer answers it), so a cross-origin write a server would refuse at preflight can still be sent. The blocklist covers network schemes only (`http`, `https`, `ws`, `wss`, `ftp`, `ftps`); [the scheme rule above](#agents-open-web-urls-only) keeps agents off every other scheme.

## The browser sandbox

Chromium's sandbox keeps a page that exploits a browser bug from getting the rights of the user running BrowserHive. The `sandbox` setting (`--sandbox`, `BROWSERHIVE_SANDBOX`) decides whether sessions use it:

| `--sandbox` | Behaviour |
|---|---|
| `auto` (default) | Each browser runs sandboxed where this machine allows it. The first session on a browser tries the sandbox; if the browser cannot use it here, that browser runs without it from then on, with one warning in the log. A session never fails because of the sandbox. |
| `on` | The sandbox is required. Before the server opens its port it launches the configured browser once with the sandbox on; if that fails, it refuses to start (exit code 3) and prints what to do on this machine. A session on a browser that cannot sandbox fails with [`SANDBOX_UNAVAILABLE`](../reference/errors.md#SANDBOX_UNAVAILABLE), `retryable: never`. |
| `off` | Never sandboxed, as in versions before this setting existed. |

Where it works:

| Machine | Sandbox under `auto` |
|---|---|
| macOS, Windows | on, for every browser |
| Linux without restrictions | on |
| Ubuntu 23.10+ (and derivatives), Google Chrome from Google's package | on (Ubuntu ships an AppArmor profile for it) |
| Ubuntu 23.10+, the bundled Chromium | off: no AppArmor profile covers Playwright's download path |
| Running as root, or Docker's default settings | off: Chrome refuses the sandbox as root; Docker's default seccomp profile blocks it |

Ubuntu 23.10 and later only let programs with an AppArmor profile create the user namespaces the sandbox needs (`kernel.apparmor_restrict_unprivileged_userns=1`). Two ways to get the sandbox there:

1. **Use the installed Google Chrome**: `browserhive init --channel chrome --yes`, or `--defaultChannel chrome`. `browserhive init` can install it for you.
2. **Give the bundled browser a profile** (one-time, needs `sudo`; redo it after a BrowserHive update that downloads a new browser build):

   ```bash
   browserhive doctor --printApparmorProfile | sudo tee /etc/apparmor.d/browserhive-chromium
   sudo apparmor_parser -r /etc/apparmor.d/browserhive-chromium
   ```

   The profile has the same shape as the one Ubuntu ships for Google Chrome. BrowserHive only prints it; it never installs anything.

`browserhive doctor` shows, per installed browser, whether it can run sandboxed here and, when your configured browser cannot, the options for your machine. The dashboard's System page lists the browsers and each one's sandbox state, and a session's Details tab shows whether that session ran sandboxed. That is recorded when its browser launches and kept with the session, so you can still check it after the session closed (`browser.sandboxed` in `GET /api/v1/sessions/{id}`). Sessions from before BrowserHive 0.2 show "not recorded".

An agent can ask for the sandbox for one session (`launch_options: { chromiumSandbox: true }`); if the browser cannot provide it, the launch fails with `SANDBOX_UNAVAILABLE` instead of starting unsandboxed. An agent can never turn the sandbox off: `chromiumSandbox: false` is refused.

## Session templates

A [session template](templates.md) is a browser you signed in to sites once, which agents then use. It changes what you are trusting agents with.

- **A template is a bearer credential.** Whoever may launch it acts as you on its sites, past their passwords and two-factor checks. Decide who may launch it (its access rule: principals, optionally harnesses), give each agent its own token under `--auth token`, and keep the list short. Deleting a template does not sign you out at the sites.
- **Sealing is narrow.** By default agents get no cookie values (`get_cookies` returns names only), no `evaluate`, no cookie writes and no storage export, and every cookie value, and every stored value of the template's sites on the session's pages, of 12 or more characters is replaced with `[sealed]` in text results, also in its JSON-escaped, URL-encoded and HTML-escaped forms. That keeps the raw sign-in material from being copied out through tool results. It does not stop an agent from acting as the account: it can click, type and read pages like you, including creating new credentials (an API token, an app password, a recovery address), and tokens a page displays that are not cookie values are not redacted. Screenshots and the live view are not redacted. Unsealing `evaluate` gives an agent code execution in origins every session of the template shares; treat it as unsealing everything. See [Sealing](templates.md#sealing).
- **Agents that can run commands as BrowserHive's OS user are out of scope.** A local harness with a shell (typical for stdio agents) can copy the template's profile from the data directory, or drive its windows through the display, and sealing cannot stop that. When agents have shell access, run BrowserHive as a separate OS user or in a container, serve it over HTTP, and give each agent its own token.
- **The live profile is effectively plaintext at rest.** A template's profile (`<data-dir>/templates/<id>/userdata`: cookies, local storage, IndexedDB, history) is protected by file modes only (`0700` directories, `0600` files). Only the checkpoint and versions are encrypted; see [Encryption at rest](#encryption-at-rest). Copies of `templates/<id>/` need the same care as passwords.
- **Never run a bare `Xvfb`.** On a server, a template's browser needs a display. `Xvfb :99` without `-auth` lets every local user watch and drive the signed-in windows. Use `xvfb-run -a` or `Xvfb -nolisten tcp -auth <file>`, and reach a VNC server bound to loopback over SSH ([Displays](templates.md#displays)).
- **BrowserHive is out of the template's reach.** A template's browser refuses every request to BrowserHive's own addresses, and carries a marker cookie that makes BrowserHive answer any request from it, including a redirect, with 403. The dashboard therefore never loads in a template's window, and its sign-in cookie never enters a template. Agents get `URL_BLOCKED` for those addresses, and `data:` and every non-web URL are refused in template sessions.
- **Headed windows on your desktop.** A headed template's windows open on the machine running BrowserHive, in the background: BrowserHive never raises or focuses an agent's window, except that starting the template's browser can take the focus once. While you sign in, every agent window of that template is minimized, new ones open minimized, and a window an agent's site opens is minimized as it appears (or closed if it lands in your sign-in window). Such a popup can still hold the focus for a moment before it is minimized, so check the window title before you type a password, or sign in while no agent uses the template. `press_key` refuses clipboard shortcuts and `click` the middle button in template sessions, because a paste would read your clipboard or primary selection. A page an agent clicks in can still write to your clipboard (`navigator.clipboard.writeText`): do not paste into a sign-in form what you did not copy yourself. When signing in, type rather than paste, and check the address bar. A tab you open by hand in a template's browser belongs to no session, so no agent can reach it.
- **No saved passwords or vault fills.** Chromium's password manager, autofill and browser sign-in are off in a template's browser, and `vault_fill` is refused in template sessions: a fill would sign every session of the template in, past the binding's own rules.

### Encryption at rest

BrowserHive encrypts a template's [checkpoint and versions](templates.md#versions-and-the-checkpoint) (`templates/<id>/versions/*.state.enc`) with AES-256-GCM under the template key. A file opens only with that key, only under its own template and version, and only with its header unchanged. Decrypted state is never written to disk.

**What it protects:** copies of the checkpoint and version files (a backup, a synced folder, a disk image) when the key is not copied with them.

**What it does not protect:**

| Not protected | Why |
|---|---|
| The live profile, `templates/<id>/userdata/` | The browser keeps its cookies, storage and history there, and BrowserHive cannot encrypt them. Its protection is the file modes (`0700` directories, `0600` files); the browser's own cookie encryption adds little (below). |
| `templates/<id>/downloads/` | Plain files. |
| `versions/v<N>.meta.json` | Plain JSON: per site the cookie count and the names of the sign-in cookies present (never values). |
| Storage states an unsealed agent saved (`state_export`), and every saved login in `auth-states/` | Not encrypted ([Files on disk](#files-on-disk)). |
| A machine where an attacker can read the data directory | The default key file, `admin/template.key`, lives in the data directory. Set `templateKey` from the environment (`BROWSERHIVE_TEMPLATE_KEY`) to keep the key out of it. |
| A running BrowserHive, or an agent that runs code as BrowserHive's OS user | The key and the decrypted state are in memory, and the live profile is readable. See the agents bullet above. |

The cookies in the live profile, per platform:

| Platform | Cookie encryption in the live profile |
|---|---|
| Linux | Chromium under automation runs with `--password-store=basic`, which encrypts cookies with a published constant key: effectively plain text. |
| macOS | Chromium under automation uses a mocked keychain (`--use-mock-keychain`): effectively plain text. |
| Windows | DPAPI, per user account: any process running as your user can decrypt them. |

Treat the key like a password, and store it apart from any copy of the files. To change it, see [Rotating the key](templates.md#rotating-the-key).

## Takeover is full control

During an open attention request, an operator's mouse and keyboard input goes straight to the agent's browser. Input is re-checked against the open request on every message and refused otherwise.

## Other limits

- Where the sandbox cannot run (see [above](#the-browser-sandbox)), a page that exploits a Chromium bug gets the privileges of the user running BrowserHive. Run it as a user with access only to what it needs, and keep BrowserHive (and an installed Chrome) updated: each BrowserHive version pins its Chromium build.
- WebAuthn and passkeys cannot be replayed from saved state.
- Telemetry is off by default, and there is no notification channel until you add one. Nothing leaves the host unless you set `--otel` (then only to the endpoint you configure) or add a [notification channel](notifications.md#what-leaves-your-machine) (then only to the service you chose, at the channel's content level).

Report vulnerabilities as described in `SECURITY.md` at the root of the repository.
