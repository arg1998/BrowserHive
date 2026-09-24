---
title: "Error handling and telemetry"
spec: "10"
status: Normative
scope: How errors are modeled, thrown, caught, projected and reported across MCP, HTTP, WS, CLI and background work; how logs, traces and metrics are produced, correlated and exported; redaction on every sink.
audience: Contributors adding error codes, log lines, spans or metrics; operators integrating BrowserHive with an observability stack.
related:
  - 00-decisions.md
  - 02-mcp-and-tools.md
  - 03-admin-backend.md
  - 08-cli-arguments-and-config.md
---

# 10 — Error Handling and Telemetry

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Decisions: D-07 (error model), D-08 (telemetry), D-20 (privacy).

---

## 1. Error registry (D-07)

`packages/contracts/src/errors/registry.ts` is the single source of truth. Each entry:

```ts
{
  code: 'SESSION_NOT_FOUND',
  httpStatus: 404,
  category: 'domain',            // domain | boot | auth | transport | audit | warning
  retryable: 'different_args',   // never | immediate | backoff | after_operator | different_args
  title: 'Session not found',    // short, stable
  hint: 'Use list_sessions to see live sessions.',
  details: z.object({ session_id: z.string() }),
  docs: true,                    // rendered into docs/errors.md
}
```

`ErrorCode` is the union of keys; `docs/errors.md` is generated (`scripts/gen-docs.ts`) with Surface / Cause / Resolution prose authored in the registry (`cause`, `resolution` fields). A CI gate fails when a code exists without prose. `category: 'audit'` codes are never thrown; they are classification results stored in `tool_calls.error_code`. `warning` codes are `SessionWarning`s (logged, broadcast on `session:<id>`, never thrown).

### 1.1 Code table

**Stability guarantee.** Error codes that tools return to agents are part of the stable tool contract (D-12). Once published, such a code MUST keep its meaning, category and public message text, because agents branch on the code and some messages carry instructions an agent acts on (`URL_BLOCKED` says not to retry). New codes are additive. `packages/contracts/test/errors.registry.test.ts` pins the set of tool-surface codes and their message texts; changing either requires a decision-log update.

