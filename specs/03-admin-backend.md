---
title: "Admin backend"
spec: "03"
status: Normative
scope: The admin HTTP API, the realtime WebSocket and live view, static serving, authentication and authorization, the SQLite data model behind them, repositories, retention, and notifications.
audience: Contributors implementing or changing the HTTP, WebSocket, auth or persistence layers; dashboard developers consuming the API; reviewers of API and schema changes.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
  - 02-mcp-and-tools.md
  - 04-admin-frontend.md
  - 10-error-handling-and-telemetry.md
---

# 03 — Admin Backend

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: the HTTP API, the realtime WebSocket, static serving, authentication and authorization, the data model behind them, retention, and notifications. The layer rules are in `01-overall-architecture.md` §4.

Everything here runs in the single `Bun.serve` on `--port` (D-02). The admin surface is enabled by `admin=true`; the auth, `/health`, and `/mcp` routes exist regardless.

---

## 1. Layering and the routes-as-data model

### 1.1 Where the code lives

```
core/src/interface/http/
  app.ts               builds the OpenAPIHono app: middleware stack + route tables + static + openapi doc
  define-route.ts      defineRoute() helper (§1.2)
  middleware/          request-id, access-log, secure-headers, host-guard, origin-guard, body-limit, auth, authorize, rate-limit, error-handler
  routes/              one file per resource: auth, sessions, tool-calls, pages, attention, vault, blocklist, system, logs, notifications, preferences, metrics, activity, artifacts
  serializers/         row/domain → wire DTO mappers (the only place that knows both shapes)
  problem.ts           problem+json helper (D-07)
core/src/interface/ws/
  hub.ts               connection registry, topics, replay buffer, backpressure
  protocol.ts          re-exports contracts/ws + dispatch table
  commands/            screencast, input, viewport, subscribe
  live-view.ts         CDP screencast bridge
core/src/interface/static/
  spa.ts, trace-viewer.ts
```

`interface/` imports application services from `app/` and types from `contracts`. It never imports a repository, `kysely`, `bun:sqlite`, or `playwright` (dependency-cruiser rule, 01 §4).

### 1.2 `defineRoute`

Every REST endpoint is a data object. The same descriptor table produces the Hono handlers, the OpenAPI document, the authorization matrix, and (for the subset that is also a WS command) the WS command table.

```ts
export const terminateSession = defineRoute({
  method: 'post',
  path: '/sessions/{session_id}/terminate',
  operationId: 'terminateSession',
  tags: ['sessions'],
  scope: 'sessions:write',              // Authorizer scope (D-09)
  auth: ['password-session', 'bearer'], // accepted providers; [] = public
  params: SessionIdParams,              // zod, from contracts/http
  body: undefined,
  responses: { 200: TerminateResult, 404: Problem, 409: Problem },
  handler: async ({ input, principal, services, ctx }) => {
    const r = await services.sessions.terminate(input.params.session_id, { by: principal });
    return { status: 200, body: r };
  },
});
```

Handler contract: **validate → authorize → service → serialize**. Validation and authorization are performed by the dispatcher before `handler` runs; the handler receives typed input and a `RequestPrincipal`. Handlers return `{status, body}` typed against `responses`; returning a shape that does not satisfy the schema is a compile error (`@hono/zod-openapi`, D-05). Anything thrown is an `AppError` or is wrapped as `INTERNAL_ERROR` by the error handler.

`services` is a narrow record (`sessions`, `attention`, `vault`, `auth`, `blocklist`, `analytics`, `notifications`, `system`, `logs`, `preferences`, `artifacts`) injected at composition. No handler touches storage.

### 1.3 Versioning

All routes are under `/api/v1`. Breaking changes bump the prefix; additive changes do not. `Deprecation` and `Sunset` headers are emitted on routes marked `deprecated: true`. The WS protocol carries its own version (`browserhive.v1`).

---

## 2. Middleware stack (in order)

