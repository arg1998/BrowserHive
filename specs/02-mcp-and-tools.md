---
title: "MCP server and tools"
spec: "02"
status: Normative
scope: The MCP server (identity, transports, authentication, client metadata), the declarative tool layer and its dispatcher, the stable catalog of 43 tools, the attention, auth-state and humanize models as agents see them, contract goldens, and the programmatic API.
audience: Contributors implementing or changing the MCP layer and tools; authors of MCP clients and agents; reviewers of tool-contract changes.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
  - 03-admin-backend.md
  - 10-error-handling-and-telemetry.md
  - 11-stealth.md
---

# 02 — MCP API Surface, Tool Definitions and Contracts

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: the MCP server (transports, auth, capabilities), the declarative tool layer and dispatcher, and the **frozen catalog of 43 tools**. Decisions: D-02 (single port, official SDK), D-05 (contracts, snake_case wire), D-07 (error registry), D-08 (telemetry), D-09 (principals), D-12 (stable tool contract), D-15 (operator requests).

The stability contract of this spec: **an agent that works against a release of BrowserHive MUST keep working, unchanged, against every later release with the same major version.** Names, parameter names, defaults, enums, result shapes and error codes are contract; changes are additive (D-12).

---

## 1. MCP server

### 1.1 Identity and capabilities

- `serverInfo`: `{ name: 'browserhive', version: <generated version.ts> }`. `name` is overridable only through the programmatic API (`createServer({ name })`) for embedders.
- Capabilities advertised: `tools: { listChanged: true }` (the list can change when a pack is enabled at runtime; today it only differs by configuration at boot), `logging: {}` (server → client `notifications/message`, level-gated per client, off by default), `completions` not advertised, `resources`/`prompts` **not** advertised (BrowserHive has none; adding them later is additive).
- `instructions`: a short server-level instruction string: what BrowserHive is, that `launch_session` must precede page tools, that `request_attention` blocks, and the min-attention-wait floor when configured.
- Protocol: whatever the pinned `@modelcontextprotocol/sdk` negotiates (2025-06-18 at the time of writing). The SDK is pinned exactly; upgrades are deliberate PRs with the tool goldens re-checked.

### 1.2 Transports