| Code | HTTP | Category | Retryable | Details |
|---|---|---|---|---|
| SESSION_NOT_FOUND | 404 | domain | different_args | `{session_id}` |
| SESSION_ALREADY_EXISTS | 409 | domain | immediate | `{session_id}` |
| SESSION_DEAD | 410 | domain | different_args | `{session_id}` |
| SESSION_LIMIT_REACHED | 429 | domain | backoff | `{limit, live}` |
| SESSION_ACCESS_DENIED | 404 | domain | never | `{session_id}` (public message identical to SESSION_NOT_FOUND) |
| SESSION_NOT_AVAILABLE | 409 | domain | after_operator | `{session_id, state}` |
| UNKNOWN_CHANNEL | 400 | domain | different_args | `{channel, supported[]}` |
| INVALID_SLUG | 400 | domain | different_args | `{slug, pattern}` |
| UNSAFE_LAUNCH_ARG | 400 | domain | different_args | `{arg}` |
| INVALID_PERSISTENCE_CONFIG | 400 | domain | different_args | `{reason}` |
| TAB_NOT_FOUND | 404 | domain | different_args | `{session_id, tab_id}` |
| PATH_NOT_ALLOWED | 400 | domain | different_args | `{path, roots[]}` (roots omitted from the public message for remote agents; see §1.3) |
| AUTH_STATE_NOT_FOUND | 404 | domain | different_args | `{name, kind}` |
| EVALUATE_DISABLED | 403 | domain | never | `{session_id, scope:'session'|'server'}` |
| ELEMENT_NOT_ACTIONABLE | 422 | domain | backoff | `{selector, detail}` |
| ELEMENT_NOT_FOUND | 404 | domain | different_args | `{selector}` |
| NAVIGATION_TIMEOUT | 504 | domain | backoff | `{url, timeout_ms}` |
| NAVIGATION_FAILED | 502 | domain | backoff | `{url, net_error}` |
| WAIT_TIMEOUT | 504 | domain | backoff | `{what, timeout_ms}` |
| SCRIPT_ERROR | 422 | domain | different_args | `{message}` |
| DOWNLOAD_FAILED | 502 | domain | backoff | `{reason}` |
| UPLOAD_FAILED | 422 | domain | different_args | `{reason}` |
| PAGE_CLOSED | 410 | domain | different_args | `{tab_id}` |
| BROWSER_CRASHED | 500 | domain | after_operator | `{session_id}` |
| URL_BLOCKED | 403 | domain | never | `{url, pattern}` |
| VAULT_NOT_CONFIGURED | 404 | domain | never | `{}` |
| VAULT_LOCKED | 409 | domain | after_operator | `{backend}` |
| VAULT_ENTRY_NOT_FOUND | 404 | domain | different_args | `{entry_name}` |
| VAULT_NOT_AUTHORIZED | 403 | domain | never | `{entry_name}` |
| ORIGIN_MISMATCH | 403 | audit | different_args | `{page_origin, allowed[]}` |
| EVALUATE_REQUIRED_OFF | 403 | domain | never | `{entry_name}` |
| DASHBOARD_DENIED | 403 | domain | after_operator | `{request_id}` |
| VAULT_UNLOCK_FAILED | 401 | domain | different_args | `{mode}` |
| VAULT_SYNC_UNSUPPORTED | 400 | domain | never | `{backend}` |
| VAULT_BACKEND_ERROR | 502 | domain | backoff | `{backend, kind:'not_installed'|'timeout'|'exit'}` |
| ADMIN_REQUIRES_HTTP | — | boot | never | `{}` |
| ATTENTION_REQUIRES_HTTP | 400 | domain | never | `{tool}` |
| ATTENTION_NOT_OPEN | 409 | domain | never | `{request_id, status}` |
| CONFIRM_NOT_OPEN | 409 | domain | never | `{request_id, status}` |
| INPUT_NOT_PERMITTED | 409 | domain | after_operator | `{session_id}` |
| SCREENCAST_FAILED | 502 | domain | backoff | `{session_id, reason}` |
| TOOL_NOT_AVAILABLE | 400 | domain | never | `{tool, requires}` |
| INVALID_ARGUMENTS | 400 | domain | different_args | `{issues:[{path, message}]}` |
| INTERNAL_ERROR | 500 | domain | backoff | `{ref}` (request id) |
| INSECURE_BIND_REFUSED | — | boot | never | `{host}` |
| PORT_IN_USE | — | boot | never | `{host, port, errno}` (exit 3) |
| BIND_FAILED | — | boot | never | `{host, port, errno}` (e.g. `EACCES`; exit 1) |
| CONFIG_INVALID | — | boot | never | `{key, source, reason}` |
| CONFIG_UNKNOWN_KEY | — | boot | never | `{key, source, suggestion?}` |
| BLOCKLIST_LOAD_FAILED | 400 | boot/domain | never | `{path, reason}` |
| DATA_DIR_UNWRITABLE | — | boot | never | `{path}` |
| DATA_DIR_LOCKED | — | boot | never | `{path, pid}` (another server holds the data dir; exit 3) |
| DB_OPEN_FAILED | — | boot | never | `{path, reason}` |
| DB_NEWER_THAN_BINARY | — | boot | never | `{db_version, min_reader_version, binary_version, backup_path?}` |
| MIGRATION_FAILED | — | boot | never | `{from, to, name, backup_path}` |
| DB_CORRUPT | — | boot | never | `{path, quarantine_path}` |
| UNHANDLED | — | boot | never | `{kind:'exception'\|'rejection', name}` (degradation record, §1.4) |
| RETENTION_FAILED | — | boot | backoff | `{step, reason}` (degradation record, §3) |
| STALE_BROWSER_PROCESSES | — | boot | never | `{count}` (degradation record, §3) |
| BROWSER_NOT_INSTALLED | 503 | domain/boot | after_operator | `{channel, install_command}` |
| SANDBOX_UNAVAILABLE | 503 | boot/domain | never | `{channel, reason, required_by:'config'\|'launch_options', alternatives[], guidance[], executable?, cause?}` (D-27). Boot form: the `sandbox=on` preflight refuses to start, exit 3; the public message is the headline ("The sandbox is required (--sandbox on) but the configured browser cannot run sandboxed.") and `guidance` holds the operator block the CLI prints under it, instead of the hint. Tool form: `launch_session` when the sandbox was required (`sandbox=on`, or `launch_options.chromiumSandbox: true`) and this browser cannot run with it; the message ends with "Retrying will not help." and the short guidance, `alternatives` lists the channels checked to sandbox here, `executable` is omitted. `reason` is Chrome's own sentence (`No usable sandbox!`) |
| UNAUTHORIZED | 401 | auth | never | `{}` |
| INVALID_CREDENTIALS | 401 | auth | never | `{}` |
| FORBIDDEN | 403 | auth | never | `{scope}` |
| PASSWORD_CHANGE_REQUIRED | 403 | auth | after_operator | `{}` |
| BAD_CURRENT_PASSWORD | 400 | auth | different_args | `{}` |
| WEAK_PASSWORD | 400 | auth | different_args | `{min_length}` |
| ORIGIN_NOT_ALLOWED | 403 | transport | never | `{}` |
| HOST_NOT_ALLOWED | 421 | transport | never | `{}` |
| RATE_LIMITED | 429 | transport | backoff | `{retry_after_ms}` |
| PAYLOAD_TOO_LARGE | 413 | transport | different_args | `{limit_bytes}` |
| VALIDATION_FAILED | 400 | transport | different_args | `{issues[]}` |
| NOT_FOUND | 404 | transport | never | `{}` |
| METHOD_NOT_ALLOWED | 405 | transport | never | `{allow[]}` |
| CONFLICT | 409/412 | transport | different_args | `{current_version?}` |
| NOT_ACCEPTABLE | 406 | transport | different_args | `{supported[]}` |
| TRACE_UNAVAILABLE | 404 | domain | never | `{enabled}` |
| SCREENSHOT_UNAVAILABLE | 404 | domain | never | `{event_id}` |
| SESSION_NOT_LIVE / SESSION_LIVE | 409 | domain | never | `{session_id}` |
| WS_PROTOCOL_ERROR | — | transport | never | `{violations}` |
| WS_OVERLOADED | — | transport | backoff | `{buffered_bytes}` |
| **audit-only (soft outcomes)** | | | | |
| VAULT_FILL_AUTH_FAILED, VAULT_FILL_BLOCKED, VAULT_LIST_DENIED | — | audit | — | classification of returned statuses |
| ATTENTION_REJECTED, ATTENTION_TIMEOUT, ATTENTION_CANCELLED | — | audit | — | |
| HTTP_400…HTTP_599 (`HTTP_<n>`) | — | audit | — | `navigate` result status ≥ 400 |
| **warnings (SessionWarning)** | | | | |
| EXECUTABLE_PATH_OVERRIDE, TRACE_START_FAILED, TRACE_FINALIZE_FAILED, STEALTH_INIT_FAILED, BLOCKLIST_ROUTE_FAILED, BYO_PROXY_UNSEEDED, VIEWPORT_OVERRIDE_UNASSERTED, IDENTITY_SEED_SAVE_FAILED, REAP_DEAD_FAILED, CDP_SESSION_LEAKED, SCREENSHOT_ARCHIVE_FAILED | — | warning | — | `{session_id, message, details}` |