| # | Middleware | Behavior |
|---|---|---|
| 1 | `requestId` | Accepts `X-Request-Id` (≤ 128 chars, `[A-Za-z0-9_-]`) or mints a ULID; echoes it; seeds the request context (10 §telemetry). |
| 2 | `accessLog` | One structured line (`http.access` "request completed") per request on completion: `route_pattern`, method, status, `duration_ms`, principal subject, bytes, request id. Level (`accessLogLevel()`): `debug` for health checks, non-API paths (dashboard assets, SPA `index.html`, trace viewer) and successful (`< 400`) `GET`/`HEAD` API requests by a password-session operator (the dashboard's own reads); `info` for everything else (mutations, bearer/agent REST, `/mcp`, any status ≥ 400). Absent correlation keys are omitted, never `null`. |
| 3 | `secureHeaders` | `Content-Security-Policy` (below), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (except the trace-viewer path which is `SAMEORIGIN`), `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, `Cross-Origin-Opener-Policy: same-origin`. HSTS only when the request arrived over TLS behind `--trustedProxies`. |
| 4 | `hostGuard` | Host allow-list, compared by name with the port ignored: loopback names, the configured `--host`, `--allowedHosts` entries, and any IP literal when `host` is a wildcard bind. Mismatch → 421 `HOST_NOT_ALLOWED`. This is the DNS-rebinding defense. The MCP handler runs the same `isHostAllowed` (02 §1.2), so `/mcp` and the dashboard can never disagree about a Host. |
| 5 | `originGuard` | On mutating methods and WS upgrades: `Origin` (or `Sec-Fetch-Site`) must be same-origin (loopback aliases equal, port-aware). Missing both headers → allowed only when authenticated by bearer (non-browser client). Failure → 403 `ORIGIN_NOT_ALLOWED`. |
| 6 | `bodyLimit` | 1 MiB default; 64 KiB on `/auth/login`; 16 MiB on `/vault/import`. Exceeded → 413 `PAYLOAD_TOO_LARGE`. |
| 7 | `authenticate` | Runs the provider chain (§3.2). Sets `principal` or leaves it null for public routes. Present-but-invalid credential → 401 immediately. |
| 8 | `passwordChangeGate` | If `principal.must_change_password`, only `/auth/me`, `/auth/change-password`, `/auth/logout` proceed; everything else (incl. WS upgrade) → 403 `PASSWORD_CHANGE_REQUIRED`. |
| 9 | `authorize` | `Authorizer.can(principal, route.scope, resource)`; failure → 403 `FORBIDDEN`. Public routes skip. |
| 10 | `rateLimit` | Token buckets keyed by principal (or client IP for public routes): default 600 req/min (`DEFAULT_RATE`, bucket `default:<key>`); **operator reads** — `GET`/`HEAD` by a principal authenticated with the password-session cookie on a route without its own rule, including `/auth/me` — get a separate 6000 req/min bucket (`OPERATOR_READ_RATE`, bucket `read:<key>`), because every dashboard tab shares the operator principal and one page load issues 12–17 reads; mutations, bearer and grant callers stay on the default bucket; `/auth/login` 5/min/IP with 5-minute lockout after the 6th; `/vault/unlock` 5/min; `/search` and `/client-errors` 30/min. Emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429 `RATE_LIMITED`. Buckets swept every 60 s. |
| 11 | `loginSemaphore` | At most 2 concurrent Argon2 verifications process-wide; excess → 503 `RATE_LIMITED` with `Retry-After: 1`. Prevents the 64 MiB-per-attempt memory DoS. |
| 12 | `etag` | Weak ETag on JSON GET responses; `If-None-Match` → 304. |
| — | `errorHandler` (`app.onError`) | `AppError` → problem+json with its status; unknown → 500 `INTERNAL_ERROR`, private message logged with stack, public message generic. `notFound` → 404 problem; wrong method → 405 with `Allow`. |

`/mcp` bypasses this REST stack (its own auth runs first) and, once authenticated, lifts Bun's per-connection idle timeout (default 10 s) for that request (`disableIdleTimeout` → `server.timeout(request, 0)`): a blocked tool call (`request_attention`, vault-confirm-gated `vault_fill`, `get_attention_result`) writes nothing to its SSE stream until an operator decides, and the 25 s keep-alive is slower than 10 s, so otherwise Bun cuts the stream and the result is never delivered. REST and static routes keep the default idle timeout.

Client IP: the socket address from `Bun.serve` unless the peer is in `--trustedProxies` (CIDR list), in which case the right-most untrusted `X-Forwarded-For` hop is used. `X-Forwarded-For` is otherwise ignored.

CSP for the dashboard: `default-src 'self'; script-src 'self' 'nonce-<per-response>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'`. The inline theme bootstrap in `index.html` carries the nonce, injected when `index.html` is served (it is templated, not static). The trace viewer is served at `/trace-viewer/` with its own CSP (`sandbox allow-scripts allow-same-origin; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`) because it is third-party code.

---

## 3. Authentication and authorization (D-09)

### 3.1 `RequestPrincipal`

```ts
interface RequestPrincipal {
  subject: string;                       // principals.principal_id
  kind: 'operator' | 'agent' | 'service';
  display: string;
  auth: { method: 'password-session' | 'bearer' | 'grant'; session_id?: string; credential_id?: string; expires_at?: number };
  scopes: readonly Scope[];              // resolved from kind + credential scopes
  tenant_id: string | null;              // always null in v1
  must_change_password: boolean;
}
```

The MCP `caller` is the same object; `resolveCaller` reads `principal.subject`. Under `auth=off` the MCP front door synthesizes `{subject:'local', kind:'agent', scopes: AGENT_SCOPES}`; the admin API never uses `local`.

### 3.2 Providers

Ordered chain; the first provider that recognizes a credential decides. A recognized-but-invalid credential fails with 401 `UNAUTHORIZED`; nothing falls through.

| Provider | Credential | Yields |
|---|---|---|
| `password-session` | Cookie `browserhive_session=<token>` | operator principal from `auth_sessions` (sliding validate) |
| `bearer` | `Authorization: Bearer <token>` | agent principal (MCP tokens) **or** operator principal when the token's credential kind is `api_token` with `owner_kind='operator'` (scripting the admin API without a browser) |
| `grant` | `?grant=<token>` on grant-enabled routes only (`trace.zip`, screenshot images opened in a new tab) | the parent session's principal, single-use per route, 10-minute TTL, revoked with the parent session |

Tokens at rest: `credentials.secret_hash` = SHA-256 of the token; `public_prefix` = first 8 chars for listing/revocation. Lookup by prefix then constant-time compare. Bearer tokens are `bh_<kind>_<base64url 32 bytes>`.

### 3.3 Operator sessions (`auth_sessions`)

- Created on login; token 32 random bytes base64url, stored hashed.
- Idle timeout 15 minutes, slid on every authenticated request **and** on any WS command including `ping`, because an operator watching a live view without clicking is still active and must not be signed out mid-takeover. Absolute lifetime 8 hours.
- Cookie: `browserhive_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when the request is HTTPS (direct TLS is not supported; `Secure` is set when a trusted proxy reports `X-Forwarded-Proto: https`), `Max-Age=28800`.
- `GET /auth/sessions` lists the caller's sessions (id prefix, created, last seen, user agent, ip); `DELETE /auth/sessions/{id}`; `POST /auth/sessions/revoke-all`. Password change revokes all other sessions. Logout destroys the session and closes its WS connections with `4401`.
- Expired rows are swept every 5 minutes.

### 3.4 Passwords and the seed flow

- Argon2id via `Bun.password.hash(pw, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 })`; verify with `Bun.password.verify`.
- Policy: length ≥ 12, ≤ 256, must differ from the current password. No composition rules.
- First start with no operator principal: create `principals(kind='operator', display='admin')` + a `password` credential from a 24-character seed drawn with rejection sampling over `ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789` (no modulo bias), `must_change_password=1`. The seed is printed once to stdout (never under stdio transport) and written to `<data-dir>/admin/credentials.txt` (0600). After the first successful change the file is overwritten with zeros and unlinked.
- `browserhive admin reset-password` (CLI, requires filesystem access to the data dir, refuses while the daemon holds the DB lock unless `--force`) re-seeds and sets `must_change_password`.
- Every login success/failure, logout, password change, token issue/revoke, lockout, and grant issue writes an `auth_events` row and a log line at `info` (`warn` for failures).

### 3.5 Authorization

Scopes (v1): `sessions:read`, `sessions:write`, `sessions:takeover`, `attention:read`, `attention:resolve`, `vault:read`, `vault:write`, `vault:confirm`, `blocklist:read`, `blocklist:write`, `system:read`, `system:write`, `logs:read`, `notifications:read`, `notifications:write`, `preferences:write`, `mcp:tools`. Operators hold all scopes; agents hold `mcp:tools` only; an operator `api_token` may be issued with a subset. `Authorizer.can()` is the only enforcement point; route descriptors declare the scope; WS commands map to the same scopes (`input` → `sessions:takeover`). A `tenant_id` filter is applied in one data-access chokepoint (`ScopedRepositories(principal)`), a no-op in v1.

---

## 4. REST API reference (`/api/v1`)

Conventions (§5) apply to every list. `Auth` column: **S** operator session or operator bearer, **A** agent bearer, **G** grant, **P** public. All bodies and responses are snake_case JSON; timestamps are epoch ms. Errors are problem+json; codes named per route are additional to the universal `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_FAILED`, `RATE_LIMITED`, `INTERNAL_ERROR`.

### 4.1 Health and auth

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/health` | P | — | `{status:'starting'|'ready'|'degraded'|'stopping', phase, version, uptime_ms, checks:{db, browser, listeners}}`; 200 when ready; otherwise 503 with **the same JSON body** (`application/json`, not problem+json) so a client can render the degraded state | — |
| POST | `/auth/login` | P | `{password}` | `{ok:true, must_change_password, session:{id_prefix, expires_at}}` + `Set-Cookie` | 401 `INVALID_CREDENTIALS`, 429 `RATE_LIMITED` (`retry_after_ms` in details) |
| POST | `/auth/logout` | S | — | `{ok:true}`; clears cookie; closes the session's WS connections | — |
| GET | `/auth/me` | S/A | — | `{principal:{subject, kind, display, scopes, must_change_password}, session?:{id_prefix, created_at, last_seen_at, expires_at}}` | — |
| POST | `/auth/change-password` | S | `{current_password, new_password}` | `{ok:true, revoked_sessions:n}` | 400 `BAD_CURRENT_PASSWORD`, 400 `WEAK_PASSWORD` (details: `{min_length}`) |
| GET | `/auth/sessions` | S | — | `{data:[{id_prefix, created_at, last_seen_at, user_agent, ip, current}]}` | — |
| DELETE | `/auth/sessions/{id_prefix}` | S | — | `{ok:true}` | 404 |
| POST | `/auth/sessions/revoke-all` | S | — | `{ok:true, revoked:n}` (keeps current) | — |
| GET | `/auth/tokens` | S | — | `{data:[{credential_id, public_prefix, owner_kind, subject, scopes, created_at, last_used_at, expires_at}]}` | — |
| POST | `/auth/tokens` | S | `{owner_kind:'agent'|'operator', display, scopes?, expires_in_ms?}` | `{credential_id, token}` (token shown once) | 400 |
| DELETE | `/auth/tokens/{credential_id}` | S | — | `{ok:true}` | 404 |
| POST | `/auth/grants` | S | `{route:'trace'|'screenshot', resource_id}` | `{grant, expires_at}` | 400 |

### 4.2 Sessions

`SessionSummary` (the one shape used by lists, detail, and WS): `session_id, slug, owner, tenant_id, channel, engine, headless, incognito, persistence_mode, current_url, created_at, closed_at, closed_reason, archived_at, lease_expires_at, lease_paused_at, lease_remaining_ms, state ('reserved'|'launching'|'live'|'paused'|'draining'|'closed'|'crashed'), live, disable_evaluate, vault_enabled, stealth, fingerprint, humanize, stealth_recorded, identity, browser?:{version, sandboxed}, proxy_label, counts:{tool_calls, errors, pages, blocked, attention_open, vault_access}, has_live_viewers, client:{name, version, agent_name?, model?}` — `browser` (live sessions only; absent for stored rows) is the running engine's real version (`null` for a persistent context) and whether it runs inside Chromium's sandbox (D-27); `client` is the launching MCP connection's self-reported identity (02 §1.4: `clientInfo`, `X-BH-Workspace` as `agent_name`, `X-BH-Agent-Model` as `model`; absent headers are omitted), `null` when the session has no connection or the client declared nothing.

`counts` are live and identical in list rows, `GET /sessions/{id}` (`.session.counts` and top-level `counts`) and WS `session.updated`. For a live session they come from the in-memory aggregate (`app/sessions/session-counters.ts`), which subscribes to the same bus events the recorder persists: `tool.called` → `tool_calls` +1 and `errors` +1 when `error_code` is set (soft failures count); `page.visited` → `pages`; `blocklist.hit` → `blocked`; `vault.access` → `vault_access`; `attention.created`/`attention.resolved` → `attention_open` ±1. Every change publishes `session.updated` (coalesced 250 ms per session). `attention_open` counts pending **attention** requests only (vault confirms excluded, in the DB view too). A blocked `request_attention` counts in `tool_calls` once it returns. The takeover gate needs an open request with `mode = 'takeover'`; `attention_open > 0` alone is not sufficient.

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/sessions` | S | filters: `state[]` (enum), `view` (`all|live|closed|archived`, default all-non-archived), `archived` (`exclude|include|only`), `owner`, `channel[]`, `persistence_mode[]`, `q`, `since`, `until`; sort: `created_at|slug|channel|last_activity_at|errors|lease_expires_at|closed_at|owner|persistence_mode|blocked` | `Page<SessionSummary>` + `facets:{owners, channels, persistence_modes, states}` with counts | — |
| POST | `/sessions/bulk` | S | `{action:'archive'|'unarchive'|'terminate'|'delete', session_ids[≤100]}` + `Idempotency-Key` | `{results:[{session_id, ok, error?:{code,title}}], ok_count, error_count}` (207-style body, status 200) | 400 |
| GET | `/sessions/{session_id}` | S | — | `{session: SessionSummary, trace:{enabled, path, viewer_available, size_bytes?}, data_dir:{path, persistent}, counts, now}` (no embedded arrays) | 404 `SESSION_NOT_FOUND` |
| GET | `/sessions/{session_id}/tool-calls` | S | filters `tool[]`, `ok` (bool), `error_code[]`, `q`, `since`, `until`; sort `ts|duration_ms` | `Page<ToolCallRow>` — `event_id, tool, tab_id, ok, error_code, error_message, duration_ms, result_size_bytes, ts, trace_id, has_screenshot, args_json?, result_text?` (`args_json`/`result_text` only with `?expand=detail`) | 404 |
| GET | `/sessions/{session_id}/tool-calls/{event_id}` | S | — | full `ToolCallRow` + `screenshot?` | 404 |
| GET | `/sessions/{session_id}/pages` | S | filters `category[]`, `domain`, `tab_id`, `q`; sort `ts` | `Page<PageRow>` — `event_id, tab_id, url, title, domain, category, ts` | 404 |
| GET | `/sessions/{session_id}/attention` | S | filters `status[]`, `mode[]` | `Page<OperatorRequestRow>` | 404 |
| GET | `/sessions/{session_id}/vault-access` | S | as `/vault/log` | `Page<VaultAccessRow>` | 404 |
| GET | `/sessions/{session_id}/blocked` | S | as `/blocklist/attempts` | `Page<BlockedRequestRow>` | 404 |
| GET | `/sessions/{session_id}/screenshots` | S | filters `kind[]` | `Page<ScreenshotRow>` — `event_id, tool, kind, content_type, width, height, size_bytes, ts, url` | 404 |
| GET | `/sessions/{session_id}/timeline` | S | `kinds[]` (`tool|page|attention|vault|blocked`), `errors_only`, `q` (1..200), cursor | `Page<TimelineItem>` — `{kind, id, ts, seq, row}` merged server-side, sorted by `(ts, id)` desc with a cursor stable across kinds. `id = "<kind>:<row.event_id>"` (tool, page, vault, blocked) or `"attention:<row.request_id>"`: unique and stable (a navigate call and its page row share `event_id`, never `id`); live feed events carry no `id` and clients derive it with the same formula. `q` matches per kind: tool (tool, error_code, error_message, tab_id), page (url, title), attention (reason, session_id), vault (entry_name, page_url, session_id), blocked (url, pattern). `errors_only` keeps tool calls with an `error_code` (soft failures too), attention ended `rejected|timeout|cancelled`, vault results other than `success`, and every blocked request; pages are excluded | 404 |
| GET | `/sessions/{session_id}/screenshots/{event_id}` | S/G | — | image bytes; `Content-Type` from row; `Cache-Control: private, max-age=86400, immutable` | 404 `NOT_FOUND`, 404 `SCREENSHOT_UNAVAILABLE` |
| GET/HEAD | `/sessions/{session_id}/trace.zip` | S/G | `Range` (single range incl. suffix) | 200/206 zip stream, `Accept-Ranges`, `Content-Range`, `Cache-Control: no-store` | 404 `TRACE_UNAVAILABLE` (`details.enabled`), 416 |
| GET | `/sessions/{session_id}/trace` | S | — | `{enabled, viewer_available, path, size_bytes, command:'npx playwright show-trace <path>', viewer_url}` | 404 |
| POST | `/sessions/{session_id}/data-dir/reveal` | S | — | `{path, exists, desktop, opened, reason?:'no_desktop'|'missing'|'unsupported'|'failed', detail?}` | 404 |
| POST | `/sessions/{session_id}/terminate` | S | — | `{ok:true, closed:boolean}` | 404, 409 `SESSION_NOT_LIVE` |
| POST | `/sessions/{session_id}/archive` | S | — | `{ok:true}` | 404, 409 `SESSION_LIVE` |
| POST | `/sessions/{session_id}/unarchive` | S | — | `{ok:true}` | 404 |
| DELETE | `/sessions/{session_id}` | S | — | `{ok:true, deleted:{rows, bytes}}`; terminates first | 404 |
| POST | `/sessions/{session_id}/viewport` | S | `{width, height}` (200..10000) | `{ok:true, width, height, clamped?}` | 404, 409 `SESSION_NOT_AVAILABLE` |
| POST | `/sessions/{session_id}/input` | S (`sessions:takeover`) | `{inputs: LiveInput[≤64]}` | `{accepted:n, rejected:[{index, code}]}` — the scripting equivalent of the WS `input` command (same gate and audit) | 404, 409 `INPUT_NOT_PERMITTED` |
| GET | `/sessions/{session_id}/export` | S | `Accept: application/x-ndjson|text/csv`, `kinds[]` | streamed export of the timeline, capped at 100k rows (`X-Truncated: true`) | 404, 406 |

### 4.3 Cross-session activity and metrics

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/tool-calls` | S | filters `session_id`, `has_session` (`true` = only calls that ran in a session, `false` = only session-less calls, omitted = both), `tool[]`, `ok`, `error_code[]`, `q`, `since`, `until`; sort `ts|duration_ms` | `Page<ToolCallRow & {session_slug}>` (seed for the live feed and fleet error views); session-less calls (e.g. a failed `launch_session`) carry `session_id: null, session_slug: null` |
| GET | `/activity` | S | `since`, `until` (default last 7 d), `bucket_ms` (60 000..86 400 000, default auto ≤ 720 buckets), `group_by?` (`tool|error_code|session`) | `{buckets:[{ts, tool_calls, errors, sessions_started, sessions_closed, blocked, attention, groups?}], summary:{sessions_total, sessions_live, sessions_window, tool_calls_window, tool_calls_total, errors_window, errors_total, blocked_window, blocked_total, attention_open, active_screencasts}, window:{since, until, bucket_ms}, now}` — gap-filled, axis aligned, never more than 720 buckets |
| GET | `/metrics/tools` | S | `since`, `until`, `group_by` (`tool|error_code|tool,error_code`), `session_id?` | `{data:[{tool, error_code?, calls, errors, error_rate, p50_ms, p95_ms, p99_ms, max_ms}], now}` |
| GET | `/pages` | S | filters `category[]`, `session_id`, `domain`, `q`, `since`, `until`; sort `ts|domain|category|session` | `Page<PageRow & {session_slug}>` + `facets:{category:[{value, count}]}` (always present, disjunctive: every filter except `category` applies; zero-count categories omitted) |
| GET | `/pages/recent` | S | `limit` ≤ 200 | `{data:[PageRow & {session_slug}], now}` |
| GET | `/pages/domains` | S | `since?`, `until?`, `limit` ≤ 100 | `{data:[{domain, count}], window, now}` |

### 4.4 Operator requests (attention and vault confirm)

One broker (D-15) backs two resource views; paths stay recognizable.

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/attention` | S | filters `status[]` (`pending|resolved|rejected|timeout|cancelled`), `mode[]`, `session_id`, `q`, `since`, `until`; sort `created_at|resolved_at|waited_ms` | `Page<OperatorRequestRow>` — `request_id, kind:'attention', session_id, session_slug, owner, reason, mode, options, status, message, resolved_by, created_at, resolved_at, deadline_at, waited_ms, page_url, tool, event_id` + `open_count` + `facets:{status:[{value, count}], mode:[{value, count}]}` (always present, disjunctive: each dimension applies every filter except its own; zero counts omitted) | — |
| POST | `/attention/{request_id}/resolve` | S (`attention:resolve`) | `{decision:'resolve'|'reject', message?}` (enum, not "anything else") | `{ok:true, status}` | 404, 409 `ATTENTION_NOT_OPEN` |
| POST | `/attention/bulk` | S | `{action:'resolve'|'reject', request_ids[], message?}` + `Idempotency-Key` | per-item results | — |
| GET | `/vault/confirm` | S | filters `status[]` | `Page<OperatorRequestRow>` with `kind:'vault_confirm'`, `entry_name`, `page_url`, `tool`, `deadline_at` | 404 `VAULT_NOT_CONFIGURED` |
| POST | `/vault/confirm/{request_id}/resolve` | S (`vault:confirm`) | `{decision:'approve'|'deny', reason?}` (reason ≤ 500, audit only) | `{ok:true, status}` | 404, 409 `CONFIRM_NOT_OPEN` |
| POST | `/vault/confirm/bulk` | S | `{action, request_ids[], reason?}` | per-item results | — |

### 4.5 Vault (D-14)

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/vault` | S | — | `{backend:{id, capabilities:{unlock:'none'|'passphrase'|'token', grouping:'none'|'flat'|'tree', writable, totp, sync}}, unlock:{required, mode, hint}, unlocked, bindings_count, policies_count, now}` — never shells out | 404 `VAULT_NOT_CONFIGURED` |
| GET | `/vault/status` | S | — | `{unlocked, checked_at}` (may call the backend) | 404, 502 `VAULT_BACKEND_ERROR` |
| POST | `/vault/unlock` | S (`vault:write`) | exactly the field `unlock.mode` names: `{token}` (Bitwarden: a `BW_SESSION` token from `bw unlock --raw`, whitespace trimmed, verified with `bw status`; never a master password) or `{passphrase}` | `{ok:true, unlocked:true}` | 400 `VALIDATION_FAILED` (wrong field for the mode), 401 `VAULT_UNLOCK_FAILED`, 404 |
| POST | `/vault/lock` | S | — | `{ok:true}` | 404 |
| POST | `/vault/sync` | S | — | `{ok:true, items, groups, synced_at}` | 400 `VAULT_SYNC_UNSUPPORTED`, 409 `VAULT_LOCKED`, 404 |
| GET | `/vault/groups` | S | — | `{data:[{group_id (null = ungrouped), name, path?, item_count, bound_count, policy}], duplicates:[{group_id, name, ids[]}]}` | 409 `VAULT_LOCKED` |
| PUT | `/vault/groups/{group_id}/policy` | S (`vault:write`) | `{access_mode:'manual'|'allow_all'|'reject_all', allow_all_sessions?, session_slug_globs?, dashboard_confirm?, require_no_evaluate?, redact_username?}` + `If-Match` (row version) | `{ok:true, policy}` | 404, 409 `CONFLICT` |
| GET | `/vault/items` | S | `group_id?`, `q?`, cursor | `Page<{item_id, name, group_id, login_uris, handle, bound}>` | 409 `VAULT_LOCKED` |
| GET | `/vault/bindings` | S | `group_id?`, `q?`, cursor | `Page<VaultBinding>` — `handle, title, item_name, item_id, group_id, allowed_origins, authorized_principals, authorized_session_slugs, allow_all_sessions, redact_username, require_no_evaluate, dashboard_confirm, created_at, updated_at, version` | 404 |
| PUT | `/vault/bindings/{handle}` | S (`vault:write`) | binding fields (all optional on update; `item_name` required on create) + `If-Match` | `{ok:true, binding}` | 400, 404, 409 `CONFLICT` |
| DELETE | `/vault/bindings/{handle}` | S (`vault:write`) | — | `{ok:true, removed}` | 404 |
| POST | `/vault/bindings/resolve` | S | `{url, session_slug?, principal?}` | `{would_fill:[handle], blocked:[{handle, reason}]}` — server-side origin tester | 404 |
| GET | `/vault/log` | S | filters `result[]`, `origin_check[]`, `evaluate` (`on|off`), `session_id`, `entry_name`, `q`, `since`, `until`; sort `ts|entry_name|result|session` | `Page<VaultAccessRow>` | 404 |
| GET | `/vault/export` | S | — | `{version:3, bindings[], policies[]}` JSON | 404 |
| POST | `/vault/import` | S (`vault:write`) | export document; `?mode=merge|replace` | `{ok:true, imported:{bindings, policies}}` | 400 |

### 4.6 Blocklist (D-22)

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/blocklist` | S | `since?`, `until?` | `{configured, path, loaded_at, patterns:[{pattern, line, hits, last_ts}], skipped:[{line, text, reason}], stats:{attempts, sessions, domains, total_all_time, top_patterns, top_domains}, window, now}` |
| POST | `/blocklist/reload` | S (`blocklist:write`) | — | `{ok:true, patterns, skipped, loaded_at}`; 400 `BLOCKLIST_LOAD_FAILED` (list left unchanged) |
| GET | `/blocklist/attempts` | S | filters `session_id`, `pattern`, `domain`, `source[]`, `q`, `since`, `until`; sort `ts|domain|pattern|session|source` | `Page<BlockedRequestRow & {session_slug}>` |

### 4.7 System, config, logs

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/system` | S | — | `{version, transport, uptime_ms, started_at, host, port, admin, capacity:{live, max, max_source:'config'|'derived'}, open_attention, active_screencasts, realtime:{connections}, allow_evaluate, persistence_mode, stealth:{profile, driver, fingerprint, humanize, captcha}, vault:{enabled, backend}, blocklist:{configured, path, patterns}, retention:{days, bytes, last_run_at, last_result, next_run_at, pruned_rows, artifacts_pending}, storage:{db_bytes, schema_version, min_reader_version, migrations:[{version, name, applied_at, duration_ms, app_version}], dropped_writes_total, write_queue_depth, last_backup_at, backups_count}, otel:{enabled, endpoint, protocol}, degradations:[SystemEvent], now}` plus `auth_mode:'off'|'token'` (the `auth` key: `token` requires a bearer on `/mcp`), `runtime:{bun, sqlite, playwright, patchright, chromium}`, `data_dir`, `mcp:{connections}`. `runtime.chromium` is the version of the Chromium build the configured driver launches (`browsers.json` of `patchright-core` when stealth uses Patchright, else `playwright-core`; `bundledChromiumVersion(driver)`), reported only when the boot probe found that executable (the same check as `health.checks.browser`); `null` means the binary is missing. Backup timestamps (`last_backup_at`, backup `created_at`) are integer epoch ms (filesystem mtimes are floored). Additive `browser?:{default_channel, sandbox_mode, running_as_root, channels:[{channel, label, source:'bundled'|'installed', installed, version, executable, sandbox:'sandboxed'|'unavailable'|'unknown', sandbox_reason}]}` (D-26, D-27): the browsers found on the host (detected once, on the first request, with the same lookup `init` and `doctor` use) and each executable's sandbox verdict, read live from the sandbox policy (`unknown` until a launch or the `sandbox=on` boot check decided; `sandbox_reason` is Chrome's own sentence) |
| GET | `/system/config` | S | — | `{keys:[{key, value, source:'default'|'env'|'env(otel)'|'file'|'cli'|'derived', refs?, template?, shadowed:[{source, value, refs?}], secret}]}` — secret values `"[REDACTED]"`. `refs` lists the `{env:NAME}` references a config-file value used, `[{scheme:'env', ref, from:'value'|'default', at?}]`; `template` is the value as written in the file, never present when `secret`. `secret` is decided per run: keys flagged secret, plus keys whose value came through a reference with a credential-looking name (08 §3.1) |
| GET | `/system/realtime` | S | — | `{connections:[{connection_id, principal, connected_at, last_seen_at, topics, screencasts, buffered_bytes, dropped_frames, messages_out}]}` |
| PATCH | `/system/log-level` | S (`system:write`) | `{spec:'info,sessions=debug'}` | `{ok:true, effective}` |
| GET | `/system/events` | S | `since?`, `severity[]?` | `Page<SystemEvent>` (degradations; 10 §system_events) |
| GET | `/logs` | S (`logs:read`) | `dir` (`desc` default \| `asc`), `cursor`, `after_seq`, `level[]` (exact set), `module[]` (root prefix), `session_id`, `trace_id`, `request_id`, `q`, `since`, `until`, `limit` 1..1000 (default 200) | `Page<LogRecord>` + `latest_seq` from the ring buffer (5 000 records). `dir=desc`: newest matching records first, `next_cursor` pages to **older** records (`null` when none are left); `dir=asc`: oldest held first, the cursor pages to newer. A cursor is bound to the `dir` that minted it (other `dir` → 400 `VALIDATION_FAILED`). `after_seq`: only records with `seq > after_seq` (reconnect gap fill, echoed in `applied.filters`). `latest_seq` is the newest `seq` assigned (0 when empty). In `LogRecord`, `trace_id`, `span_id`, `request_id`, `session_id`, `principal`, `transport` and `err` are absent, never `null`; misfit values move to `fields.<key>`; `err` is always a serialized error |
| GET | `/logs/export` | S | same filters (no paging), `Accept: application/x-ndjson` | streamed, oldest first |
| GET | `/openapi.json` | P | — | OpenAPI 3.1 document |
| GET | `/docs` | P when admin, else 404 | — | reference UI |

### 4.8 Notifications and preferences

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/notifications` | S | `read` (`all|unread|read`), `type[]`, `since`, `until`, `sort` (`updated_at` default \| `created_at`), cursor | `Page<Notification>` + `unread_count`. `Notification` = `notification_id, principal_id, type, title, body, session_id, session_slug, target, source_event_id, created_at, updated_at, count, read_at, dismissed_at`; `session_slug` is `null` without a session; `count ≥ 1` is the number of folded occurrences; `updated_at` is the latest occurrence (= `created_at` when `count` is 1). `since`/`until` filter on the sort column and cursors are bound to it, so a growing group moves to the top. `unread_count` counts rows (a group of 12 errors counts 1) |
| POST | `/notifications/{notification_id}/read` | S | — | `{ok:true}` |
| POST | `/notifications/read-all` | S | — | `{ok:true, updated:n}` |
| DELETE | `/notifications/{notification_id}` | S | — | `{ok:true}` (dismiss) |
| POST | `/notifications/dismiss-all` | S | — | `{ok:true, updated:n}` |
| GET | `/me/preferences` | S | — | `{preferences: Preferences, updated_at}`. Known keys: `notifications {toasts, types}`, `saved_views`, `page_defaults`, `sidebar`, `default_page_size`. The dashboard reads only `notifications.*` (toast preferences follow the operator across devices); sidebar state and page size are per-device (`localStorage`) or per-URL, and the theme is per-device |
| PUT | `/me/preferences` | S (`preferences:write`) | `{preferences}` (≤ 64 KiB, zod-validated known keys, unknown keys rejected) | `{ok:true, updated_at}` |
| GET | `/search` | S | `q` (≥ 2 chars), `limit` ≤ 20 | `{sessions:[{session_id, slug}], tools:[name], vault_handles:[handle], patterns:[pattern]}` — command-palette entity search |

### 4.9 Client errors

| POST | `/client-errors` | S | `{message, stack?, route, user_agent, build}` (rate-limited 30/min) | 204 |

### 4.10 Resource naming and shape rules

Rules that shape the reference above; new routes MUST follow them.

| Rule | Applied as | Why |
|---|---|---|
| One port, one prefix | every admin route is under `/api/v1`, the WS at `/api/v1/ws`, the dashboard at `/` with History-API routing, the trace viewer at `/trace-viewer/*` | D-02; the dashboard and its API are same-origin |
| Explicit verbs for side effects | `POST /sessions/{id}/data-dir/reveal`, `/terminate`, `/archive`, `/unarchive`, `/blocklist/reload` | a `POST` to a noun is ambiguous in the OpenAPI document and the audit log |
| Detail plus sub-collections, never embedded arrays | `GET /sessions/{id}` returns `counts`; tool calls, pages, attention, vault access, blocked requests, screenshots and the merged `/timeline` are paginated sub-collections | detail responses stay small and every list gets cursors, filters and facets (§5) |
| One name per resource | navigation history is `pages` in REST and WS (the dashboard labels it "Websites"); vault folders are backend-neutral `groups` with `null` for ungrouped | topics are 1:1 with resources (D-10); backends other than Bitwarden have no folders (D-14) |
| Generic grants | `POST /auth/grants {route, resource_id}` issues the token for `trace.zip?grant=` and screenshot links | one mechanism for every link opened where a cookie cannot be sent |
| Bulk with per-item results | `/sessions/bulk`, `/attention/bulk`, `/vault/confirm/bulk` with `Idempotency-Key` | a partial failure must not hide the successes |
| Enumerated decisions | `decision: 'resolve'\|'reject'`, `'approve'\|'deny'` | a typo is a 400, never an accidental rejection |
| Backend-neutral unlock | `GET /vault` describes `unlock {required, mode, hint}`; `POST /vault/unlock` takes exactly the field the mode names (`{token}` or `{passphrase}`); `POST /vault/lock` | the dashboard renders one generic form for any backend (D-14) |
| Optimistic concurrency | `If-Match` on bindings and group policies, 409 `CONFLICT` with `details.current_version` | two operators editing one binding never silently overwrite each other (D-07) |
| Time windows | `since`/`until` epoch ms on every time-based list and aggregate | one grammar for every window (§5) |

---

## 5. Collection conventions

- Envelope for every list: `{ data: T[], page: { next_cursor: string|null, prev_cursor?: string|null, limit: number, total?: number }, facets?: Record<string, {value, count}[]>, applied: { filters: Record<string, unknown>, sort: { key, dir } }, meta: { now: number } }`.
- Cursors are keyset `(ts|created_at, id)` encoded as base64url JSON, opaque to clients, validated server-side (a cursor from another resource → 400). `total` is returned when `?total=true` (a separate COUNT with the same WHERE), otherwise omitted.
- `limit` default 50, max 500; each resource declares its filter spec and sort keys in contracts; unknown filter/sort keys → 400 `VALIDATION_FAILED` with the offending field, never silently dropped. Multi-value filters are repeated params (`?state=live&state=paused`) or comma lists; both parse.
- `since`/`until` are epoch ms; when both absent the resource's declared default window applies and is echoed in `applied`.
- Free-text `q` uses `LIKE` with `%`/`_` escaped.
- Weak ETags on all JSON GETs (hash of body); `304` on match.
- Bulk endpoints require `Idempotency-Key` (UUID, 24 h memory), replay returns the original result.
- Export endpoints negotiate on `Accept` and stream; rows capped per resource; `X-Truncated: true` when capped.

---

## 6. WebSocket protocol (D-10)

### 6.1 Handshake

`GET /api/v1/ws` with `Sec-WebSocket-Protocol: browserhive.v1`. The upgrade runs middlewares 1–9 (cookie or bearer; Origin gate). If authentication fails the server **completes the upgrade and immediately closes with 4401** so browsers see the code: an HTTP 401 on the upgrade request surfaces in the browser only as close code 1006, which a client cannot tell apart from a network failure and would retry forever. Missing/unknown subprotocol → close 4406. Password-change pending → close 4403.

### 6.2 Envelope

Text frames are JSON:

```ts
{ v: 1, kind: 'event'|'reply'|'error'|'stream', seq: number, ts: number, topic?: string, corr?: string, payload: unknown }
```

Binary frames carry screencast data (§6.5). Inbound frames > 16 KiB → error `PAYLOAD_TOO_LARGE`; 5 protocol violations → close 4400.

### 6.3 Client → server

| type | payload | reply |
|---|---|---|
| `subscribe` | `{topic, cursor?: number}` | `reply {topic, from, to, complete}`; `complete:false` means the cursor fell outside the buffer → client re-seeds from REST (`resync_required`) |
| `unsubscribe` | `{topic}` | `reply {ok}` |
| `command` | `{name, params}` with `corr` | `reply {result}` or `error` with the same `corr` |
| `ping` | — | `reply {pong, ts}`; slides the operator session |

Commands (`name` → params → scope): `screencast.start {session_id, max_width?, max_height?, quality?}` → `sessions:read` (`quality` is accepted and ignored: one stream serves every viewer of a session, so JPEG quality is `--screencastQuality`, §6.7); `screencast.stop {session_id}`; `screencast.set_size {session_id, max_width, max_height}`; `input {session_id, input: LiveInput}` → `sessions:takeover` (gated on an open attention request **per message**; refusal is `error INPUT_NOT_PERMITTED`, the socket stays up; every accepted input is audited as `operator_actions` rows with `action: 'input'`, coalesced per second per session and principal — `details: {inputs, mouse, key, touch, via: ['ws'|'rest'], window_ms}`, `occurred_at` = the window's first input, counts only, never keys, text or coordinates (takeover is how an operator types a password); REST `POST /sessions/{id}/input` shares the path, and shutdown flushes the open window); `session.set_viewport {session_id, width, height}` → `sessions:write` (not attention-gated, D-10); `logs.tail {level?, module?}` → `logs:read` (alias for subscribing `logs` with a filter; `level` is a **minimum** level and `module` a root prefix, whereas REST `level` is an exact set).

Ordering: `screencast.start`, `screencast.stop` and `screencast.set_size` from one connection are queued per session in arrival order before any await (`WsConnection.serial`), so a back-to-back `start → stop → start` (React StrictMode) always applies in that order; other commands, including `input`, are not queued. `screencast.start` replies `screencast.started {ordinal}` or fails with `SCREENCAST_FAILED {session_id, reason}` (retryable `backoff`), `SESSION_NOT_FOUND` or `SESSION_NOT_AVAILABLE`; `INTERNAL_ERROR` is not an expected outcome. `screencast.set_size` replies `ok` (same size = no-op) and is usually followed by a fresh frame. Unexpected command failures (non-`AppError` or `INTERNAL_ERROR`) are logged at `error` as `ws command failed` with `module: ws.hub`, `command`, `session_id`, `connection_id`, `ref` (equal to the `details.ref` the client received) and `err`; expected refusals log at `debug` as `ws command refused` with `code`.

`LiveInput`: `{type:'mouse', action, x, y, button?, clickCount?, deltaX?, deltaY?, modifiers?}` | `{type:'key', action, key?, code?, text?, windowsVirtualKeyCode?, modifiers?}` | `{type:'touch', action, points[]}` (mapped to `Input.dispatchTouchEvent`).

### 6.4 Server → client

- `hello {epoch, cursor, protocol:'browserhive.v1', server_version, now}` first frame after upgrade (a `reply`-kind frame without `corr`). `epoch` changes on every daemon start; a client holding a cursor from another epoch must re-seed.
- `event {topic, seq, payload}`; `reply {corr, ...}`; `error {corr?, code, title, details?}`.
- Feed guarantees: ordered by `seq`, at-least-once within the buffer, buffer bounded by count 10 000 / 8 MiB / 5 minutes (whichever first). Screencast: latest-wins, never buffered. The `logs` topic is live only: no replay or resume, droppable under backpressure, and its frame envelope `seq` is the feed head (use `record.seq`, the ring sequence); clients fill a reconnect gap with `GET /logs?dir=desc&after_seq=<max record.seq>`.
- Heartbeat: client pings every 20 s; server reaps sockets silent for 60 s (close 1001); server also sends `event {topic:'system', payload:{type:'tick'}}` every 30 s so proxies keep the socket open.
- Backpressure: feed sends check the raw socket's send status; if `bufferedAmount > 4 MiB` for 10 s the connection is closed with 1013 and a `system.degraded` is recorded; screencast frames are dropped while `bufferedAmount > 1 MiB`.
- Close codes: 4401 unauthenticated/expired, 4403 password change required, 4400 protocol error, 4406 bad subprotocol, 1013 overloaded, 1001 going away/stale.

### 6.5 Screencast binary frame

`[0..3] magic "BHSC"`, `[4..7] session ordinal (u32, assigned in the `screencast.start` reply)`, `[8..11] seq u32`, `[12..13] width u16`, `[14..15] height u16`, then JPEG bytes. `width`/`height` are the page's device (CSS) size from the CDP metadata, not the JPEG pixel size (after `set_size 640×360` the JPEG is scaled but the header still says 1280×720); clients draw from the decoded bitmap size. Metadata (`device_width`, `device_height`, `page_scale`, `offset_top`) arrives once per size change as `event {topic:'screencast:<id>', payload:{type:'meta', ...}}`.

### 6.6 Topics and payloads

| Topic | Event types → payload |
|---|---|
| `sessions` | `session.opened` `{session: SessionSummary}`, `session.updated` `{session}` (state, url, lease or any live counter changed; coalesced 250 ms per session), `session.closed` `{session_id, closed_at, reason}`, `session.removed` `{session_id, action:'archived'|'unarchived'|'deleted', at}` |
| `session:<id>` | all of the above for that id plus `tool.called` `{row: ToolCallRow, has_detail}`, `page.visited` `{row: PageRow}`, `screenshot.captured` `{row}`, `vault.access` `{row}`, `blocklist.hit` `{row}`, `attention.*`, `vault.confirm.*`, `session.warning` `{code, message, details}` |
| `attention` | `attention.created` `{request: OperatorRequestRow}`, `attention.resolved` `{request}` |
| `vault.confirm` | `vault.confirm.created`, `vault.confirm.resolved` `{request}` (deny reason included for operators) |
| `vault.config` | `vault.binding.changed` `{handle, action}`, `vault.policy.changed`, `vault.lock_state` `{unlocked}` |
| `vault.access` | `vault.access` `{row}` fleet-wide (scope `vault:read`), so the unfiltered vault log updates live; also published on `session:<id>` |
| `pages` | `page.visited` `{row}` fleet-wide (scope `sessions:read`), so overview and websites views update live; also published on `session:<id>` |
| `blocklist` | `blocklist.hit` `{row}`, `blocklist.reloaded` `{patterns, skipped}` |
| `system` | `system.degraded` `{event: SystemEvent}`, `system.recovered`, `tick`, `capacity` `{live, max}`, `retention.completed` |
| `notifications` | `notification.created` `{notification}` (first occurrence), `notification.updated` `{notification}` (the full row: a group grew — `count`, `title`, `body`, `updated_at`, `source_event_id` changed — or it was read/dismissed; clients upsert by `notification_id` and re-position by `updated_at`) |
| `logs` | `log.record` `{record}` (droppable, live only) |
| `screencast:<id>` | `meta`, `started`, `stopped`, `failed {code}` |

Every event is produced by the app-level event bus (01 §5); the hub only maps bus events to topics.

### 6.7 Live view

`LiveView` (`interface/ws/live-view.ts`) keeps one CDP bridge per session, created lazily on the first `screencast.start`: `Page.startScreencast {format:'jpeg', quality, maxWidth, maxHeight, everyNthFrame:1}` where `maxWidth/maxHeight` are the **largest** requested by any viewer and `quality` defaults to 70 (`--screencastQuality`). Each `Page.screencastFrame` is acked and fanned out.

- **Serialisation.** Join, leave, resize, the grace stop, tab retarget and session close for one session run on one queue (`KeyedSerial`); `removeViewer` never rejects and `screencast.stop` awaits it.
- **Join.** A viewer is registered only after its start succeeds; a failed start removes it, tears the bridge down and throws `SCREENCAST_FAILED`; the next start opens a fresh bridge. On the wire the reply and `started` go out first, then `meta`, then a frame; meta is tracked per viewer, so every viewer gets `meta` before its first frame. A viewer joining a running stream gets `meta` and the last frame immediately, with no restart.
- **First frame.** After every (re)start (first join, `set_size`, a leave that shrinks the size, tab retarget) and whenever no frame exists yet, `captureFrame(quality)` (`Page.getLayoutMetrics` + `Page.captureScreenshot {format:'jpeg', quality}`, metadata from `cssVisualViewport`) pushes `meta` + a frame with a real header, so a static page is never blank. The capture is discarded if a real screencast frame arrived first and abandoned after `INITIAL_FRAME_TIMEOUT_MS` = 3 s; it runs outside the session queue.
- **Resize.** A size change on a running stream is `Page.stopScreencast` then `Page.startScreencast` (Chromium refuses a second start); the bridge records the new size only after success. A CDP failure becomes `SCREENCAST_FAILED`, tears the bridge down and sends every viewer of that stream `failed {code:'SCREENCAST_FAILED', message}`, after which the server has dropped them and clients send a fresh `screencast.start`.
- **Tab follow.** Each bridge records its `tabId` and subscribes to `TabRegistry.onActiveChange` (fires on `switch_tab`, `new_tab`, the active tab closing and the first tab). On a change it re-targets inside the session queue: tear down the old CDP session, open one on the active page, carry the viewers over (same ordinal, `seq` continues), restart at the same size, re-send `meta` and prime a frame. With no viewers it only tears down. Operator input goes to the active tab. If the last tab closes, the bridge stays on the dead page until the session closes.
- **Teardown.** The last viewer leaving stops the screencast and detaches after a 5 s grace (`SCREENCAST_GRACE_MS`, re-checked inside the queue). Bridges are torn down on session close. `LiveView` logs `screencast failed` at `warn` with the CDP error when it tears a stream down. After an accepted mouse input the humanize cursor tracker is resynced. If the session is `crashed`/`closed`, viewers receive `stopped {reason}`.

---

## 7. Data model (schema v2)

All tables in `browserhive.db` (D-24). Conventions: `TEXT` ids, epoch-ms `INTEGER` columns suffixed `_at`/`_ts`, durations `_ms`, sizes `_bytes`, booleans `INTEGER CHECK IN (0,1)`, enums `TEXT CHECK (col IN (...))` generated from `contracts/enums`, every `session_id` FK `ON DELETE CASCADE`. `WITHOUT ROWID` on tables with a TEXT primary key that are never scanned in insertion order.

```sql
-- infrastructure
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, app_version TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;   -- min_reader_version, instance_id, created_at

-- identity
CREATE TABLE principals (principal_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('operator','agent','service')), display TEXT NOT NULL, tenant_id TEXT, must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disabled_at INTEGER) WITHOUT ROWID;
CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('password','api_token')), public_prefix TEXT, secret_hash TEXT NOT NULL, display TEXT, scopes_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER) WITHOUT ROWID;
CREATE INDEX idx_credentials_prefix ON credentials(public_prefix) WHERE revoked_at IS NULL;
CREATE INDEX idx_credentials_principal ON credentials(principal_id);
CREATE TABLE auth_sessions (auth_session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_agent TEXT, ip TEXT, revoked_at INTEGER) WITHOUT ROWID;
CREATE INDEX idx_auth_sessions_principal ON auth_sessions(principal_id) WHERE revoked_at IS NULL;
CREATE TABLE grants (grant_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, auth_session_id TEXT NOT NULL REFERENCES auth_sessions(auth_session_id) ON DELETE CASCADE, route TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) WITHOUT ROWID;
CREATE TABLE auth_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL CHECK (type IN ('login_success','login_failure','lockout','logout','password_changed','token_issued','token_revoked','grant_issued','session_revoked','unauthorized')), principal_id TEXT, ip TEXT, user_agent TEXT, details_json TEXT, occurred_at INTEGER NOT NULL);
CREATE INDEX idx_auth_events_time ON auth_events(occurred_at);

-- mcp client metadata (self-reported; never for access control)
CREATE TABLE mcp_connections (connection_id TEXT PRIMARY KEY, principal_id TEXT, transport TEXT NOT NULL CHECK (transport IN ('http','stdio')), mcp_session_id TEXT, client_name TEXT, client_version TEXT, protocol_version TEXT, capabilities_json TEXT, agent_name TEXT, model TEXT, harness TEXT, ip TEXT, user_agent TEXT, connected_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, closed_at INTEGER) WITHOUT ROWID;
CREATE INDEX idx_mcp_connections_open ON mcp_connections(last_seen_at) WHERE closed_at IS NULL;

-- sessions (state table)
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, slug TEXT NOT NULL, owner TEXT NOT NULL, tenant_id TEXT, connection_id TEXT REFERENCES mcp_connections(connection_id) ON DELETE SET NULL,
  engine TEXT NOT NULL DEFAULT 'chromium' CHECK (engine IN ('chromium')), channel TEXT NOT NULL CHECK (channel IN ('chromium','chrome','edge')),
  headless INTEGER NOT NULL CHECK (headless IN (0,1)), incognito INTEGER NOT NULL DEFAULT 0, persistence_mode TEXT NOT NULL CHECK (persistence_mode IN ('memory','persistent','storage-state')),
  disable_evaluate INTEGER NOT NULL DEFAULT 0, vault_enabled INTEGER NOT NULL DEFAULT 1,
  stealth INTEGER NOT NULL, fingerprint INTEGER NOT NULL, humanize INTEGER NOT NULL, identity_json TEXT, proxy_label TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','launching','live','paused','draining','closed','crashed')),
  created_at INTEGER NOT NULL, launched_at INTEGER, last_activity_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL, lease_paused_at INTEGER,
  closed_at INTEGER, closed_reason TEXT CHECK (closed_reason IN ('user','operator','lease_expired','crash','shutdown','interrupted','launch_failed')),
  archived_at INTEGER, last_url TEXT, launch_ms INTEGER, config_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_sessions_open ON sessions(state) WHERE closed_at IS NULL;
CREATE INDEX idx_sessions_owner ON sessions(owner, created_at);
CREATE INDEX idx_sessions_created ON sessions(created_at, session_id);
CREATE INDEX idx_sessions_closed ON sessions(closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX idx_sessions_archived ON sessions(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX idx_sessions_lease ON sessions(lease_expires_at) WHERE closed_at IS NULL;

-- ordered event log (feed replay, audit, export). Small payloads; typed tables hold the detail.
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE, actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','operator','system')), actor_id TEXT, occurred_at INTEGER NOT NULL, trace_id TEXT, payload_json TEXT NOT NULL);
CREATE INDEX idx_events_session ON events(session_id, seq);
CREATE INDEX idx_events_type_time ON events(type, occurred_at);
CREATE INDEX idx_events_time ON events(occurred_at);

-- typed fact tables
CREATE TABLE tool_calls (event_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE, connection_id TEXT, tool TEXT NOT NULL, tab_id TEXT, args_json TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok IN (0,1)), error_code TEXT, error_message TEXT, result_text TEXT, result_size_bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL, ts INTEGER NOT NULL, trace_id TEXT, span_id TEXT, seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_tool_calls_session_ts ON tool_calls(session_id, ts, event_id);
CREATE INDEX idx_tool_calls_ts ON tool_calls(ts, event_id);
CREATE INDEX idx_tool_calls_tool_ts ON tool_calls(tool, ts);
CREATE INDEX idx_tool_calls_error ON tool_calls(error_code, ts) WHERE error_code IS NOT NULL;
CREATE TABLE pages (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, tab_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT, domain TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('public','ip','local','ftp','other')), ts INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_pages_session_ts ON pages(session_id, ts, event_id);
CREATE INDEX idx_pages_ts ON pages(ts, event_id);
CREATE INDEX idx_pages_domain ON pages(domain, ts);
CREATE INDEX idx_pages_category_ts ON pages(category, ts);
CREATE TABLE screenshots (event_id TEXT PRIMARY KEY REFERENCES tool_calls(event_id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('tool','trace')), content_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, size_bytes INTEGER NOT NULL, ts INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_screenshots_session ON screenshots(session_id, ts);
CREATE TABLE vault_access (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, tool_event_id TEXT, entry_name TEXT NOT NULL, handle TEXT, result TEXT NOT NULL CHECK (result IN ('success','origin_mismatch','auth_failed','blocked','denied')), reason TEXT, evaluate_enabled INTEGER NOT NULL, page_url TEXT NOT NULL, origin_check TEXT NOT NULL CHECK (origin_check IN ('pass','fail','skipped')), principal_id TEXT, details_json TEXT, ts INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_vault_access_ts ON vault_access(ts, event_id);
CREATE INDEX idx_vault_access_session ON vault_access(session_id, ts);
CREATE INDEX idx_vault_access_entry ON vault_access(entry_name, ts);
CREATE TABLE blocked_requests (event_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE, tool_event_id TEXT, url TEXT NOT NULL, domain TEXT, pattern TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('tool','request')), tool TEXT, ts INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_blocked_ts ON blocked_requests(ts, event_id);
CREATE INDEX idx_blocked_session ON blocked_requests(session_id, ts);
CREATE INDEX idx_blocked_pattern ON blocked_requests(pattern, ts);
CREATE INDEX idx_blocked_domain ON blocked_requests(domain, ts);

-- operator requests (attention + vault confirm), state table
CREATE TABLE operator_requests (request_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('attention','vault_confirm')), session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, owner TEXT NOT NULL, reason TEXT NOT NULL, mode TEXT CHECK (mode IN ('takeover','notify')), entry_name TEXT, tool TEXT, tool_event_id TEXT, page_url TEXT, options_json TEXT, idempotency_key TEXT, status TEXT NOT NULL CHECK (status IN ('pending','resolved','rejected','timeout','cancelled')), message TEXT, resolved_by TEXT, resolution_reason TEXT, created_at INTEGER NOT NULL, deadline_at INTEGER, resolved_at INTEGER) WITHOUT ROWID;
CREATE INDEX idx_operator_requests_open ON operator_requests(kind, created_at) WHERE status = 'pending';
CREATE INDEX idx_operator_requests_session ON operator_requests(session_id, created_at);
CREATE INDEX idx_operator_requests_history ON operator_requests(kind, created_at, request_id) WHERE status <> 'pending';
CREATE UNIQUE INDEX idx_operator_requests_idem ON operator_requests(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE operator_actions (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, action TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT, details_json TEXT, occurred_at INTEGER NOT NULL);   -- terminate, archive, delete, resolve, binding edits, blocklist reload, input bursts
CREATE INDEX idx_operator_actions_time ON operator_actions(occurred_at);

-- vault policy
CREATE TABLE vault_bindings (handle TEXT PRIMARY KEY, tenant_id TEXT, title TEXT NOT NULL, item_name TEXT NOT NULL, item_id TEXT NOT NULL DEFAULT '', group_id TEXT, allowed_origins_json TEXT NOT NULL DEFAULT '[]', authorized_principals_json TEXT NOT NULL DEFAULT '[]', authorized_session_slugs_json TEXT NOT NULL DEFAULT '[]', allow_all_sessions INTEGER NOT NULL DEFAULT 0, redact_username INTEGER NOT NULL DEFAULT 0, require_no_evaluate INTEGER NOT NULL DEFAULT 0, dashboard_confirm INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idx_vault_bindings_group ON vault_bindings(group_id);
CREATE TABLE vault_group_policies (group_key TEXT PRIMARY KEY, group_id TEXT, tenant_id TEXT, access_mode TEXT NOT NULL CHECK (access_mode IN ('manual','allow_all','reject_all')), allow_all_sessions INTEGER NOT NULL DEFAULT 0, session_slug_globs_json TEXT NOT NULL DEFAULT '[]', authorized_principals_json TEXT NOT NULL DEFAULT '[]', dashboard_confirm INTEGER NOT NULL DEFAULT 0, require_no_evaluate INTEGER NOT NULL DEFAULT 0, redact_username INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;   -- group_key = group_id or '__ungrouped__'

-- notifications, preferences
CREATE TABLE notifications (notification_id TEXT PRIMARY KEY, principal_id TEXT, type TEXT NOT NULL CHECK (type IN ('attention','error','vault','lifecycle','system')), title TEXT NOT NULL, body TEXT, session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL, target TEXT, source_event_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER, dismissed_at INTEGER) WITHOUT ROWID;
CREATE INDEX idx_notifications_inbox ON notifications(principal_id, created_at) WHERE dismissed_at IS NULL;
-- v2 (0002-notification-groups)
ALTER TABLE notifications ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;   -- backfilled from created_at
ALTER TABLE notifications ADD COLUMN count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1);
ALTER TABLE notifications ADD COLUMN group_key TEXT;                          -- e.g. tool-errors:<session_id|none>
CREATE INDEX idx_notifications_updated ON notifications(principal_id, updated_at) WHERE dismissed_at IS NULL;
CREATE INDEX idx_notifications_group ON notifications(group_key, updated_at) WHERE group_key IS NOT NULL AND read_at IS NULL AND dismissed_at IS NULL;
CREATE TABLE preferences (principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (principal_id, key)) WITHOUT ROWID;

-- operations
CREATE TABLE system_events (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, code TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info','warn','error')), message TEXT NOT NULL, details_json TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, resolved_at INTEGER);
CREATE INDEX idx_system_events_open ON system_events(code) WHERE resolved_at IS NULL;
CREATE TABLE artifact_outbox (outbox_id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('trace','screenshot','session_dir','backup')), path TEXT NOT NULL, session_id TEXT, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, route TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
-- created in v1 ahead of use: logs (written only by the optional `--logPersist` durable sink), resource_samples (no writer yet; pruned by retention)
-- reserved names, NOT created: proxies, profiles, security_rules, extensions, notification_channels — the migration of the feature that needs one creates it (and may pick another name)
CREATE TABLE logs (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, module TEXT NOT NULL, msg TEXT NOT NULL, trace_id TEXT, span_id TEXT, request_id TEXT, session_id TEXT, principal TEXT, fields_json TEXT);
CREATE INDEX idx_logs_ts ON logs(ts); CREATE INDEX idx_logs_trace ON logs(trace_id) WHERE trace_id IS NOT NULL; CREATE INDEX idx_logs_session ON logs(session_id, ts) WHERE session_id IS NOT NULL;
CREATE TABLE resource_samples (ts INTEGER NOT NULL, session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE, cpu_pct REAL, rss_bytes INTEGER, host_free_bytes INTEGER, PRIMARY KEY (ts, session_id)) WITHOUT ROWID;
```

`meta.min_reader_version = 1`. Migration v1 (`0001-initial`) creates everything above except the v2 lines; migration v2 (`0002-notification-groups`, `compatible: true`, so the min reader stays 1) adds the notification grouping columns and indexes. The runner writes a backup before migrating. A dedicated CI test asserts fresh == migrated (D-04); fixtures `v1.db` and `v2.db` upgrade to head, and the golden is `schema-v2.json`.

### 7.1 Retention classes

| Class | Tables / artifacts | Rule (defaults) |
|---|---|---|
| telemetry | `events`, `tool_calls`, `pages`, `screenshots` (+ files), `resource_samples`, `logs` | `retentionDays` (7) and `retentionBytes` (1 GiB) over the DB + screenshot files; oldest first |
| audit | `vault_access`, `blocked_requests`, `auth_events`, `operator_actions`, `operator_requests` (terminal) | `auditRetentionDays` (90); never byte-pruned |
| sessions | `sessions` rows | deleted only when all children are gone and `closed_at < now - retentionDays`; **archived sessions exempt** |
| artifacts | `trace.zip`, `sessions/<id>/`, downloads | follow their session; deletion via `artifact_outbox` (row delete and outbox insert in one transaction; sweeper unlinks with retries; orphan scan weekly) |
| connections | `mcp_connections` | closed rows with `closed_at < now - retentionDays` that no remaining `sessions` row references (a session keeps its client metadata as long as it lives, archived ones included); open rows never |
| notifications | `notifications` | 30 d after `dismissed_at`/`read_at`, 90 d otherwise |
| backups | `backups/*.db` | keep last 5 |

`retentionDays` must be ≥ 1 (`0` is rejected at config time, see 08 — "keep forever" is expressed by the per-class exemptions below and a large value). The sweep runs every 6 h (`retentionIntervalMs`), catches per-item failures, records a `system.degraded` on repeated failure, never throws, and never runs `VACUUM`: the DB is opened with `auto_vacuum=INCREMENTAL` and the sweep issues `PRAGMA incremental_vacuum(N)` in bounded chunks. `/system.retention` exposes the last run.

### 7.2 Ports (signatures abbreviated)

```ts
interface SessionRepository { insert(row); update(id, patch); get(id); list(query): Promise<Page<SessionListRow>>; facets(query); markClosed(id, at, reason); archive(id, at); unarchive(id); delete(id): Promise<{rows, paths}>; reconcileOpen(at, reason); }
interface ToolCallRepository { insert(row); get(eventId); listBySession(id, query); listAll(query /* hasSession? */); }
interface PageRepository { insert(row); list(query); facets(query): {categories}; recent(limit); topDomains(query); }
interface ScreenshotRepository { insert(row); get(eventId); listBySession(id, query); }
interface VaultAuditRepository { insert(row); list(query); }
interface BlocklistAuditRepository { insert(row); list(query); stats(query); }
interface OperatorRequestRepository { insert(row); resolve(id, status, at, message, by, reason); open(kind?); get(id); listHistory(query); facets(query): {status, mode}; }
interface EventLogRepository { append(event); replay(afterSeq, limit); }
interface PrincipalRepository / CredentialRepository / AuthSessionRepository / GrantRepository / AuthEventRepository
interface VaultBindingRepository { list(query); get(handle); upsert(binding, ifVersion?); remove(handle); exportAll(); importAll(doc, mode); }
interface VaultGroupPolicyRepository { list(); get(groupKey); upsert(policy, ifVersion?); }
interface NotificationRepository { …; list(query /* sort: updated_at|created_at */); findOpenGroup(principalId, groupKey); updateGroup(id, patch /* applies only while unread and undismissed */); }
interface PreferenceRepository / SystemEventRepository / IdempotencyRepository / ArtifactOutboxRepository / McpConnectionRepository
interface UnitOfWork { transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>; }
interface AnalyticsQueries { activity(query); toolMetrics(query); timeline(sessionId, query); summary(now, window); databaseSize(); }
interface MaintenanceService { migrate(); backup(): Promise<path>; retentionSweep(); incrementalVacuum(); inventory(): Promise<PurgeInventory>; integrityCheck(); }
```

Writes are enqueued (FIFO, one transaction per drain, statements prepared once); reads drain first. `dropped_writes_total` counts enqueue failures after close or on constraint violations (which are logged, never swallowed silently).

---

## 8. Static serving

- Hashed assets (`/assets/*`): `Cache-Control: public, max-age=31536000, immutable`, `ETag`, gzip/brotli pre-compressed variants served when accepted.
- `index.html`: templated per request (CSP nonce, `<meta name="browserhive-version">`), `Cache-Control: no-cache`, `ETag`.
- SPA fallback: any GET not matching `/api`, `/mcp`, `/health`, `/trace-viewer`, or an existing asset returns `index.html`, including paths with dots (route parameters such as URLs or domains may contain them, so a dot is never taken to mean "file").
- Source maps are not shipped in the package (`dashboard` build emits none for production).
- Without `admin=true`, `/` returns a small server-rendered status page (version, transport, MCP URL, how to enable the dashboard) and every dashboard route 404s.
- The daemon has no development mode for the dashboard: in a source checkout, hot reload comes from a Vite dev server in front of the daemon that proxies API paths to it (06 §2.1).
- Trace viewer: `playwright-core`'s `lib/vite/traceViewer` located at startup; served under `/trace-viewer/` behind operator auth with the sandboxed CSP; `/trace-viewer/ping` answers `ok`. The viewer loads `trace.zip` through a grant token because its service worker cannot send the cookie.

---

## 9. Notifications (D-16)

Producer (`app/notifications`) subscribes to the bus and writes every row to **one shared operator inbox** (`principal_id` NULL): v1 has a single operator, the list, unread count and read/dismiss routes are not filtered by principal, and per-operator inboxes wait for multi-user (D-25). `NotificationService`'s `recipients` hook (default `[null]`) is the seam they plug into; composition does not set it. Rows:

| Bus event | Notification |
|---|---|
| `attention.created` | type `attention`, title "Attention requested", body "{reason} · {mode} — agent blocked, lease frozen", target `/sessions/{id}?tab=live` (the dashboard redirects it to `?live=1`) |
| `session.closed` with reason `crash` | type `error`, "Session crashed", target `/sessions/{id}` |
| `tool.called` with `ok=false` | type `error`, **grouped per session** (below): title "{slug} · 1 tool error" / "{slug} · {n} tool errors", body "{tool} · {error_code} ({duration_ms} ms)" (or "{tool} · failed (…)"), `source_event_id` = latest failing call, target `/sessions/{id}?kinds=tool&errors_only=1` |
| `vault.confirm.created` | type `vault`, "Vault fill awaiting confirm", target `/vault?tab=confirm` |
| `session.closed` with `lease_expired` | type `lifecycle`, "Session reaped (lease expired)" |
| `system.degraded` (severity error) | type `system`, message |

**Tool-error grouping** (`app/notifications/producers.ts`): group key `tool-errors:<session_id>`. A new failure grows the existing row of its group when that row is unread, not dismissed, its `updated_at` is < 5 min ago (`NOTIFICATION_GROUP_IDLE_MS`) and its `created_at` is < 60 min ago (`NOTIFICATION_GROUP_MAX_AGE_MS`): `count` +1, `title`, `body`, `updated_at` and `source_event_id` follow the latest occurrence, and `notification.updated` carries the full row. Otherwise a new row (`count` 1) is created with `notification.created`. Marking read or dismissing therefore starts a fresh group, and a failure run longer than an hour resurfaces hourly. Session-less failures: a caller mistake (an error code with `retryable: 'different_args'`, e.g. `INVALID_ARGUMENTS`, `SESSION_NOT_FOUND`) produces no notification; any other (e.g. `launch_session` → `BROWSER_NOT_INSTALLED`) is grouped under "No session · {n} tool errors" with `session_id`, `session_slug` and `target` null. External `NotificationChannel`s receive created rows only. Every row carries `session_slug` when it has a session.

Deliberately silent: `session.opened`, `page.visited`, `session.removed`, `attention.resolved`, `vault.confirm.resolved`. Rows are broadcast on the `notifications` topic; read/dismiss state is server-side and survives reloads. External channels are a `NotificationChannel` port (`send(payload)`) with no implementations.

---

## 10. Design notes

- `POST /sessions/{id}/input` exists so takeover can be scripted without a WebSocket client; it shares the attention gate and audit path with the WS `input` command.
- Operator requests are exposed as two resource views (`/attention`, `/vault/confirm`) over one table. A combined `/operator-requests` endpoint was considered and rejected: it would be a third view of the same rows with no consumer.
- `mcp_connections` records what the transport and `initialize` reveal (headers, `User-Agent`, `clientInfo`, protocol version, capabilities; see 02 §1.4). An explicit client-metadata tool is not added, because the tool catalog is a stable contract (D-12) and self-reported metadata is dashboard-only anyway.
- The session cookie uses `Path=/` because the dashboard and the API share the origin root.