**Streamable HTTP (default, `transport=http`).** `WebStandardStreamableHTTPServerTransport` from the SDK (or `@hono/mcp`'s `StreamableHTTPTransport`, which wraps it) mounted in the Hono app at `/mcp` (`POST` requests, `GET` standalone SSE stream, `DELETE` session end). Options:

| Option | Value | Why |
|---|---|---|
| `sessionIdGenerator` | `() => 'm-' + nanoid(16)` | stateful sessions so a client can hold a standalone SSE stream and resume |
| `onsessioninitialized(id)` | creates a `connections` record (§1.4) | client metadata, dashboard "connected clients" |
| `onsessionclosed(id)` | marks the record closed; cancels open attention requests owned by that MCP session **only if** the principal has no other live MCP session (agents reconnect) | see §5 |
| `enableDnsRebindingProtection` | **off**; `handleMcpRequest` applies the dashboard's Host policy instead (`isHostAllowed`, 03 §2: loopback names and the bound host on any port, `allowedHosts`, and IP literals under a wildcard bind), answering a foreign Host with 403 `Invalid Host header` | the SDK's check matches `host:port` exactly, which rejected every request behind a port mapping or SSH tunnel while the dashboard kept working |
| `allowedOrigins` | empty (non-browser clients); browser-origin MCP clients are out of scope | |
| `keepAliveMs` | 25 000 | under the common 30 s idle proxies cut |
| `enableJsonResponse` | `false` (SSE responses) | progress notifications for `request_attention` and `type_text` need a stream |
| `eventStore` | in-memory ring per stream, bounded (256 events / 1 MiB), for `Last-Event-ID` resumption | reconnect during a long `request_attention` |

Bun's per-connection idle timeout (default 10 s) is lifted for every authenticated `/mcp` request (`disableIdleTimeout`, 03 §2): the 25 s keep-alive and progress heartbeats are slower than 10 s, so without it Bun would cut the SSE stream of a blocked `request_attention` / confirm-gated `vault_fill` / `get_attention_result`, the SDK client would give up after its resumption attempts, and the result would never be delivered. Covered by `packages/browserhive/test/integration/attention-http.test.ts` (a 40 s wait, then a REST resolve).

One `McpServer` instance and one transport are created **per MCP session** (the SDK binds exactly one transport to a server instance) and kept in a map keyed by session id; the tool registry, dispatcher and services behind them are shared. The Hono route looks up or creates the pair from the `mcp-session-id` header.

**stdio (`transport=stdio`).** `StdioServerTransport`. No HTTP listener at all. stdout is the protocol stream; every log line, banner and warning goes to stderr unconditionally. Attention tools return `ATTENTION_REQUIRES_HTTP`; vault works except `dashboard_confirm` entries (auto-deny). One principal, `local`.

Never both in one process (D-02).

### 1.3 Authentication on `/mcp`

The MCP route runs the same `AuthenticationProvider` chain as the admin API (D-09), restricted to the `bearer-token` provider:

- `auth=off` (default; loopback only): no header required; principal is `{ subject: 'local', kind: 'agent' }`.
- `auth=token`: `Authorization: Bearer <token>` required on **every** request (initialize included). Missing or unknown token → HTTP `401` with `WWW-Authenticate: Bearer realm="browserhive"` and a problem+json body; the SDK never sees the request. A valid token yields `{ subject: <token principal>, kind: 'agent', scopes: ['mcp:*'] }` passed to the transport as `authInfo`; the dispatcher reads it from `extra.authInfo`.
- Tokens: stored hashed (SHA-256 with a public 8-char prefix for lookup, constant-time compare on the hash) in `credentials` (kind `api_token`), seeded on first start for principal `agent-1` (32 random bytes, base64url), printed once. `BROWSERHIVE_AUTH_TOKENS=name:token,…` merges ephemeral tokens (never persisted). Revocation/expiry via `browserhive admin tokens` and the dashboard (System page).
- Non-loopback `host` without `auth=token` is refused at config time unless `allowInsecureBind=true`.

### 1.4 Principals, MCP sessions and client metadata

Ownership is keyed on the **principal**, never on `Mcp-Session-Id`: a reconnecting client (new MCP session, same token) keeps its browser sessions. Under `auth=off` everything is owned by `local`.

Each MCP session gets a row in `mcp_connections` (DDL in 03 §7: `connection_id`, `principal_id`, `transport`, `mcp_session_id`, `client_name`, `client_version`, `protocol_version`, `capabilities_json`, `agent_name`, `model`, `harness`, `ip`, `user_agent`, `connected_at`, `last_seen_at`, `closed_at`). What fills it:

- `initialize`, both transports: `clientInfo.name`/`version` and `capabilities` (the SDK's record of the handshake). HTTP also stores `protocolVersion`; stdio writes the row at startup and fills these in when `initialize` arrives.
- HTTP only: `User-Agent`, and three optional headers, one column each — `X-BH-Agent-Harness` → `harness`, `X-BH-Agent-Model` → `model`, `X-BH-Workspace` → `agent_name`. A blank header counts as absent.
- `ip` is reserved and always `null` today; `clientInfo.title` and other `initialize` `_meta` are not read.

Browser sessions record `connection_id` at creation and carry that connection's client (`name`, `version`, `agent_name`, `model`) as `SessionSummary.client` (03 §4.2), fixed at launch; `harness` is recorded but not surfaced yet. All of it is **self-reported, dashboard-only, never used for access control**. Per-call `_meta` contributes only tracing: a W3C `traceparent` (or a bare 32-hex id under `browserhive.ai/traceId` or `traceId`) is adopted as the parent of the tool span (D-08); other keys are ignored.

## 2. Tool definitions

### 2.1 `ToolDefinition<I, O>`

Every tool is one exported constant in `core/src/interface/mcp/tools/<pack>/<tool>.ts` built with a helper that types the handler from the zod schemas:

```ts
interface ToolDefinition<I extends z.ZodObject | undefined, O extends z.ZodType> {
  name: ToolName;                       // frozen union from contracts
  title: string;                        // human title (annotation)
  description: string | ((runtime: RuntimeFacts) => string); // request_attention is dynamic
  input?: I;                            // omitted ⇒ registered without a schema (3 argument-less tools, §3)
  output: O;                            // → outputSchema + structuredContent (additive)
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  capability: 'read' | 'mutate' | 'navigate' | 'credential' | 'attention' | 'lifecycle';
  requires?: { transport?: 'http'; vault?: true };             // TOOL_NOT_AVAILABLE / ATTENTION_REQUIRES_HTTP / VAULT_NOT_CONFIGURED (see §2.4)
  policies: ToolPolicy[];               // e.g. sessionOwnership, urlBlocklist('url'), evaluateAllowed, sandboxPath('save_path')
  telemetry: { captureArgs: 'full' | 'shape' | 'none'; captureResult: 'full' | 'size' | 'none' };
  errors: ErrorCode[];                  // documented codes; the dispatcher may add INTERNAL_ERROR
  since: string;                        // semver of first appearance ('0.1.0' for all 43)
  handler: (ctx: ToolCallContext, args: z.infer<I>) => Promise<ToolResult<z.infer<O>>>;
}
```

`ToolResult` is either `{ kind: 'json', value }` (serialized with `JSON.stringify(value ?? null)` as one `text` block, plus `structuredContent` for object outputs; bare-array outputs such as `list_tabs` are text only, because MCP `structuredContent` must be an object) or `{ kind: 'content', content: ContentBlock[] , structured?: object }` (only `screenshot`). Schemas come from `@browserhive/contracts/tools`; the MCP `inputSchema` is produced by the SDK's zod-4 path. Constraint: every input is a flat `z.object` (or `looseObject`) — **never a union at the top level** — because strict clients reject `oneOf`/`anyOf` roots.

`ToolPack` = `{ id, tools: ToolDefinition[], requires?: { transport?, vault?, admin? } }`. Packs: `lifecycle`, `introspection`, `navigation`, `tabs`, `interaction`, `inspection`, `waits`, `dialogs`, `state`, `files`, `authStates`, `attention`, `vault`. The registry is the single list; `ALL_TOOL_NAMES` is derived from it and pinned by the wiring test and the golden (§8). No other hand-maintained name list may exist (the recorder asks the definition for `capability === 'navigate'` instead of a `NAVIGATION_TOOLS` array).

### 2.2 `ToolCallContext`

```ts
interface ToolCallContext {
  principal: RequestPrincipal;         // from authInfo or LOCAL
  connectionId: string | null;         // MCP session's connection record
  request: RequestContext;             // trace_id, span_id, request_id (AsyncLocalStorage, D-08)
  eventId: string;                     // 'e-<ulid>', minted before the handler; used by screenshot archival
  reportProgress: (p: { progress: number; total?: number; message?: string }) => Promise<void>;
  signal: AbortSignal;                 // aborted on notifications/cancelled or transport close
  log: (level, msg, fields?) => void;  // child logger bound to tool/session/event ids
  services: { sessions; attention; vault; authStates; blocklist; runtime };
}
```

`eventId` is passed explicitly as a field of the context, so a handler never needs to reach into SDK internals to correlate its artefacts with the observation.

### 2.3 Dispatcher pipeline

One function wraps every tool; nothing registers with the SDK directly.

```
resolve(name)             → TOOL_NOT_AVAILABLE if the pack is disabled by configuration
mint eventId, open span "mcp.tool <name>" (parent from _meta traceparent)
parse(args)               → INVALID_ARGUMENTS  (zod issues in details; text = "[INVALID_ARGUMENTS] <first issue path>: <message>")
authorize(principal)      → ownership via sessions.get(session_id, principal) for every tool that names a session
policies                  → URL_BLOCKED, EVALUATE_DISABLED, PATH_NOT_ALLOWED, UNSAFE_LAUNCH_ARG … (thrown before touching the browser)
execute(handler)          → ToolResult
map error                 → AppError (registry code) — unknown errors become INTERNAL_ERROR with a private cause
classify outcome          → soft failures for tools that *return* failure (vault_fill status≠success, attention rejected/timeout/cancelled, navigate HTTP 4xx/5xx) get a synthetic audit code (fixed set: ORIGIN_MISMATCH, VAULT_FILL_AUTH_FAILED, VAULT_FILL_BLOCKED, VAULT_LIST_DENIED, ATTENTION_REJECTED, ATTENTION_TIMEOUT, ATTENTION_CANCELLED, HTTP_<n>)
shape response            → text block(s) + structuredContent; redaction scrub on both
observe                   → exactly one ToolInvocation to the recorder, in `finally`
```

Invariants:
- **Every terminal outcome emits exactly one observation**, including `TOOL_NOT_AVAILABLE`, `INVALID_ARGUMENTS` and authorization failures, so the audit trail shows calls that never reached a handler. Observation carries `{ eventId, tool, sessionId, tabId, args (per capture policy, key-redacted), ok, errorCode, errorMessage (redacted), resultText (capped 16 KiB, redacted), resultSize, durationMs, ts, principal, connectionId, traceId }`.
- The observer can never alter the result (errors inside `observe` are logged, never rethrown).
- `sessions.get(id, principal)` is the only ownership check; it also resets the sliding lease and stamps `last_tool_at`. `SESSION_ACCESS_DENIED` carries the byte-identical message of `SESSION_NOT_FOUND`, so a foreign session is indistinguishable from an unknown one.
- Redaction (`vault.redaction.scrub(sessionId, text)` + key-based `redactKeys`) is applied to the text block and to `structuredContent` (walked as strings) before the response leaves the dispatcher. Image blocks are not scrubbed (documented).

### 2.4 Error shaping

User-visible errors are returned as an MCP tool result with `isError: true`, one `text` block `"[CODE] message"` (the text format agents parse, stable under D-12), and the structured error `{ code, message, retryable, hint?, details? }` from the registry in `_meta['browserhive.ai/error']` (D-07). The structured error is **not** placed in `structuredContent`: the SDK client validates any `structuredContent` against the tool's `outputSchema`, error results included, so it would turn every tool error into a client-side protocol exception. Successful results carry `structuredContent`. Protocol-level JSON-RPC errors are used only for unknown tool names and malformed requests (SDK behavior).

## 3. Frozen tool catalog

Conventions: `Timeout` = `int ≥ 0, default 30000` ms (`0` = no timeout); `TabId` = optional string, omitted ⇒ active tab, unknown ⇒ `TAB_NOT_FOUND`; `Selector` = non-empty string; `WaitUntil` = `load|domcontentloaded|networkidle|commit`. "Session errors" = `SESSION_NOT_FOUND`, `SESSION_DEAD`, `SESSION_ACCESS_DENIED` (only under `auth=token`). Annotation columns: **RO** readOnlyHint, **D** destructiveHint, **I** idempotentHint, **OW** openWorldHint. All results are JSON text (+ `structuredContent`) unless stated.

### 3.1 Lifecycle

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `launch_session` | `slug: string` (regex `^[a-z][a-z0-9-]{1,31}$`, message `slug must match /^[a-z][a-z0-9-]{1,31}$/`) · `channel: enum(chromium,chrome,edge)` default **server `defaultChannel`** · `incognito: boolean=false` (adds `--incognito` for chrome/edge only) · `headless: boolean` default **server `defaultHeadless`** · `persistence_mode?: enum(memory,persistent,storage-state)` (omit ⇒ server `persistence`) · `restore_profile?: string` (needs `persistent`) · `launch_options?: looseObject{ args?: string[], executablePath?: string, …passthrough }` · `context_options?: looseObject{}` (string `storageState` = saved auth name) · `disable_evaluate: boolean=false` · `vault_enabled: boolean=true` · `stealth?: boolean` · `fingerprint?: boolean` · `humanize?: boolean` (omit ⇒ server defaults; fingerprint/humanize collapse to false when stealth is off) | `SessionMetadata`: `{ session_id, slug, channel, incognito, headless, persistence_mode, current_url: string\|null, created_at, owner, lease_expires_at, lease_paused_at: number\|null, disable_evaluate, vault_enabled, stealth, fingerprint, humanize, identity: AppliedIdentity\|null }` (+ additive `proxy_label: string\|null` (D-13); the JSON text also carries `driver: 'patchright'\|'playwright'\|null`, which is outside `outputSchema` and therefore not in `structuredContent`) | `INVALID_SLUG`, `UNKNOWN_CHANNEL`, `SESSION_LIMIT_REACHED`, `SESSION_ALREADY_EXISTS`, `UNSAFE_LAUNCH_ARG`, `INVALID_PERSISTENCE_CONFIG`, `AUTH_STATE_NOT_FOUND`, `BROWSER_NOT_INSTALLED` (typed; names the install command: `browserhive init` for `chromium`, `browserhive init --installChrome` for `chrome`; the requested channel is never swapped for another, D-18, D-26), `SANDBOX_UNAVAILABLE` (`retryable: never`: the sandbox was required, by `sandbox=on` or by `launch_options.chromiumSandbox: true`, and this browser cannot run with it on this host; the message ends with what to do, `details.alternatives` lists the channels checked to sandbox here, D-27) | no/no/no/yes |
| `close_session` | `session_id: string` | `{ session_id, closed: boolean }` — unknown id ⇒ `closed: false`, never throws | none (ownership: a foreign id also answers `closed: false`, indistinguishable from unknown) | no/yes/yes/no |
| `list_sessions` | *(none; registered without a schema, see below)* | `SessionMetadata[]` — **only the caller's sessions** under `auth=token` | none | yes/no/yes/no |

`list_sessions`, `server_status` and `list_saved_auths` take no arguments and are registered without an input schema. The SDK then advertises the minimal `{ "type": "object", "properties": {} }` and passes no arguments to the handler, so a call with no `arguments`, an empty object or stray keys all succeed. Clients that omit `arguments` for argument-less tools are common, and the advertised entry is the simplest schema every client accepts. The advertised entry is pinned by the tool goldens (§8).

### 3.2 Introspection

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `server_status` | *(none)* | `{ uptime_ms, version, transport: 'stdio'\|'http', sessions: { count, limit: number\|null }, vault: { enabled, backend: string\|null, evaluate_warning: boolean }, persistence_mode }`. `limit` is the effective cap (derived from host RAM by default, D-21), `null` only when `maxSessions=unbounded` | none | yes/no/yes/no |
| `session_info` | `session_id` | `{ session_id, config: { slug, channel, headless, incognito, persistence_mode, disable_evaluate, vault_enabled, stealth, fingerprint, humanize, owner }, page_count, current_url, created_at, last_tool_at, lease_expires_at, navigation_count }` | session errors | yes/no/yes/no |

### 3.3 Navigation

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `navigate` | `session_id` · `url: string` · `wait_until: WaitUntil='load'` · `timeout: Timeout` · `tab_id?` | `{ session_id, url: page.url(), status: number\|null }`; `navigation_count++`; HTTP 400–599 status is a **soft failure** (`HTTP_<n>` audit code, not an error) | session, `URL_BLOCKED` (before the browser is touched), `TAB_NOT_FOUND`, `NAVIGATION_TIMEOUT`, `NAVIGATION_FAILED` | no/no/no/yes |
| `go_back` | `session_id` · `wait_until='load'` · `timeout` · `tab_id?` | `{ session_id, url }`; count++ | session, `TAB_NOT_FOUND`, `NAVIGATION_TIMEOUT`, `NAVIGATION_FAILED` | no/no/no/yes |
| `go_forward` | same | same | same | no/no/no/yes |
| `reload` | same | same | same | no/no/yes/yes |
| `wait_for_url` | `session_id` · `url: string \| { pattern: string (min 1), flags?: string }` (object ⇒ `new RegExp`) · `timeout` · `tab_id?` | `{ session_id, url }` (no count bump) | session, `TAB_NOT_FOUND`, `WAIT_TIMEOUT` | yes/no/yes/no |

`url` as `string | object` is a property-level union (allowed); the root stays an object.

### 3.4 Tabs

Tab ids `t-<nanoid6 [0-9a-z]>`, stable, never reused; site-opened pages auto-register; first page is active; closing the active tab promotes the most recently added survivor.

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `new_tab` | `session_id` · `url?: string` · `wait_until='load'` · `timeout: int≥0=30000` | `{ session_id, tab_id, url }`; count++ only when `url` given; awaits per-page stealth override before navigating | session, `URL_BLOCKED`, `NAVIGATION_*` | no/no/no/yes |
| `close_tab` | `session_id` · `tab_id: string` (required) | `{ session_id, tab_id, closed: true }` | session, `TAB_NOT_FOUND` | no/yes/yes/no |
| `switch_tab` | `session_id` · `tab_id` | `{ session_id, tab_id, url }` | session, `TAB_NOT_FOUND` | no/no/yes/no |
| `list_tabs` | `session_id` | **bare array** `[{ tab_id, url, title (''\ on failure), active }]` insertion order | session | yes/no/yes/no |

### 3.5 Interaction

Playwright actionability/timeout failures (`TimeoutError` or messages matching `element is (not visible|not stable|not enabled|not attached|outside of the viewport)|intercepts pointer events`) map to `ELEMENT_NOT_ACTIONABLE` (message: selector + first line of detail ≤160 chars) **in these tools only**. With `session.humanize`, `click`, `type_text`, `hover`, `scroll(mode='by')` take the humanized path (§7); `fill`, `drag_and_drop`, `select_option`, `press_key`, `scroll(to|selector)` are always native.

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `click` | `session_id` · `selector` · `button: enum(left,right,middle)='left'` · `click_count: int 1..3=1` · `modifiers?: enum(Alt,Control,ControlOrMeta,Meta,Shift)[]` · `position?: { x: number, y: number }` · `timeout` · `tab_id?` | `{ session_id, selector, ok: true }` | session, `TAB_NOT_FOUND`, `ELEMENT_NOT_ACTIONABLE` | no/no/no/yes |
| `type_text` | `session_id` · `selector` · `text: string` · `delay: number≥0=0` · `timeout` · `tab_id?` — humanized: timeout raised to `max(timeout, estimateTypingMs(text)+5000)` unless 0; progress notifications during long types | `{ session_id, selector, ok: true }` | same | no/no/no/yes |
| `fill` | `session_id` · `selector` · `value: string` · `timeout` · `tab_id?` | `{ session_id, selector, ok: true }` | same | no/no/yes/yes |
| `press_key` | `session_id` · `key: string (min 1)` · `selector?` · `timeout` · `tab_id?` — without selector: `keyboard.press` (no timeout, not wrapped) | `{ session_id, key, ok: true }` | session, `TAB_NOT_FOUND`, `ELEMENT_NOT_ACTIONABLE` (selector form) | no/no/no/yes |
| `hover` | `session_id` · `selector` · `timeout` · `tab_id?` | `{ session_id, selector, ok: true }` | as click | no/no/yes/yes |
| `select_option` | `session_id` · `selector` · `values: string[] (min 1, msg 'values must include at least one option')` · `timeout` · `tab_id?` | `{ session_id, selector, selected: string[] }` | as click | no/no/yes/yes |
| `scroll` | `session_id` · `mode: enum(by,to,selector)` (required) · `dx: number=0` · `dy: number=0` · `x?: number` · `y?: number` · `selector?` · `behavior: enum(auto,smooth)='auto'` · `timeout` · `tab_id?` — **flat object + `superRefine`**: `to` requires `x`,`y` (`mode="to" requires x and y`); `selector` requires `selector` (`mode="selector" requires selector`) | `{ session_id, x, y }` (post-scroll `scrollX/scrollY`) | session, `TAB_NOT_FOUND`, `ELEMENT_NOT_ACTIONABLE` (selector mode) | no/no/no/yes |
| `drag_and_drop` | `session_id` · `source_selector` · `target_selector` · `timeout` · `tab_id?` | `{ session_id, ok: true }` | as click (selector reported `` `${source} → ${target}` ``) | no/no/no/yes |

### 3.6 Inspection

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `screenshot` | `session_id` · `full_page: boolean=false` · `clip?: { x, y, width, height }` · `omit_background: boolean=false` · `save_path?: string` (relative ⇒ `<data-dir>/sessions/<id>/`; absolute must resolve under the session dir or `<data-dir>/uploads/` after realpath) · `tab_id?` | **content blocks**: `[{ type:'image', data: base64, mimeType:'image/png' }, …(save_path ? [{ type:'text', text: JSON.stringify({ saved_to }) }] : [])]`; `structuredContent: { saved_to?, width, height, bytes }` (additive). Same bytes archived at `<data-dir>/sessions/<id>/screenshots/<event_id>.png`; `screenshot.captured` is published after `tool.called` because the `screenshots` row references the `tool_calls` row | session, `TAB_NOT_FOUND`, `PATH_NOT_ALLOWED` | yes/no/yes/no |
| `snapshot` | `session_id` · `tab_id?` | `{ session_id, url, tree: string }` (ARIA snapshot YAML) | session, `TAB_NOT_FOUND` | yes/no/yes/no |
| `get_content` | `session_id` · `tab_id?` | `{ session_id, url, html }` | same | yes/no/yes/no |
| `evaluate` | `session_id` · `expression: string (min 1)` · `tab_id?` — IIFE wrapping heuristic (an expression that looks like a function definition is invoked; an already-invoked IIFE is left alone); evaluation always runs in the page's main world via `evaluateMainWorld`, which passes Patchright's fourth positional `isolatedContext: false` only when the session's driver supports it (11 §2.1) | `{ session_id, result: unknown }` | `EVALUATE_DISABLED` (per-session `disable_evaluate` **or** server `allowEvaluate=false`), session, `TAB_NOT_FOUND`, `SCRIPT_ERROR` (page-side throw; message redacted) | no/no/no/yes |

### 3.7 Waits

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `wait_for_selector` | `session_id` · `selector` · `state: enum(attached,detached,visible,hidden)='visible'` · `timeout` · `tab_id?` | `{ session_id, selector, state }` | session, `TAB_NOT_FOUND`, `WAIT_TIMEOUT` | yes/no/yes/no |
| `wait_for_load_state` | `session_id` · `state: enum(load,domcontentloaded,networkidle)='load'` · `timeout` · `tab_id?` | `{ session_id, state }` | same | yes/no/yes/no |

### 3.8 Dialogs

One-shot `page.once('dialog')`, auto-disarmed after 60 000 ms (`unref` timer).

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `accept_next_dialog` | `session_id` · `prompt_text?: string` · `tab_id?` | `{ session_id, armed: true }` | session, `TAB_NOT_FOUND` | no/no/yes/no |
| `dismiss_next_dialog` | `session_id` · `tab_id?` | `{ session_id, armed: true }` | same | no/no/yes/no |

### 3.9 Cookies and state

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `get_cookies` | `session_id` · `urls?: string[]` | `{ cookies: Cookie[] }` (**no `session_id`**; full values returned to the agent, but never persisted — D-20) | session | yes/no/yes/no |
| `set_cookies` | `session_id` · `cookies: looseObject{ name: string, value: string, …}[]` (min 1, msg 'cookies must include at least one entry') | `{ added: number }` (**no `session_id`**) | session, `INVALID_ARGUMENTS` (Playwright cookie validation mapped to the field) | no/no/yes/no |
| `set_viewport` | `session_id` · `width: int>0` · `height: int>0` · `tab_id?` — clamped to the asserted display when a fingerprint is active; invalidates the humanize cursor | `{ session_id, width, height, clamped?: true }` (`clamped` key only when true) | session, `TAB_NOT_FOUND` | no/no/yes/no |
| `set_extra_http_headers` | `session_id` · `headers: Record<string,string>` — replaces previous extras; on stealth/fingerprint sessions identity-owned headers (`user-agent`, `accept-language`, `sec-ch-ua*`) are **refused, not thrown** | `{ session_id, applied: number, rejected: string[] }` | session | no/no/yes/no |

### 3.10 Files

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `upload_file` | `session_id` · `selector` · `paths: string[]` (each min 1; min 1 item, msg 'paths must include at least one file'; each must resolve under `<data-dir>/uploads/`) · `timeout` · `tab_id?` | `{ session_id, selector, ok: true }` | session, `TAB_NOT_FOUND`, `PATH_NOT_ALLOWED`, `UPLOAD_FAILED` | no/no/yes/no |
| `download_file` | `session_id` · `trigger_selector` · `timeout` · `tab_id?` · `save_as?: string` (basename only) — download listener armed **before** the click | `{ session_id, saved_to, suggested_name, size }` | session, `TAB_NOT_FOUND`, `DOWNLOAD_FAILED` (incl. click failure) | no/no/no/yes |

### 3.11 Auth states

Names: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no `..`; violation ⇒ `PATH_NOT_ALLOWED`.

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `save_storage_state` | `session_id` · `name` | `{ name, path, size }` (0600 file, manifest written) | session, `PATH_NOT_ALLOWED` | no/no/yes/no |
| `save_full_profile` | `session_id` · `name` — persistent sessions only; zips `userdata` (regular files only); writes identity seed sidecar when a fingerprint exists | `{ name, path, size }` | session, `INVALID_PERSISTENCE_CONFIG` ('save_full_profile is only valid for a session in persistent mode'), `PATH_NOT_ALLOWED` | no/no/yes/no |
| `list_saved_auths` | *(none)* | `[{ name, kind: 'storage'\|'profile', saved_at, size }]` newest first — scoped to the caller's principal under `auth=token` (manifests record `owner`) | none | yes/no/yes/no |

### 3.12 Attention (HTTP only)

Both tools stay registered under stdio and throw `ATTENTION_REQUIRES_HTTP` first (before session lookup).

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `request_attention` | `session_id` · `reason: string (min 1)` · `mode: enum(takeover,notify)='takeover'` (described: both modes block; takeover lets the operator drive; notify is view-only) · `options?: unknown` (persisted as given for the operator) · `max_wait_seconds?: int≥0` — **description is dynamic**: with floor > 0 it includes `The operator requires a minimum wait of ${n}s — a smaller max_wait_seconds is automatically raised to it, so give a human enough time. Set max_wait_seconds to 0 to wait indefinitely (up to the server limit), which is best when a human may be away.`; with floor 0 only the second sentence | `{ status: 'resolved'\|'rejected'\|'timeout'\|'cancelled', message?, resolved_by?, resolved_at: number\|null, request_id: 'a-<nanoid12>' }` — `message`/`resolved_by` **omitted** when absent | `ATTENTION_REQUIRES_HTTP`, session errors | no/no/no/no |
| `get_attention_result` | `request_id: string` | same outcome shape; settled ⇒ immediate; pending ⇒ blocks with heartbeats; unknown ⇒ `{ status:'rejected', message: "Unknown attention request '<id>'." }` (no throw). Requests owned by another principal answer exactly like unknown | `ATTENTION_REQUIRES_HTTP` | yes/no/yes/no |

### 3.13 Vault

Both raise `VAULT_NOT_CONFIGURED` before session lookup when no backend is configured; both work under stdio (only `dashboard_confirm` entries auto-deny there).

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `vault_list_available` | `session_id` · `url?: string` (described: pass the domain of the login page, e.g. "github.com"; honesty probe) | `{ entries: [{ entry_name, allowed_origins: string[], redact_username, require_no_evaluate }], scope: 'unscoped'\|'page'\|'no_page'\|'rejected', scoped_to: string\|null, mismatch?: { declared, actual }, note? }` — never `dashboard_confirm` nor authorized slugs | `VAULT_NOT_CONFIGURED`, session errors | yes/no/yes/no |
| `vault_fill` | `session_id` · `entry_name (min 1)` · `username_selector (min 1)` · `password_selector (min 1)` · `submit_selector?` · `after_submit_wait_ms?: int≥0` · `clear_after_fill?: boolean` (default false) · `tab_id?` | `{ status: 'success'\|'origin_mismatch'\|'auth_failed'\|'blocked', redacted: true, reason? }` — failures are **returned**, never thrown (reasons: `vault_disabled`, `not_authorized`, `evaluate_required_off`, `origin_mismatch`, `dashboard_denied`, `form_action_mismatch`, `fill_failed`, `submit_failed`, `entry_not_found`, `backend_error`, `confirm_timeout` (D-15)) | `VAULT_NOT_CONFIGURED`, `VAULT_LOCKED`, session errors | no/no/no/yes |

### 3.14 Registration order (pinned)

`launch_session, close_session, list_sessions, server_status, session_info, navigate, go_back, go_forward, reload, wait_for_url, new_tab, close_tab, switch_tab, list_tabs, click, type_text, fill, press_key, hover, select_option, scroll, drag_and_drop, screenshot, snapshot, get_content, evaluate, wait_for_selector, wait_for_load_state, accept_next_dialog, dismiss_next_dialog, get_cookies, set_cookies, set_viewport, set_extra_http_headers, upload_file, download_file, save_storage_state, save_full_profile, list_saved_auths, request_attention, get_attention_result, vault_list_available, vault_fill` — 43 names, checked by the stdio handshake test against `tools/list`.

## 4. Behavioral guarantees

Rules the dispatcher and tools enforce on top of the shapes in §3. They are part of the contract (D-12) and each has a test.

| Guarantee | Behavior | How it surfaces |
|---|---|---|
| Ownership on every tool | the dispatcher applies ownership to every tool that names a session or request, including `close_session`, `list_sessions`, `list_saved_auths`, `get_attention_result` | foreign session ⇒ `closed:false` / not listed / "unknown request" — never an existence oracle |
| `allowEvaluate=false` is enforced | `evaluate` throws `EVALUATE_DISABLED` when server `allowEvaluate=false` or session `disable_evaluate` | same code and message for both causes |
| Server defaults are advertised | `launch_session` schema defaults are computed from `defaultHeadless` / `defaultChannel` at registration | visible in `tools/list` defaults |
| Every call is observed | `INVALID_ARGUMENTS` and other pre-handler failures are observed like any failure | dashboard timeline row, `tool_calls.error_code` |
| Client-gone detection | `signal` aborts on `notifications/cancelled` or transport close ⇒ `broker.cancel(requestId)`; heartbeats every 25 s (`progress` = elapsed ms, `total` = timeout ms) | attention `status: 'cancelled'`, lease resumed |
| No internals in error text | Playwright errors are mapped to registry codes with a public message; the private cause goes to logs only | `[NAVIGATION_TIMEOUT] …` etc. |
| One slug message | schema regex message and `InvalidSlug` message are one text: `Invalid slug '<slug>'. Slugs must match /^[a-z][a-z0-9-]{1,31}$/` | same text from every path |
| Cookie validation is typed | `set_cookies` maps Playwright validation failures to `INVALID_ARGUMENTS` with the field | |

## 5. Attention model (agent view)

- `request_attention` **blocks** until resolved/rejected by an operator, times out, or is cancelled. Effective wait: `max_wait_seconds` `undefined`/`0` ⇒ server cap (`attentionTimeout`, default 6h); positive ⇒ `max(value, minAttentionWait)` seconds (floor default 30 min; `0` disables the floor), never above the cap.
- While open, the session lease is frozen; operator input on the live view is permitted only during this window.
- Heartbeats: `notifications/progress` every 25 s. Cancellation: `signal` abort ⇒ `cancelled` with message `Client cancelled the attention request.`
- Session close/crash/reap/shutdown ⇒ `rejected` with the per-reason messages (`session_closed`, `session_dead`, `lease_expired`, `server_shutdown`, `interrupted`). Restart ⇒ pending rows become `rejected` ("Attention request was lost when the server restarted.").
- `get_attention_result` re-attaches by id (same principal), returns immediately when settled.
- Timeout message: `Attention request timed out; the operator was not available to respond.`
- Implemented by the `OperatorRequestBroker` with `kind: 'attention'` (D-15).

## 6. Auth states (agent view)

Files under `<data-dir>/auth-states/`: `<name>.storage.json` (Playwright storageState with `indexedDB: true`: cookies, localStorage and IndexedDB — many sites keep their auth tokens in IndexedDB), `<name>.profile.zip` (managed userdata, regular files only, `zipSync` level 6, zip-slip guard on restore), `<name>.meta.json` (`{ name, kind, saved_at, source_session_id, size, owner }`), `<name>.identity.json` (`{ seed }` only). All 0600. Restore: storage via `launch_session({ context_options: { storageState: '<name>' } })` in `memory`/`storage-state` modes (string + `persistent` ⇒ `INVALID_PERSISTENCE_CONFIG`); profile via `launch_session({ persistence_mode:'persistent', restore_profile:'<name>' })` which unzips into the new session's `userdata` and reloads the identity seed. Missing name ⇒ `AUTH_STATE_NOT_FOUND` (`No saved ${'full-profile'|'storage-state'} snapshot named '<name>'. Use list_saved_auths to see what is available.`).

## 7. Humanize (as tools see it)

Enabled per session (`humanize: true`, requires stealth). Affects `click`, `hover`, `type_text`, `scroll(by)` and `vault_fill` typing. Seeded `mulberry32(FNV-1a(sessionId))` per session; the vault typer uses system randomness. Constants (pinned by tests): path `overshootThreshold 500, overshootRadius 120, spread 2..200, fittsIntercept 100, fittsSlope 120, targetWidth 100, steps 10..60, timingJitter 0.12, maxDurationMs 2000`; typing `medianIntervalMs 130, sigma 0.38, wordPauseMs 90, sentencePauseMs 260, typoRate 0.03, typoNoticeMs 120..380, intervalBounds 25..900`; policy `MAX_HUMANIZED_CHARS 400, BUDGET_FRACTION 0.6, POINTER_ESTIMATE_MS 1200, estimateTypingMs = round(min(len,400)×130×1.2)`; click dwell 45–120 ms, inter-click 60–110 ms; scroll 3–7 wheel notches with 40–90 ms pauses. Fallback rules: no bounding box or over budget ⇒ native call (so Playwright reports the real actionability error); text beyond 400 chars typed natively; budget below `25 × chars × 0.25` ms ⇒ native. `humanize/NOTICE.md` carries the ghost-cursor MIT attribution for the path algorithm. No per-call tuning is exposed.

## 8. Contract goldens

- `packages/contracts/test/goldens/tools/<name>.json`: for each tool `{ name, title, description (static part), inputSchema (JSON Schema as sent on the wire), outputSchema, annotations, since }`. `bun run test:goldens` compares the live registry to the files; a diff fails CI. Bless with `UPDATE_GOLDENS=1 bun run test:goldens` and include the diff in the PR with a changeset (`minor` for additive, `major` for anything else).
- `stdio-handshake.test.ts` spawns the built CLI with `--transport stdio`, runs `initialize → tools/list → tools/call list_sessions`, asserts the 43 names and that nothing but JSON-RPC reaches stdout.
- The dynamic part of `request_attention`'s description is tested separately against floor values 0 and 1800.

## 9. Programmatic API (`browserhive` package)

```ts
import { createServer, type BrowserHiveServer, type CreateServerOptions } from 'browserhive';
const server = await createServer({ transport: 'http', host: '127.0.0.1', port: 9876, admin: true, auth: 'token', vault: 'bitwarden', stealth: 'standard', sessionLease: '2h', /* every config key, typed, camelCase (D-06) */ env: {}, output: (line) => {}, logger?: LoggerSink });
await server.listen();   // idempotent; resolves when phase `ready` is reached
server.url;              // 'http://127.0.0.1:9876'
server.config;           // deep-frozen effective config with provenance
await server.stop({ deadlineMs?: 20_000 }); // idempotent; unwinds even after a failed listen()
```

`CreateServerOptions` is `z.input<typeof serverConfigSchema>` plus `env`, `output`, `logger`, `name`. There is no string round-trip: options are validated by the same schema as the CLI. Exports also include `ALL_TOOL_NAMES`, `toolDefinitions` (read-only), `ERROR_CODES`, the `AppError` class, and every wire type re-exported from `@browserhive/contracts`. `.d.ts` files are shipped; `export *` is not used.

## Design notes

- Typed codes (`NAVIGATION_TIMEOUT`, `WAIT_TIMEOUT`, `DOWNLOAD_FAILED`, `UPLOAD_FAILED`, `SCRIPT_ERROR`, `NAVIGATION_FAILED`) are used instead of `INTERNAL_ERROR` for failures an agent can act on. `INTERNAL_ERROR` is never a documented code of any tool, so introducing a typed code for a failure mode is additive. Interaction tools report actionability failures as `ELEMENT_NOT_ACTIONABLE` only.
- `launch_session` gains keys and error codes only additively (`proxy_label`, `driver`, `BROWSER_NOT_INSTALLED`, `SANDBOX_UNAVAILABLE`; D-13, D-18, D-27). Its input schema and `SessionMetadata` output did not change for the sandbox: the verdict is on the HTTP `SessionSummary` (03 §4.2) and `/system`, not in the tool output.
- `launch_options.chromiumSandbox`: `false` is refused (`UNSAFE_LAUNCH_ARG`, spec 11 §4); `true` is accepted in every `sandbox` mode because it only strengthens the posture, and makes the sandbox a requirement for that session (a host that cannot give it answers `SANDBOX_UNAVAILABLE`, never `INTERNAL_ERROR`).
- `list_saved_auths` scopes by the `owner` field in `.meta.json`; a manifest without it (for example one written by hand) is treated as owned by `local`.
- `instructions` on the server and `title` on tools are additive; the golden generator normalizes key order so an SDK reordering does not produce a false diff.