There is one listener (D-02), so bind failures are reported by exactly two codes: `PORT_IN_USE` when the address is taken (a policy-style refusal the operator fixes with `--port`) and `BIND_FAILED` for every other errno.

Waits, downloads, uploads and navigation failures use typed codes (`NAVIGATION_TIMEOUT`, `NAVIGATION_FAILED`, `WAIT_TIMEOUT`, `DOWNLOAD_FAILED`, `UPLOAD_FAILED`, …) rather than `INTERNAL_ERROR`, so an agent can tell a retryable page condition from a server fault; `INTERNAL_ERROR` is reserved for failures that no classification row explains (§1.5).

### 1.2 `AppError`

```ts
class AppError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: Details<C>;          // zod-validated at construction in dev, trusted in prod
  readonly publicMessage: string;        // safe for any audience
  readonly hint?: string;
  readonly retryable: Retryable;         // from registry, overridable per instance
  readonly httpStatus: number;
  override readonly cause?: unknown;     // always set when wrapping
  constructor(code, details, opts?: { message?: string; publicMessage?: string; cause?: unknown; retryable?: Retryable });
  toJSON(): { code, message: publicMessage, hint, details, retryable };
}
export const isAppError = (e: unknown, code?: ErrorCode): e is AppError;
export function errorFrom(code, details, opts?): AppError;   // factory with typed details
```

`message` (private) may contain host paths, Playwright prose and stack context; `publicMessage` is what remote agents and problem+json carry. For tool-surface codes the registry's message text is the `publicMessage` and is covered by the stability guarantee of §1.1.

