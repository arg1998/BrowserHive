# Security model

BrowserHive runs on your machine and treats **the agent as untrusted and the operator as trusted**. Websites are hostile. This page explains what protects what, and the limits you should know about.

## One port, one bind rule

MCP, the REST API, the WebSocket and the dashboard share `--host` and `--port`. The default bind is `127.0.0.1`.

Binding a non-loopback address (for example `--host 0.0.0.0`) is **refused** unless one of these is true:

- `--auth token` is set, or
- `--allowInsecureBind` is set, which you should only do on a network you fully control. The startup banner then shows a red warning.

The refusal is [`INSECURE_BIND_REFUSED`](../reference/errors.md#INSECURE_BIND_REFUSED) with exit code 3. BrowserHive does not terminate TLS; for remote access, put a reverse proxy with TLS in front and list it in `--trustedProxies` so client addresses and `X-Forwarded-Proto` are honoured. Requests whose `Host` header names anything other than loopback, the bind address or an entry of `--allowedHosts` are rejected (DNS rebinding), so add the public name the proxy forwards, for example `--allowedHosts browserhive.example.com`. The port is never compared.

## Authentication

### Agents (`/mcp`)

| `--auth` | Behaviour |
|---|---|
| `off` (default) | No credentials. Every caller is the principal `local` and sees every session. Loopback binds only. |
| `token` | `Authorization: Bearer <token>` on every request, including `initialize`. A missing or unknown token gets HTTP 401. Each token belongs to a principal, and a principal only sees and controls the sessions, saved logins and attention requests it created. A reconnecting client with the same token keeps its sessions. |

Tokens:

- On the first start with `--auth token`, a token for the principal `agent-1` is generated and printed once.
- `browserhive admin tokens create <name>` issues more; `list` shows name, public prefix, creation and last use; `revoke` is immediate. The dashboard's System page offers the same.
- Tokens are stored as SHA-256 hashes with an 8-character public prefix for lookup; the plaintext is only shown at creation.
- `BROWSERHIVE_AUTH_TOKENS=name:token,…` adds tokens (at least 32 characters) that are never stored.

`--auth token` requires `--transport http`. Under stdio the only caller is the process that spawned BrowserHive.

### Operators (dashboard and REST API)

The dashboard always requires a password, independent of `--auth`.

1. **Seed password.** On the first start with `--admin`, a 24-character password is generated from a cryptographic random source, printed once (never under stdio), and written to `<data-dir>/admin/credentials.txt` with mode `0600`.
2. **Forced change.** Until you set a new password (12 to 256 characters, different from the current one), only the change-password flow is reachable. After the change, the seed file is overwritten with zeros and deleted.
3. **Storage.** Passwords are hashed with Argon2id.
4. **Sessions.** Signing in sets an `HttpOnly`, `SameSite=Strict` cookie. Sessions expire after 15 minutes idle or 8 hours total. Changing the password signs out every other session.
5. **Recovery.** `browserhive admin reset-password` (with the server stopped) issues a new seed password.

Operator API tokens let scripts call the REST API without a browser. Every login, logout, password change and token issue or revocation is recorded in an audit table and logged.

### Authorization

Operators hold every scope. Agent tokens only hold the tool scope: they cannot read the dashboard API, resolve their own attention requests, or change vault policy. Scopes per REST route are listed in the [API reference](../reference/api.md).

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
- Every secret BrowserHive creates or handles (seed password, tokens, cookies, vault session tokens, OTLP headers) is registered with a redactor that scrubs logs, database rows, WebSocket frames, MCP results and OTLP exports.

## What is recorded

Local-first means you own the records. With the defaults:

| Recorded | Not recorded |
|---|---|
| Every tool call: name, arguments, timing, outcome, error code, trace id | Cookie **values**. Only name, domain, path and expiry are stored or shown. |
| Tool results as text, capped at 16 KiB | URL query strings and fragments, unless the parameter is in `--urlQueryAllowlist` |
| Navigations, blocked attempts, attention requests, vault access (without secrets) | Passwords, tokens, vault credentials, `Authorization` headers |
| Screenshots taken by the agent; one frame per tool call with `--screenshotTrace` | Fields marked sensitive in the contracts, redacted before any sink |
| A Playwright trace per session when `trace` is on (default with `--admin`) | Error messages are passed through the same redaction first |

Stricter deployments can reduce what tool results store:

| `--recordToolResults` | Stored |
|---|---|
| `full` (default) | the result text, capped at 16 KiB |
| `shape` | keys and sizes only |
| `none` | nothing from the result |

Records are pruned after `--retentionDays` (default 7) or when the database and artifacts exceed `--retentionBytes` (default 1 GiB). `browserhive purge` deletes local state on demand.

## Files on disk

The data directory is `0700` and secret files are `0600`. Saved logins (`auth-states/`) contain real cookies and storage; protect them like passwords. They are protected by your OS user account, not encrypted by BrowserHive.

## The blocklist is not an egress firewall

`--blocklist` stops navigations at the tool boundary and aborts document requests in the browser. Subresources still load, and an agent with `evaluate` can `fetch()` a blocked URL. Use it to keep agents off pages, not to contain them.

## Takeover is full control

During an open attention request, an operator's mouse and keyboard input goes straight to the agent's browser. Input is re-checked against the open request on every message and refused otherwise.

## Other limits

- Browser processes run without Chromium's sandbox (`--no-sandbox`, Playwright's default). A page that exploits a Chromium bug gets the privileges of the user running BrowserHive, so run it as a user with access only to what it needs, and keep BrowserHive updated: each version pins its Chromium build.
- WebAuthn and passkeys cannot be replayed from saved state.
- Telemetry is off by default. Nothing leaves the host unless you set `--otel`, and then only to the endpoint you configure.

Report vulnerabilities as described in `SECURITY.md` at the root of the repository.