`serializeError(err)` walks the `cause` chain (max depth 8) into `{name, code?, message, stack?, cause?}`; stacks are included only for the log sink. `String(err)` in source is a lint error (`noRestrictedSyntax`), as is `catch {}` without a comment.

### 1.3 Audience rules

- **Remote agent (MCP over HTTP)** and **problem+json**: `publicMessage` + `hint` + `details` filtered through the details schema's `public` flags (e.g. `PATH_NOT_ALLOWED.roots` is public only under stdio/loopback, where the agent runs on the host).
- **Operator (dashboard, logs)**: full private message, `details`, serialized cause chain, `request_id`.
- **Nothing** ever carries secrets: the redaction codec (§9) runs on every error projection.

### 1.4 Throw vs return

| Situation | Pattern |
|---|---|
| Domain rule violated, precondition failed, resource missing | `throw new AppError(...)` in application/domain services |
| Parsing, classification, matching | return `Result<T, E>` (`kernel/result.ts`, minimal `{ok:true,value}|{ok:false,error}`) — never throw for expected non-matches |
| Agent-branchable task outcome (`vault_fill` status, `request_attention` status, `navigate` HTTP status, `set_extra_http_headers.rejected`) | return the status in the result; the outcome classifier (`tool-outcome.ts`) records an audit code |
| Boundary adapters (HTTP handler, WS command, MCP dispatcher, CLI) | never let anything escape: map to a projection; unknown → `INTERNAL_ERROR` with `ref = request_id` |
| Background timers (sweeper, retention, outbox, WS heartbeats) | `void tick().catch(reportDegradation)`; per-item try/catch inside sweeps; a failing item never aborts the sweep |
| Session teardown, CDP detach, file cleanup | swallow-and-warn (`SessionWarning`), never throw from `stop()` |

Process level (installed by the CLI, not by core): `unhandledRejection`/`uncaughtException` → log at `error` with `serializeError`, record `system.degraded {code:'UNHANDLED', ...}`, and continue; if the error is `DB_CORRUPT` or the storage handle is gone, initiate `stop()` with exit code 1. `no-floating-promises` is enforced by Biome (`noFloatingPromises`).

### 1.5 Playwright error classification

`infra/browsers/classify-error.ts` maps driver errors to codes with an ordered regex table pinned by tests (each row has a fixture message):

| Match | Code |
|---|---|
| `TimeoutError` name **and** message contains `waiting for` + (`locator`, `selector`, `getBy`) | ELEMENT_NOT_ACTIONABLE when the call was an action, WAIT_TIMEOUT otherwise |
| `/element is (not visible\|not stable\|not enabled\|not attached\|outside of the viewport)\|intercepts pointer events/i` | ELEMENT_NOT_ACTIONABLE |
| `/strict mode violation/i` | ELEMENT_NOT_FOUND (`details.count`) |
| `/net::ERR_[A-Z_]+/` (captured) | NAVIGATION_FAILED |
| `TimeoutError` during `goto`/`waitForURL`/`waitForLoadState` | NAVIGATION_TIMEOUT |
| `/Target (page|context|browser) has been closed/i` | PAGE_CLOSED (page) / BROWSER_CRASHED (context, browser) |
| `/Execution context was destroyed/i` | PAGE_CLOSED |
| `evaluate` rejects with a page-thrown error | SCRIPT_ERROR (`details.message` = first line, ≤ 300 chars) |
| `/Download.*(failed|canceled)/i` | DOWNLOAD_FAILED |
| `setInputFiles` failures | UPLOAD_FAILED |
| `/Executable doesn't exist/i` | BROWSER_NOT_INSTALLED (`details.install_command = 'browserhive init'`) |
| a launch whose sandbox could not start: Chrome's or Playwright's markers (`Chromium sandboxing failed!`, `No usable sandbox`, `crbug.com/638180`, `crbug.com/357670`, `Failed to move to new namespace`, `zygote_host_impl_linux`, `The SUID sandbox helper binary was found, but is not configured correctly` (Edge on Ubuntu), …), or any other failure of a sandboxed launch after which the same browser starts without the sandbox | SANDBOX_UNAVAILABLE (`retryable: never`) when the sandbox was required; under `sandbox=auto` the session falls back instead. **Never `INTERNAL_ERROR`**: the failure is a property of the host, and `backoff` would make an agent retry forever |
| anything else | INTERNAL_ERROR (private message keeps the Playwright text) |

The first line of the driver message (≤ 160 chars, redacted) is stored in `details.detail`; the public message is the registry text.

---

## 2. Projections

### 2.1 MCP

Tool results on error: `isError: true`, `content: [{type:'text', text:'[SESSION_NOT_FOUND] No browser session with id \'shop-a1b2c3d4\''}]`, plus the structured error in `_meta['browserhive.ai/error']`: `{ code, message, retryable, hint?, details? }` (`McpErrorContent`). The `[CODE] message` text format is part of the stable tool contract (D-12): agents that read only text content parse the code from it.

The structured error is carried in `_meta`, not in `structuredContent`, because the MCP SDK client validates any `structuredContent` against the tool's output schema even when `isError` is true; an error shape there would turn every tool error into a client-side protocol exception for SDK-based agents. Successful results carry `structuredContent` as usual. Over HTTP, `PATH_NOT_ALLOWED.details.roots` is omitted (§1.3).

Protocol-level failures (malformed JSON-RPC, unknown tool) use JSON-RPC error codes per the SDK; argument validation failures are tool results with `INVALID_ARGUMENTS` (so they are observed and audited), not JSON-RPC `-32602`.

### 2.2 HTTP (RFC 9457)

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://browserhive.ai/docs/errors#ATTENTION_NOT_OPEN",
  "title": "Attention request is not open",
  "status": 409,
  "detail": "Request 'a-8f3k…' was already resolved.",
  "instance": "/api/v1/attention/a-8f3k…/resolve",
  "code": "ATTENTION_NOT_OPEN",
  "retryable": "never",
  "hint": "Refresh the queue.",
  "details": { "request_id": "a-8f3k…", "status": "resolved" },
  "request_id": "01J…"
}
```

`VALIDATION_FAILED.details.issues` lists `{path, message, code}` from zod. `retry_after_ms` appears in `details` for RATE_LIMITED alongside the `Retry-After` header.

### 2.3 WebSocket

`{ v:1, kind:'error', seq, ts, corr?, payload: { code, title, hint?, details?, request_id } }`. Fatal protocol errors close the socket with the codes in 03 §6.4.

### 2.4 CLI

Boot errors print `browserhive: [CODE] <public message>` followed by the hint on the next line, in red when color is on, and exit with 64 (config/usage), 3 (policy refusal: bind, admin-under-stdio), or 1 (everything else). `--json` on subcommands prints the problem object instead.

---

## 3. Degradations: `system_events`

Background failures and non-fatal boot findings become rows (`code`, `severity`, `message`, `details`, `first_seen_at`, `last_seen_at`, `count`, `resolved_at`) aggregated in-process by `code` + a details fingerprint (so a retention failure repeating every 6 h is one row with `count`). Producers: retention, outbox, WS overload, unhandled rejections, DB `dropped_writes`, browser install missing, blocklist reload failure, OTel export failure, stale Chromium processes found at startup. Rows appear on `/system.degradations`, on the `system` WS topic, in the dashboard System page, and as `system` notifications when severity is `error`. `resolved_at` is set when the producer reports recovery (e.g. next retention pass succeeds).

---

## 4. Log record

```ts
interface LogRecord {
  ts: number; level: 'error'|'warn'|'info'|'debug'|'trace'; msg: string; module: string;
  trace_id?: string; span_id?: string; request_id?: string; session_id?: string; principal?: string; transport?: 'http'|'stdio'|'ws'|'cli';
  err?: SerializedError; [field: string]: unknown;   // fields are pre-redacted
}
```

Reserved keys are namespaced: user fields that collide with reserved names are written under `fields.<name>`.

### 4.1 Levels and per-module spec

`--logLevel` accepts a spec: `info` or `info,sessions=debug,persistence=trace`. Levels are `error`, `warn`, `info`, `debug` and `trace`; `trace` sits below `debug` for per-CDP-command and payload logging. Module names come from `LOG_MODULES` in `infra/logging/level-spec.ts`: the subsystems (`sessions`, `browsers`, `persistence`, `http`, `ws`, `mcp`, `vault`, `attention`, `auth`, `telemetry`, `retention`), the cross-cutting modules that log at boot (`config`, `blocklist`, `notifications`, `system`, `cli`), and `dashboard` for client errors. A logger bound to `sessions.lifecycle` matches `sessions`; an unknown module name is a usage error. Runtime change via `PATCH /api/v1/system/log-level` or `SIGUSR2` (re-reads the config file's `logLevel`).

**Sandbox lines** (module `browsers.sandbox`, D-27). `sandbox fell back` (`warn`, once per browser executable per process under `sandbox=auto`; fields `channel`, `executable`, `reason`), `sandbox skipped as root` (`warn`, at boot under `auto` as root), `sandbox verified` (`info`, the `sandbox=on` boot check passed; `channel`, `version`), `sandbox required` (`error`, the boot check failed just before the refusal; `channel`, `reason`, `working`). A fallback is not a degradation record: it is the expected state of a host that cannot sandbox, shown on `/system` (`browser.channels[].sandbox`) and by `doctor`, not an incident. `browser launched` carries `sandboxed`.

### 4.2 Renderers

- **JSON lines** (default when not a TTY, always under `--logFormat json`): one object per line, keys ordered `ts, level, msg, module, trace_id, span_id, request_id, session_id, …rest`, whole line passed through the secret scrubber.
- **Pretty** (default on a TTY): a column-aligned layout — `HH:MM:SS.mmm LEVEL message key=value …` with the priority field order (`tool, session_id, slug, url, pattern, code, error_code, result, source, event, entry_name, duration_ms, result_size_bytes`), continuation lines indented to the field column, unbreakable tokens overflow intact, `err.stack` last. Messages fit the 26-character message column so fields stay aligned; the grep-rules test enforces it on `logger.<level>('…')` literals (05 §7). Colors: level colors, dim time, red for codes/errors, yellow url/pattern, blue session ids, cyan numbers, magenta message when `vault: true` (the marker survives when colors are off as a `[vault]` tag). `FORCE_COLOR` (≠ `0`) → on; `NO_COLOR` non-empty → off; `TERM=dumb` → off; else TTY detection. `--color auto|always|never` overrides.

### 4.3 Sinks and stream discipline

| Transport | Logs | Banners/CLI status |
|---|---|---|
| http, TTY | pretty → stdout | stdout |
| http, piped | JSON → stderr | stdout |
| stdio | **always stderr** (JSON unless `--logFormat pretty`) | stderr |

Under stdio, stdout is the MCP byte stream: at startup the process replaces `console.*` with the logger (all levels → stderr) **unconditionally**, not by prefix allow-list: any dependency may write to `console`, and one stray line corrupts the JSON-RPC stream. Additional sinks: an in-process ring buffer (5 000 records, `--logRingSize`) feeding `/api/v1/logs` and the `logs` WS topic; an optional durable `logs` table (`--logPersist info|warn|off`, default `off`; retention 3 d); OTLP logs when `--otel` is on. Sinks never throw; a failing sink increments a counter and is disabled after 10 consecutive failures with a `system.degraded`.

### 4.4 API

`logger.child({ module, session_id })` returns a bound logger; `logger.withContext()` is implicit (§5). Serializers: `err` (via `serializeError`), `url` (sanitized), `duration` (number ms). No module defaults to a silent logger; the composition root injects one logger and tests inject a collecting logger.

---

## 5. Request context and correlation (D-08)

`kernel/context.ts` wraps `AsyncLocalStorage<RequestContext>`:

```ts
interface RequestContext { trace_id: string; span_id: string; request_id?: string; session_id?: string; event_id?: string; principal?: string; transport: 'http'|'stdio'|'ws'|'cli'; }
```

Entry points that establish it: the HTTP `requestId` middleware (adopting inbound `traceparent`, emitting `traceparent` on responses), the MCP dispatcher (per tool call; adopts `_meta.traceparent` or `_meta.traceId` from the client when present; `event_id` doubles as the tool span's id), the WS command dispatcher (connection id + command corr), and CLI commands. OTel's `AsyncLocalStorageContextManager` is the same storage mechanism, so `trace.getSpan(context.active())` and the logger agree (asserted by the telemetry tests, 09 §3.2). The logger stamps `trace_id`/`span_id`/`request_id`/`session_id`/`principal` on every record automatically.

---

## 6. Span catalogue

All spans use `@opentelemetry/api`'s tracer `browserhive`; attributes use the `browserhive.*` namespace plus standard `http.*`/`db.*` where they fit.

| Span | Attributes |
|---|---|
| `mcp.tool_call` (root for a tool call) | `browserhive.tool`, `browserhive.session_id`, `browserhive.tab_id`, `browserhive.principal`, `browserhive.event_id`, `browserhive.ok`, `browserhive.error_code`, `browserhive.result_bytes` |
| `session.create` + children `session.validate`, `session.admit`, `session.reserve`, `session.prepare_profile`, `session.resolve_identity`, `session.launch`, `session.install_policies`, `session.start_tracing`, `session.apply_identity`, `session.register` | `browserhive.session_id`, `browserhive.channel`, `browserhive.stealth`, `browserhive.persistence_mode`, `browserhive.phase_ms` |
| `session.close` | `browserhive.reason` |
| `browser.launch` | `browserhive.driver` (`playwright`/`patchright`), `browserhive.channel`, `browserhive.headless` |
| `page.navigate` | `url.full` (sanitized), `http.response.status_code`, `browserhive.wait_until` |
| `cdp.command` (debug sampling only) | `browserhive.cdp.method` |
| `vault.fill` + `vault.resolve_entry`, `vault.check_origin`, `vault.confirm`, `vault.fetch`, `vault.type`, `vault.submit` | `browserhive.entry_name`, `browserhive.result`, `browserhive.reason` |
| `attention.wait` | `browserhive.request_id`, `browserhive.mode`, `browserhive.status` |
| `db.query` (adapter-level, debug sampling) / `db.drain` | `db.system=sqlite`, `db.operation`, `browserhive.rows` |
| `db.migrate` + `db.migrate.step` | `browserhive.from_version`, `browserhive.to_version`, `browserhive.backup_path` |
| `http.request` | `http.request.method`, `http.route`, `http.response.status_code`, `browserhive.principal` |
| `ws.command`, `ws.broadcast` | `browserhive.ws.command`, `browserhive.ws.topic`, `browserhive.ws.recipients` |
| `retention.sweep`, `outbox.sweep`, `lease.sweep` | counts pruned/failed |
| `screencast.frame` (never exported; metrics only) | — |

`--otelSampleRatio` (default 1.0) applies a parent-based ratio sampler; `db.query` and `cdp.command` are additionally gated behind `--otelVerbose`.

---

## 7. Metrics catalogue

| Instrument | Type | Attributes |
|---|---|---|
| `browserhive.tool_calls` | counter | `tool`, `ok`, `error_code` |
| `browserhive.tool_call.duration` | histogram (ms) | `tool` |
| `browserhive.sessions.active` | up-down counter | `state` |
| `browserhive.session.launch.duration` | histogram (ms) | `channel`, `stealth` |
| `browserhive.session.lifetime` | histogram (ms) | `closed_reason` |
| `browserhive.ws.connections` | up-down counter | — |
| `browserhive.ws.buffered_bytes` | gauge (observable) | `connection_id` capped to 50 series |
| `browserhive.ws.frames_dropped` | counter | `channel` |
| `browserhive.db.write_queue.depth` | gauge | — |
| `browserhive.db.dropped_writes` | counter | `table` |
| `browserhive.db.size_bytes` | gauge | — |
| `browserhive.browser.rss_bytes` | gauge (observable; sampled every 10 s from the process tree) | `session_id` |
| `browserhive.attention.open` | up-down counter | `kind` |
| `browserhive.attention.wait` | histogram (ms) | `status` |
| `browserhive.vault.fills` | counter | `result` |
| `browserhive.blocklist.hits` | counter | `source` |
| `browserhive.retention.pruned_rows` | counter | `table` |
| `browserhive.process.*` | gauges: rss, heap, event-loop lag (sampled) | — |

The same registry backs `/api/v1/system` figures; with `--otel` off, the in-process meter provider is the SDK's no-op.

---

## 8. OpenTelemetry wiring

```
--otel true|false                (BROWSERHIVE_OTEL / OTEL_SDK_DISABLED inverse)   default false
--otelEndpoint <url>             (BROWSERHIVE_OTEL_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT)  default http://127.0.0.1:4318
--otelProtocol http/protobuf|http/json  (OTEL_EXPORTER_OTLP_PROTOCOL)             default http/protobuf
--otelHeaders k=v,k2=v2          (OTEL_EXPORTER_OTLP_HEADERS)                     secret; redacted in /system/config
--otelServiceName <name>         (OTEL_SERVICE_NAME)                              default browserhive
--otelSampleRatio <0..1>         (OTEL_TRACES_SAMPLER_ARG)                        default 1
--otelSignals traces,metrics,logs                                                default all three
--otelVerbose                    include db.query / cdp.command spans             default false
```

`OTEL_*` variables are a lower-precedence source than `BROWSERHIVE_*` (they slot below env in the ladder, above defaults). When enabled, `infra/telemetry/otel.ts` constructs `BasicTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter`, `MeterProvider` + `PeriodicExportingMetricReader` (30 s) + `OTLPMetricExporter`, `LoggerProvider` + `BatchLogRecordProcessor` + `OTLPLogExporter` (the logger's OTLP sink forwards records), with resource attributes `service.name`, `service.version`, `service.instance.id` (data-dir instance id), `host.name`, `os.type`, `browserhive.transport`. Export failures are counted and surface as a `system.degraded` after 5 consecutive failures; they never affect serving. `stop()` calls `forceFlush()` then `shutdown()` within the storage budget. When disabled, no SDK module is imported (dynamic import), and the API's no-op providers stay in place.

---

## 9. Redaction by construction (D-20)

- `contracts` marks sensitive fields with `sensitive()` (a zod brand/metadata): passwords, tokens, cookie values, `Authorization`, `otelHeaders`, vault passphrases/tokens, `type_text.text`/`fill.value` when a redaction window is open.
- `toWire(value, policy: 'log'|'persist'|'wire'|'export')` in `kernel/codec.ts` is the only serializer used by sinks. It applies: schema-marked redaction, the `SecretRegistry` substring scrub (ref-counted per session window, plus always-on entries), key-name heuristics as a backstop (`password, passwd, secret, token, api_key, apikey, authorization, cookie, credential, private_key, master, passphrase`), depth/size caps, and URL sanitization (`sanitizeUrl`: strips query and fragment unless the key is in `--urlQueryAllowlist`, keeps origin + path; applied on persist/wire/export policies, not on the in-memory session URL).
- Every minted secret is registered at birth: seed password, seed token, issued tokens, grants, cookies, `bw` session tokens, vault credentials during a fill. Operator-supplied config secrets are registered in the `observability` phase, before the first log line: every key flagged `secret: true` has an extractor in `app/config/secret-literals.ts` (a test fails when one is missing) — for `authTokens` the token of each `name:token` pair (never the name, which is a principal label), for `otelHeaders` each value plus the credential after an auth scheme (never the scheme word itself).
- Error projections run through `toWire` too, so an error message that echoes a typed value cannot carry a secret past the redaction window.
- `--screenshotTrace` skips frames while a session's secret window is open; `vault_fill` is excluded from screenshot tracing.
- Property test: for every sink (log line, DB row, WS frame, MCP result, problem+json, OTLP payload, export stream) inject a sentinel secret through every documented path and assert the sentinel never appears.

---

## 10. Dashboard log tailing

`/api/v1/logs` serves the ring buffer newest first by default (`dir=desc`, cursors page to older records and are bound to their `dir`; `after_seq` fills a reconnect gap; the body carries `latest_seq`, 03 §4.7) with filters (`level[]`, `module[]`, `session_id`, `trace_id`, `request_id`, `q`, `since`, `until`); export stays oldest first. `logs.tail` on the WS subscribes to the `logs` topic with a server-side filter; the topic is live only (no replay) and droppable under backpressure (never blocks the feed). Reserved optional keys of a record are absent, never `null`, and a misfit value moves to `fields.<key>`, so one odd record cannot fail a page or a frame. Dashboard access lines (assets, successful cookie-operator reads, health) log at `debug`, so the default `info` tail is not the dashboard's own polling (03 §2). The dashboard's `/logs` page filters by `session_id`/`trace_id`/`request_id`. With `--otel` on, the same page shows an "open in APM" link built from `--otelTraceUrlTemplate` (e.g. `https://grafana/explore?traceId={trace_id}`).

---

## 11. What not to log

- Credential values, tokens, cookies, passphrases, `Authorization`/`Cookie` headers, OTLP headers.
- Full URLs with query strings/fragments (sanitize first).
- Page HTML, `evaluate` results, typed text at `info` (allowed at `debug` only when no secret window is open and `--recordToolResults=full`).
- Screenshot bytes, screencast frames.
- Anything under stdio to stdout.
- Health-check requests above `debug`.

---

## 12. Design notes

- `INTERNAL_ERROR` is a first-class registry entry with `details.ref` (the request id), so an agent can quote it to an operator, who finds the full private message and cause chain in the logs.
- The `trace` level (below `debug`) exists for per-CDP-command logging; it never leaves the ring buffer unless `--otelVerbose` is set.
