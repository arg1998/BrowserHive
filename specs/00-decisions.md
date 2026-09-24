---
title: "Architecture decision log"
spec: "00"
status: Normative
scope: The cross-cutting architecture decisions of BrowserHive (runtime, packaging, persistence, contracts, configuration, errors, telemetry, identity, realtime, dashboard, tool surface, stealth, vault, operator requests, notifications, testing, publishing, privacy, session lifecycle, naming, data layout) with their context, consequences and rejected alternatives.
audience: Contributors changing anything that crosses a package or subsystem boundary; reviewers checking a change against the recorded design.
related:
  - README.md
  - 01-overall-architecture.md
  - 02-mcp-and-tools.md
  - 03-admin-backend.md
  - 04-admin-frontend.md
  - 08-cli-arguments-and-config.md
  - 10-error-handling-and-telemetry.md
  - 11-stealth.md
---

# 00 — Architecture decision log

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

## About this log

**Purpose.** This log records every decision that shapes more than one subsystem, together with the reason it was made. The topic specs (01–12) describe *how* each subsystem works; this log records *why* the cross-cutting choices are what they are, so that they are not re-argued without new information.

**Citation.** Each entry has a permanent identifier `D-NN`. Specs, code comments and tests cite entries by that identifier (for example `// never attention-gated (D-10)`). Identifiers are never renumbered or reused; a decision that is replaced keeps its identifier and its text is rewritten to the current design.

**Precedence.** If a topic spec and this log disagree, this log wins and the spec is corrected.

**Status values.**

| Status | Meaning |
|---|---|
| Proposed | Under discussion; not yet binding. |
| Accepted | Binding; the codebase implements it. |
| Deprecated | Still implemented, scheduled for removal; new code MUST NOT depend on it. |

**Entry template.**

```
## D-NN Title

**Status:** Accepted

**Context.** The forces and constraints that make a decision necessary.

**Decision.** What is decided, stated as the current design.

**Consequences.** What follows from it: obligations, costs, seams, follow-on rules.

**Alternatives considered.** Options that were evaluated and why they were rejected (omitted when there was no meaningful alternative).
```

---

## D-01 Runtime: Bun only

**Status:** Accepted

**Context.** BrowserHive is a long-running local daemon that needs an embedded database, an HTTP and WebSocket server, password hashing and a test runner. Supporting two JavaScript runtimes would double each of those integration points and the test matrix.

**Decision.** BrowserHive runs on **Bun ≥ 1.4** and nothing else. Node.js is not a supported runtime. Bun primitives are used directly: `Bun.serve` (HTTP and WebSocket), `bun:sqlite`, `Bun.password` (Argon2id), `Bun.semver`, `Bun.file`.

**Consequences.**
- The published package's `bin` uses `#!/usr/bin/env bun`. npm, pnpm and bun all create the shim; `engines.bun`, the README, the install docs and `browserhive doctor` (minimum Bun version check) make the requirement explicit.
- SQLite needs no native build step (no node-gyp), and the whole test suite exercises the same `bun:sqlite` driver that production uses.
- Third-party runtime dependencies are limited to what Bun does not provide: `hono`, `@hono/zod-openapi`, `@modelcontextprotocol/sdk`, `zod`, `kysely`, `playwright`, `patchright`, `tldts`, `nanoid`, `fflate` (profile zips, D-24), OpenTelemetry packages (D-08).
- Standalone per-OS binaries built with `bun build --compile` (for users who do not want to install Bun) are on the roadmap; not built.

**Alternatives considered.**
- *Node.js and Bun both supported.* Requires a second SQLite driver (`better-sqlite3` or `node:sqlite`), a second HTTP/WebSocket listener stack (`@hono/node-server`, `ws`), a WASM or native Argon2 implementation (`hash-wasm`), and a CI matrix in which the Node leg cannot run the `bun:sqlite` tests. Rejected as permanent duplication for no user-visible gain.
- *Node.js only.* Loses the built-in SQLite, password hashing and test runner, each of which would become a dependency with its own native-build or WASM cost.

## D-02 One process, one port: official MCP SDK and Hono on `Bun.serve`

**Status:** Accepted

**Context.** Agents speak MCP; operators use a dashboard and a REST API; both observe the same browser sessions. Every extra listener is another port to configure, secure and document.

**Decision.** The MCP server is `McpServer` from `@modelcontextprotocol/sdk` with the SDK's web-standard Streamable HTTP transport, mounted in a **Hono** app served by a single `Bun.serve`.

Route map on `http://<host>:<port>`:

| Path | What |
|---|---|
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP (bearer auth when `auth=token`) |
| `/api/v1/*` | Admin REST (zod-openapi), problem+json errors |
| `/api/v1/openapi.json`, `/api/v1/docs` | Generated OpenAPI 3.1 and a reference UI |
| `/api/v1/ws` | Admin realtime WebSocket (feed, screencast, input) |
| `/health` | Unauthenticated liveness/readiness (composition phase) |
| `/` and SPA routes | Dashboard when `admin=true`; a minimal status page otherwise |
| `/trace-viewer/*` | Playwright trace viewer bundle (behind admin auth) |

- One `McpServer` instance is created **per MCP Streamable HTTP session**, because the SDK binds exactly one transport to a server instance; the tool registry, dispatcher and application services behind it are shared.
- Authenticated `/mcp` requests disable Bun's per-connection idle timeout (`server.timeout(request, 0)`). A blocked `request_attention`, a confirm-gated `vault_fill` or a pending `get_attention_result` writes nothing to its SSE stream until an operator decides, and the transport's 25 s keep-alive is slower than Bun's 10 s default idle timeout; without the override Bun closes the stream, the SDK client gives up after its resumption attempts, and the result never reaches the agent. REST and static routes keep the default timeout.
- `--transport stdio` is a separate single-client mode: no HTTP listener, no dashboard, no attention, principal `local`. A process runs one transport, never both.

**Consequences.**
- One `--host`/`--port` pair configures everything; there are no separate admin listener flags. Unsupported flag spellings produce a "did you mean" hint (D-06).
- The host guard, origin guard and authentication middleware protect MCP, REST and WebSocket uniformly (spec 03 §2).
- stdout under stdio is reserved for JSON-RPC; every log line goes to stderr.

**Alternatives considered.**
- *A higher-level MCP framework on top of the SDK.* Adds a layer whose session, error and auth model differ from the SDK's and lag its releases; the official SDK's web-standard transport mounts directly in Hono.
- *Separate admin listener (own bind address and port).* Two ports to secure and document, two CSP/origin configurations, and cross-origin calls between the dashboard and its API. Rejected.
- *stdio and HTTP in one process.* stdio implies exactly one client bound to the process lifetime; mixing it with a multi-client HTTP daemon makes ownership and shutdown ambiguous.

## D-03 Package topology

**Status:** Accepted

**Context.** The code has four audiences: wire contracts shared by server and dashboard, server internals, the browser SPA, and the published CLI/programmatic API. Boundaries between them must be enforced, not documented.

**Decision.** Bun workspaces with four packages; boundaries enforced by `dependency-cruiser` and TypeScript project references:

```
packages/
  contracts/    @browserhive/contracts  zod schemas, error registry, config schema, tool contracts, WS protocol, REST DTOs. Platform-neutral. Deps: zod only.
  core/         @browserhive/core       everything server-side: domain, infra, application services, interfaces (mcp tools, http, ws). Internal layers enforced by dependency-cruiser (01 §4).
  dashboard/    @browserhive/dashboard  React SPA (Vite). Imports only @browserhive/contracts.
  browserhive/  browserhive             the published package: CLI, composition root, programmatic API. Bundles core + dashboard.
```

**Consequences.**
- Only `browserhive` is published; `contracts`, `core` and `dashboard` are internal and bundled into it.
- `core` is split into layers rather than packages: for a codebase of this size, more packages add release and build ceremony, while `dependency-cruiser` rules give the same import guarantees.
- If the dependency graph later justifies it, `core/src/infra/persistence` and `core/src/interface/http` are the first split candidates.

**Alternatives considered.**
- *One package per layer or subsystem.* More `package.json` files, project references and version bookkeeping for no additional guarantee over lint-enforced layers.
- *A single package.* The dashboard could import server code, and the wire contracts could not be shared without pulling in server dependencies.

## D-04 Persistence: `bun:sqlite`, Kysely and an owned migration runner

**Status:** Accepted

**Context.** BrowserHive records an audit trail, session state, identity and vault policy on the operator's machine. Storage must be embedded, crash-safe, upgradeable, and safely downgradeable within limits.

**Decision.**
- **Driver:** `bun:sqlite`, one connection, one writer (the process). PRAGMAs asserted by test: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, `application_id=0x42484956` ("BHIV").
- **Query layer:** Kysely (pinned exact) with an in-repo `bun:sqlite` driver. Kysely types and `sql` never leave `core/src/infra/persistence/`. Repositories are hand-written Promise-returning ports; the SQLite adapter implements them. Reporting queries live in a separate `AnalyticsQueries` read model. Row types are generated by `kysely-codegen` from a freshly migrated database and verified in CI; wire types are zod (D-05); explicit mappers join them.
- **Migrations:** forward-only, embedded as TypeScript in one ordered array; `SCHEMA_VERSION` is the last entry. Runner: `busy_timeout` → `VACUUM INTO` backup (`<data-dir>/backups/browserhive-v<from>-<ts>.db`, newest 5 kept) → `BEGIN IMMEDIATE` → read `user_version` → apply pending migrations → set `user_version` in the same transaction → `COMMIT`. `foreign_keys=OFF` before `BEGIN` for table rebuilds; SQLite's `legacy_alter_table=1` where views exist. A `schema_migrations` audit table (version, name, applied_at, duration_ms, app_version) is surfaced on `/api/v1/system`.
- **Drift:** a CI test migrates a throwaway database and compares a pragma-normalised schema fingerprint (`pragma_table_xinfo`, `index_xinfo`, `foreign_key_list`, sorted, plus trigger and view SQL) with a committed golden; fixture databases for every shipped schema version are replayed through the runner.
- **Downgrades:** no `down()` code. The database stores `user_version` (current schema) and `meta.min_reader_version` (oldest schema version whose code can still read it). A migration declares `compatible: true` when it is purely additive, and then `min_reader_version` is not raised. An older binary opening a newer database opens it normally when `SCHEMA_VERSION >= min_reader_version` (all SQL uses explicit column lists); otherwise it refuses with `DB_NEWER_THAN_BINARY`, naming the pre-upgrade backup and `browserhive db restore <file>`.
- **What lives where:** structured state lives in SQLite under this runner: audit and event rows, sessions, principals and credentials, auth sessions and tokens, vault bindings and group policies, notifications and preferences. Files stay files where they are large binary artefacts or must be usable by other tools: browser profiles, traces, screenshots, downloads, uploads, auth-state snapshots, database backups and the config file.

**Consequences.**
- Safe downgrade within a compatibility window and an explicit, auditable restore path outside it, at a fraction of the code and test surface of bidirectional migrations.
- Every schema change ships with a migration, a regenerated fingerprint golden, regenerated row types and a new fixture database.
- One writer means writes are queued (spec 03 §7.2); reads never block on the queue.

**Alternatives considered.**
- *`down()` migrations.* Doubles migration code, is rarely exercised, and cannot restore dropped data. Rejected in favour of backups plus the reader-version window.
- *An ORM with its own migration system.* Hides SQL that must be reviewed for WAL, index and retention behaviour, and ties the schema to the ORM's model layer.
- *JSON files for configuration-like state (bindings, policies, credentials, tokens).* No transactions with the audit rows they govern, no concurrent-writer safety, and a second backup story. JSON export/import is kept for hand editing (D-14).

## D-05 Contracts: zod-first, generated OpenAPI, snake_case wire

**Status:** Accepted

**Context.** Three wire surfaces (MCP, REST, WebSocket) and two consumers (agents and the dashboard) must agree on every shape, and drift between server, client and documentation must fail the build.

**Decision.**
- `@browserhive/contracts` is the only place a wire shape is defined: MCP tool inputs and outputs, REST request/response DTOs, the WS envelope and messages, the config schema, the error registry, and domain enums (`z.enum`).
- REST is built with `@hono/zod-openapi` (`createRoute` + `OpenAPIHono`); responses are typed against the schema, so drift fails `tsc`. OpenAPI 3.1 is served at `/api/v1/openapi.json` and a reference UI at `/api/v1/docs`. The dashboard uses Hono's typed client and parses responses at runtime in development.
- Wire JSON is **snake_case** on every surface: the MCP tool parameters and results are snake_case (D-12), and REST and WS use the same vocabulary so one set of field names exists. TypeScript identifiers are camelCase; the config file is camelCase (D-06). Timestamps are epoch milliseconds as numbers, never strings.
- HTTP errors are RFC 9457 `application/problem+json` (D-07).

**Consequences.**
- Generated artefacts (OpenAPI document, reference docs, tool goldens) are committed and checked in CI; they are regenerated from the contracts, never edited by hand.
- The dashboard cannot import server code (D-03) and depends only on contracts.

**Alternatives considered.**
- *Hand-written OpenAPI with generated types.* Two sources of truth for the same shape.
- *camelCase wire for REST and WS.* Would give agents and operators two spellings of the same field (`session_id` in tools, `sessionId` in REST).

## D-06 Configuration ladder and naming

**Status:** Accepted

**Context.** BrowserHive runs as a CLI, a service with environment variables, a checked-in config file, and an embedded library. Operators must be able to predict which source wins and see why a value is what it is.

**Decision.**
- Precedence, lowest to highest: **defaults < environment variables < `browserhive.config.json` < CLI arguments**. When a key is supplied by more than one source, one info line is logged at startup: `config: maxSessions=8 (cli) shadows config-file=4, env=2`. Standard `OTEL_*` variables are a sub-source below `BROWSERHIVE_*` variables (D-08).
- Every key exists in all three sources. Naming: env `BROWSERHIVE_<SCREAMING_SNAKE>`, CLI `--camelCase`, JSON `camelCase`.
- Unknown keys, typos and invalid values fail fast (exit 64) with a "did you mean" hint; recognised alternative spellings (for example kebab-case flags or an older environment variable name) are reported with the canonical key.
- Value grammars are uniform: every duration accepts a unit (`30s`, `2h`); a bare number is milliseconds everywhere, including `minAttentionWait`.
- One zod schema in `contracts/config` generates the TypeScript type, the parser, `--help`, the JSON Schema for the config file, and the configuration reference. The programmatic API validates options with the same schema.
- Configuration is resolved once, at the composition root, into a deep-frozen object with provenance and injected from there. Only the config resolver and the composition root read `process.env`; host facts reach core through the injected `HostEnvironment` port, so tests can isolate every environment-dependent behaviour.

Full design in `08-cli-arguments-and-config.md`.

**Consequences.**
- Adding a key is one schema entry; its env name, flag, JSON Schema entry, help text and docs row follow.
- `GET /api/v1/system/config` reports each key's effective value, source and shadowed values (secrets redacted).

**Alternatives considered.**
- *Config file above CLI.* Surprises operators who pass a flag to override a checked-in file.
- *kebab-case flags.* A second spelling of every key; camelCase flags match the JSON keys one-to-one.

## D-07 Error model: one registry, three projections

**Status:** Accepted

**Context.** The same failure (for example a missing session) can surface through an MCP tool call, a REST request or a WebSocket command. Agents need stable codes and retry guidance; operators need HTTP-native errors; documentation must list every code.

**Decision.**
- `contracts/errors` holds a registry of every error code (`code → { httpStatus, category, retryable, title, message, hint, detailsSchema }`). `AppError` in core is the one throwable type and takes its facts from the registry.
- **MCP projection:** a tool result with `isError: true`, one `text` block `"[CODE] message"`, and the structured error `{code, message, retryable, hint?, details?}` in `_meta['browserhive.ai/error']`. The structured error is deliberately **not** placed in `structuredContent`: the MCP SDK client validates any `structuredContent` against the tool's `outputSchema`, error results included, so an error payload there would turn every tool error into a client-side protocol exception for SDK-based agents. Successful results carry `structuredContent`.
- **HTTP projection:** `application/problem+json` with `type` pointing at the error reference entry for the code.
- **WS projection:** an `error` frame `{code, title, details?}` correlated to the command.
- Tool failures use typed codes (`NAVIGATION_TIMEOUT`, `NAVIGATION_FAILED`, `WAIT_TIMEOUT`, `DOWNLOAD_FAILED`, `UPLOAD_FAILED`, `SCRIPT_ERROR`, `ELEMENT_NOT_ACTIONABLE`, …); `INTERNAL_ERROR` is reserved for genuinely unexpected failures and carries a `ref` for log correlation.
- Boot failures are registry codes too: `PORT_IN_USE`, `BIND_FAILED`, `CONFIG_INVALID`, `CONFIG_UNKNOWN_KEY`, `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`, `BROWSER_NOT_INSTALLED`.
- A version precondition failure (`If-Match` mismatch) is `409 CONFLICT` with `details.current_version`; the API uses 409 for every precondition failure, never 412.

Details in `10-error-handling-and-telemetry.md`.

**Consequences.**
- The error reference (`docs/reference/errors.md`) is generated from the registry.
- The tool error codes and their meanings are part of the stable tool contract (D-12); new codes are additive.
- Registry categories distinguish thrown errors from `audit` codes (soft-failure classifications that are recorded, never thrown) and `warning` codes (session warnings).

**Alternatives considered.**
- *Structured error in `structuredContent`.* Breaks SDK clients as described above.
- *Per-surface error enums.* Three lists drift; retry guidance would be duplicated.

## D-08 Telemetry: OpenTelemetry API in core, exporters opt-in

**Status:** Accepted

**Context.** BrowserHive is local-first: nothing may leave the host by default. Operators who run an observability stack want traces, metrics and logs in it without a plugin.

**Decision.**
- `@opentelemetry/api` is a core dependency; every span is an OTel span. With telemetry off, the API's no-op provider is installed and overhead is negligible.
- Export is enabled by `otel` (`--otel`, `BROWSERHIVE_OTEL`), with `otelEndpoint` (OTLP/HTTP, default `http://127.0.0.1:4318`), `otelProtocol` (`http/protobuf|http/json`), `otelHeaders` and `otelServiceName`. Standard `OTEL_*` variables are honoured below `BROWSERHIVE_*` (D-06). Traces, metrics and logs go out via OTLP, so any OTLP backend works. `otelTraceUrlTemplate` turns a stored `trace_id` into a deep link from the dashboard into the operator's APM.
- **Correlation:** one `AsyncLocalStorage` request context is opened at each entry point (HTTP middleware, MCP tool dispatch, WS command dispatch). Every log record carries `trace_id`, `span_id`, `request_id`, `session_id` and `principal` when present; absent keys are omitted, never `null`. Tool-call rows store `trace_id`.
- **Logs:** a structured logger (JSON lines or a pretty renderer) with `child()` bindings, error serializers, and per-module levels (`logLevel` accepts `info,sessions=debug`; a `trace` level sits below `debug`). An in-process ring buffer (5 000 records) serves `GET /api/v1/logs` (newest first by default, cursors bound to their direction, `after_seq` for reconnect gap fill) and the live-only `logs` WS topic. The runtime level can be changed with `PATCH /api/v1/system/log-level`.
- **Access log levels:** health checks, non-API paths (dashboard assets, trace viewer) and successful `GET`/`HEAD` API reads by a password-session operator log at `debug`; everything else logs at `info`. The dashboard polls and refetches constantly, and at `info` its own reads would dominate the log tail an operator is trying to read.

**Consequences.**
- Nothing leaves the host unless `otel` is on.
- Instrumentation is written once against the API; exporter packages load only when enabled.

**Alternatives considered.**
- *A vendor SDK or a custom metrics endpoint.* Locks operators to one backend; OTLP is accepted by all common ones.
- *Logs only in files.* The dashboard needs a filterable live tail without shell access.

## D-09 Identity, authentication, authorization

**Status:** Accepted

**Context.** The agent is untrusted and the operator is trusted. Several agents may share one daemon, operators script the admin API, and trace links must open in contexts that cannot send cookies. Multi-user support is not built, but the data model must not preclude it.

**Decision.**
- `RequestPrincipal { subject, kind: 'operator'|'agent'|'service', display, auth: { method, session_id?, credential_id?, expires_at? }, scopes, tenant_id: null, must_change_password }` is produced by one `AuthenticationProvider` chain: `password-session` (cookie), `bearer` (tokens), `grant` (short-lived, single-use links for traces and screenshots). The first provider that recognises a credential decides; a present-but-invalid credential fails with 401 and never falls through to another provider or to `local`.
- `Authorizer.can(principal, scope, resource?)` is called from route and tool descriptors, never hand-inlined. Operators hold every scope; agents hold tool scopes; an operator API token may be issued with a subset. Session ownership is enforced for **every** tool that names a session or request, including `close_session`, `list_sessions`, `list_saved_auths` and `get_attention_result`; a foreign resource is indistinguishable from an unknown one.
- Tables: `principals`, `credentials` (hashed secrets with a public prefix; kinds `password`, `api_token`), `auth_sessions`, `grants`, `auth_events`. The single operator is one `principals` row of kind `operator` with `must_change_password`. `tenant_id` exists as a nullable column on tenant-scoped tables and is applied in one data-access chokepoint; nothing else about tenancy is built.
- **Seed flow:** on the first HTTP start with `admin=true`, a 24-character operator password is generated (unbiased rejection sampling over a CSPRNG), printed once and written to `<data-dir>/admin/credentials.txt` (0600); the first login forces a change, after which the file is overwritten and unlinked. Under `auth=token` with no stored or configured tokens, a token for principal `agent-1` is minted and printed once. `browserhive admin reset-password` and `browserhive admin tokens list|create|revoke` manage credentials from the CLI.
- **Rate limits:** token buckets keyed by principal (or client IP for public routes), default 600 requests/min. `GET`/`HEAD` requests by a password-session operator on routes without their own rule use a separate 6 000 requests/min bucket. Every dashboard tab shares the operator principal and one page load issues 12–17 reads, so a few open tabs would exhaust 600/min and lock the operator out of their own dashboard; these reads are already authenticated by a `SameSite=Strict` cookie, and 100 requests/s still bounds a runaway client. Mutations, bearer and grant callers stay on the default bucket; login keeps its own strict limit and lockout.

**Consequences.**
- A future identity provider (for example better-auth with admin, organization, API-key or SSO plugins) plugs in as one more provider; its Kysely adapter can share the SQLite handle and its migrations fold into the runner (D-04). No cloud dependency is required.
- Reconnecting agents keep their browser sessions because ownership is keyed on the principal, never on the MCP session id.

**Alternatives considered.**
- *Ownership keyed on the MCP session id.* A reconnect would orphan every browser session.
- *One global rate limit for operators.* Locks out the dashboard as described above.

## D-10 Realtime: Bun WebSocket, versioned envelope, topics, two channels

**Status:** Accepted

**Context.** The dashboard shows live session state, a live browser view with operator input, a log tail and notifications. Feed data must be ordered and resumable; video frames must be low-latency and may be dropped.

**Decision.**
- Hono `upgradeWebSocket` performs the handshake; the handler uses the raw Bun `ServerWebSocket` (send status, `bufferedAmount`) for fan-out. One socket per dashboard tab, subprotocol `browserhive.v1`.
- Envelope `{ v: 1, kind: 'event'|'reply'|'error'|'stream', seq, ts, topic?, corr?, payload }`.
- **Feed channel:** ordered, resumable (`subscribe {topic, cursor}` → replay, or `complete:false` meaning re-seed from REST), bounded buffer (count, bytes and age). Feed events carry full DTOs so clients patch their cache without refetching.
- **Screencast channel:** latest-wins per (session, connection), binary frames, per-viewer size (`screencast.set_size` → CDP `maxWidth/maxHeight`), dropped under backpressure. Start, stop and resize are serialised per connection and per session; the command reply and `started` precede `meta` and the first frame; a captured frame is pushed on every (re)start so static pages are never blank; a size change restarts the screencast; the bridge follows the agent's active tab; CDP failures are `SCREENCAST_FAILED` with a `failed` control message.
- **Topics** map 1:1 to REST resources: `sessions`, `session:<id>`, `attention`, `vault.confirm`, `vault.config`, `vault.access`, `pages`, `blocklist`, `system`, `logs`, `notifications`, `screencast:<id>`. The navigation-history resource is named `pages` on both REST and WS (the dashboard labels it "Websites"). `vault.access` and `pages` are fleet-wide static topics so list pages update live without subscribing to every session.
- Session `counts` (tool calls, errors, pages, blocked, open attention, vault access) are maintained in memory from the event bus for live sessions, identical across list rows, detail and `session.updated`, which is published on every change (coalesced 250 ms).
- `session.set_viewport` is **not** attention-gated: it is an observability control. Operator `input` is gated per message on an open `takeover` attention request.

**Consequences.**
- The WS layer never synthesises events; every event comes from the application event bus (01 §5).
- The `logs` topic is live only (no replay); clients fill gaps through REST.

**Alternatives considered.**
- *Server-Sent Events for the feed.* No client→server channel for screencast control and operator input; a second transport would be needed.
- *Polling only.* Cannot carry a live view and multiplies request volume.

## D-11 Dashboard stack

**Status:** Accepted

**Context.** Operators use the dashboard for long periods to watch many sessions, take over a browser and audit what agents did. It must be fast, dense but legible, keyboard-accessible, and maintainable by a small team.

**Decision.**
- React 19, Vite 8, TypeScript strict. shadcn/ui components on Base UI primitives, Tailwind v4, components copied into the repo and owned there. TanStack Router (History API, typed zod search params, one route table generating navigation, breadcrumbs, the command palette and `document.title`). TanStack Query v5 with the WS bridge patching the cache. TanStack Table (manual mode) and TanStack Virtual. react-resizable-panels v4. react-hook-form + zod. lucide-react. Geist Sans/Mono self-hosted. Theme tri-state system/light/dark with an inline bootstrap.
- Charts and bar lists are hand-rolled SVG so every bucket is a real link and tooltips cannot stick; no charting library. Toasts use the Base UI toast manager and sit below dialogs so a toast never covers a confirmation. The command palette is a custom combobox whose Sessions section queries the server.
- App frame: a sidebar (240 px, 56 px rail) that the operator pins at any width ≥ 768 px, with a hover peek that never reflows content, and a drawer below 768 px; the document is the only scroller, and pages that need independent panes opt into a fixed-height workspace; there is no page width cap.
- Only a 401 signs the operator out; rate-limit, server and network failures keep the shell with a retry banner.
- The production bundle is built without source maps, keeping the published package small and free of source text.
- **Development loop:** `bun run browserhive --admin` runs the daemon from source and a Vite dev server next to it on `--port` + 10000, which serves the dashboard with hot reload and proxies API paths to the daemon. The dev URL therefore differs from the daemon's; the script prints it.

Details in `04-admin-frontend.md`.

**Consequences.**
- UI primitives are in-repo code, so accessibility and styling fixes do not wait on a library release.
- Visual tokens, frame rules and page designs are specified in spec 04 and verified in a real browser, not only by component tests.

**Alternatives considered.**
- *A charting library.* Makes buckets non-navigable and adds a large lazy chunk for a handful of simple charts.
- *Vite behind the daemon (a daemon-side dev proxy) to keep one URL in development.* Needs a development-only CSP exception, a stable Vite port and a start order, and lets stale tabs mix two React bundles after a restart. Vite's standard arrangement (Vite in front, proxying the API) has none of these problems.

## D-12 The MCP tool surface is a stable public contract

**Status:** Accepted

**Context.** The tools are BrowserHive's public API for agents. Agent prompts, harness code, saved workflows and model behaviour tuned against tool names and parameters all depend on it, and MCP clients cache `tools/list`. A rename or a changed default breaks agents silently at run time, not at build time.

**Decision.**
- The 43 tools keep their names, parameter names, defaults, enums, result shapes and error codes. The catalog, registration order and per-tool wire shapes are pinned by golden files (spec 02 §3, §8).
- Changes are **additive only** within a major version: new optional parameters, new result keys (for example `proxy_label` and `driver` in session metadata), new typed error codes where a generic failure was possible, `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), `outputSchema` + `structuredContent` alongside the JSON text, `title`, and server `instructions`. Anything else requires a major version.
- Contract rules that are enforced regardless of history: ownership on every tool (D-09); `allowEvaluate=false` disables `evaluate`; argument-validation failures are recorded as observations like any other failure; `defaultHeadless` and `defaultChannel` are baked into the `launch_session` schema defaults.
- Tools are declarative `ToolDefinition`s dispatched by one pipeline; the tool layer imports no Playwright.

**Consequences.**
- Result shapes that are unusual for the rest of the API (bare arrays from `list_tabs` and `list_sessions`, camelCase keys inside `identity`, argument-less tools advertised without an input schema) stay as they are, because existing agents parse them.
- New capabilities arrive as new tools in new packs (D-25 seams), never by reshaping existing ones.

**Alternatives considered.**
- *Consolidating tools into fewer, multi-mode tools.* Fewer tool descriptions in the model's context, but every existing agent breaks, and multi-mode inputs need top-level unions that strict MCP clients reject. Rejected.

## D-13 Stealth pipeline and the reserved proxy seam

**Status:** Accepted

**Context.** Agents browse real sites that fingerprint automation. Stealth must be coherent (every surface tells the same story), testable, and must not leak credentials into artefacts. Managed proxies are a likely next tier but are not built.

**Decision.**
- The stealth pipeline and its constants are specified in `11-stealth.md` and pinned by tests; changes to a constant are deliberate, reviewed changes. Implementation rules: one native-getter masking helper, one `deviceMemory` constant, CDP sessions pruned on page close, `platformVersion` derived from `os.release()`.
- **Driver selection:** config key `stealthDriver` (`auto|patchright|playwright`). Patchright and stock Playwright differ in `page.evaluate`: Patchright evaluates in an isolated world by default and takes `isolatedContext` as a fourth positional argument, while Playwright rejects extra positionals. All main-world evaluation goes through `evaluateMainWorld(target, capabilities.isolatedEvaluate, fn, arg?)`, which branches on the driver's capability.
- **CAPTCHA:** `captcha` is `attention|off`; `solver` is a reserved value that fails fast at config time until a solver tier exists.
- **Proxy seam:** `LaunchSpec.proxy` is a typed field with `source: 'byo'|'managed'` and a `ProxyResolver` port. The only implementation is bring-your-own pass-through with a forced loopback/RFC 1918 bypass, a `proxy_label` on session metadata and a `session.proxy_assigned` event. A managed pool, rotation and exit-geo are **not built**. Raw `--proxy-*` launch args remain allowed until a managed layer exists.
- **Credentials never reach traces:** around a vault fill, the tracing handle performs a full `tracing.stop({path: part-N.zip})` and, after the fill, `tracing.start(originalOptions)`; parts are merged into `trace.zip` at session close. Playwright's `stopChunk`/`startChunk` would leave the network tracer running, so the login POST body would land in the resumed chunk. `clear_after_fill` semantics are unaffected. An integration test asserts no credential string appears anywhere in the merged trace.

**Consequences.**
- The trace of a session with a vault fill consists of several parts that the trace viewer loads as one timeline.
- Proxy features can be added behind `ProxyResolver` without changing `launch_session`.

**Alternatives considered.**
- *`tracing.stopChunk`/`startChunk` around the fill.* Leaks the POST body, as above.
- *Disabling tracing for vault-enabled sessions.* Loses the audit value of traces for exactly the sessions where it matters most.

## D-14 Vault

**Status:** Accepted

**Context.** Agents log into sites without ever seeing credentials. Operators decide which sessions may use which entries, and the design must admit backends other than Bitwarden.

**Decision.**
- Bindings and group policies live in SQLite tables (D-04), with version columns for optimistic concurrency (`If-Match`, 409 `CONFLICT` on mismatch) and JSON export/import for hand editing.
- The authorization subject is the **caller principal** (server-assigned) combined with session slug globs, because operators think in slugs; both must match.
- `VaultBackend` declares `capabilities { unlock: 'none'|'passphrase'|'token', grouping, writable, totp, sync }`. Entries are organised in backend-neutral **groups** (`group_id`); the unlock requirement is a generic `unlock { required, mode, hint }` descriptor, never a backend-specific environment variable. Backend enum: `off|bitwarden|local|onepassword|http`; only `off` and `bitwarden` are implemented, the rest are rejected at config time.
- The broker has a fixed gate order, returns failures instead of throwing, writes exactly one audit row per fill, and arms redaction windows before typing (spec 02 §3.13).
- The `bw` adapter passes `--` before positional arguments, applies a timeout, handles `EPIPE`, and runs the child with a minimal environment.
- BrowserHive never asks for, receives or forwards a Bitwarden master password. The Bitwarden backend declares `unlock: 'token'`: the operator runs `bw login` and `bw unlock --raw` in their own terminal, then either exports `BW_SESSION` before starting the server or pastes the token on the dashboard. A pasted token is trimmed, checked with `bw status`, and kept in memory only; `bw unlock` is never run. `POST /vault/unlock` with a body that does not match `unlock.mode` is `400 VALIDATION_FAILED`.

**Consequences.**
- A new backend is one adapter plus its capabilities; the REST API and dashboard adapt from the capability descriptor.
- The agent learns only entry names, allowed origins and fill outcomes.

**Alternatives considered.**
- *Authorization by slug only.* Any agent could launch a session with an authorized slug; binding to the principal closes that.
- *Policies in JSON files.* See D-04.
- *Unlock with the master password on the dashboard.* Rejected: the master password would pass through the browser, the API and the daemon, and it is worth more than a session token that `bw lock` revokes. It also cannot work from a daemon: `bw --nointeraction unlock` does not read a password from standard input, so every such unlock would fail with `VAULT_UNLOCK_FAILED`.

## D-15 Operator requests: one broker

**Status:** Accepted

**Context.** Two flows block an agent until a human decides: `request_attention` and dashboard confirmation of a vault fill. Both need the same guarantees, and a future security-intercept flow will need them too.

**Decision.** `OperatorRequestBroker` with `kind: 'attention' | 'vault_confirm'` (reserved: `security_intercept`) provides for every kind: a durable row, a deadline, lease pause while pending, cancellation when the client disconnects, settlement when the session closes, orphan recovery at restart, idempotent request ids (`a-<nanoid12>`), a bounded queue, and a decision-grade payload (page URL, tool, event id). A vault confirmation nobody answers is denied with `confirm_timeout` after the same deadline as an attention request (`attentionTimeout`), so a fill is never held forever. `request_attention` blocks, heartbeats every 25 s, and applies a floor (`minAttentionWait`) and a cap (`attentionTimeout`).

**Consequences.**
- Attention and vault confirmation share one table (`operator_requests`), one history view model, and one set of recovery tests.
- Adding a kind means a payload schema, a resource view and a dashboard surface; the lifecycle comes for free.

**Alternatives considered.**
- *Separate implementations per flow.* Each would need its own timeout, lease pause and recovery, and they would diverge.

## D-16 Notifications

**Status:** Accepted

**Context.** Operators are not always watching. They need to know when an agent is blocked, a session crashed, a fill awaits confirmation or tools are failing, without being flooded and without losing state on reload.

**Decision.**
- Notifications are produced server-side from the domain event bus, persisted (`notifications` table with read and dismissed state), and delivered in-app over the WS `notifications` topic.
- Producer rules: attention requested; session crashed; lease-expired reap; vault confirm pending; system degraded (error severity); tool errors.
- Tool errors are **grouped per session**: one row per group (`"<slug> · N tool errors"`) grows while it is unread, has been idle for less than 5 minutes and is younger than 60 minutes; `notification.updated` carries the full row and clients upsert by id; lists sort by `updated_at`. Session-less caller mistakes (codes whose retry guidance is "different arguments") produce no notification. A failing agent would otherwise flood the inbox and toasts with one row per call, none naming the session.
- `/me/preferences` stores the notification toast preferences (`notifications.toasts`, `notifications.types`), which follow the operator across devices; sidebar state and page size are per-device or per-URL.
- External channel adapters (webhook, ntfy, Telegram, Slack, email) are a documented seam (`NotificationChannel.send(payload)`); not built.

**Consequences.**
- Read state survives reloads and is shared across tabs.
- By default the dashboard does not toast tool errors; the grouped inbox row is the signal.

**Alternatives considered.**
- *Client-only notifications derived from the feed.* Lost on reload, different in every tab, and unavailable to external channels.

## D-17 Testing

**Status:** Accepted

**Context.** Correctness spans pure domain logic, SQLite behaviour, real Chromium, wire contracts and a browser UI.

**Decision.** `bun test` for contracts, core and the CLI (they must run under Bun because of `bun:sqlite`). Dashboard unit and component tests with `bun test` + happy-dom + Testing Library. Playwright for dashboard end-to-end tests. A real-Chromium integration suite (isolation, stealth, tool surface, observability, vault traces) runs in CI on Linux, macOS and Windows. Contract goldens (tool JSON Schemas, OpenAPI document, WS transcripts, schema fingerprint) are committed and diffed. Details in `09-testing.md`.

**Consequences.** Contract changes are visible in review as golden diffs; the fast suite needs no browser.

## D-18 Versioning, publishing, packaging

**Status:** Accepted

**Context.** Users install BrowserHive from npm and run it on their own machine. Installs must be reproducible and verifiable, and must not download large binaries implicitly.

**Decision.** Changesets with a fixed version group; one generated `version.ts` (build step, asserted by test). Conventional Commits. First public version `0.1.0`; `next` dist-tag for prereleases. Publishing from GitHub Actions with npm **OIDC trusted publishing** and provenance; no long-lived npm token exists. Never a `postinstall` browser download: `browserhive init` installs Chromium (and the Patchright build), `browserhive doctor` checks the host, and a missing browser at launch is the typed `BROWSER_NOT_INSTALLED` error naming the command. The `package` CI gate runs `publint`, `@arethetypeswrong/cli`, then packs, installs into a clean directory and runs a stdio handshake smoke test.

**Consequences.** Installing the package never executes network downloads; CI-only publishing makes every release attributable.

**Alternatives considered.**
- *`postinstall` Chromium download.* Breaks offline and locked-down installs, runs code at install time, and duplicates browsers already present.

## D-19 Toolchain

**Status:** Accepted

**Context.** One fast, strict toolchain keeps the feedback loop short and the codebase uniform.

**Decision.** TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `noPropertyAccessFromIndexSignature`); `tsc -b` runs on the TypeScript 7 native compiler, with TypeScript 5.9 available to tools that need the JavaScript compiler API. Biome 2.5 for lint and format. `dependency-cruiser` for boundaries. `tsdown` for library bundling with `.d.ts`. `publint` + `attw`. `picocolors` for CLI colour. `bun test` + Playwright.

**Consequences.** Lint, format and type rules are enforced in `bun run check` and CI; spec 05 lists the coding rules built on them.

## D-20 Data privacy posture for stored records

**Status:** Accepted

**Context.** The audit trail is BrowserHive's value to an operator, but tool results, URLs and errors routinely contain secrets and personal data. Local-first means the operator owns the machine, which justifies recording, but some values must never be stored or broadcast.

**Decision.**
- Tool results are recorded, capped at **16 KiB** of UTF-8 text per call. Results such as `get_content` HTML or large snapshots can be megabytes; the cap keeps one row per call small enough for fast timeline queries and bounded database growth while preserving enough of the result to see what the agent saw. `result_size_bytes` always records the full size.
- Exceptions: cookie values are never persisted or broadcast (shape only: name, domain, path, expiry); URL query strings and fragments are stripped before persistence unless the key is on an allow-list; error messages pass through the redaction filter; fields marked `sensitive()` in the contracts are redacted by the serialization codec before any sink.
- `recordToolResults` (`full|shape|none`, default `full`) exists for stricter deployments.
- Redaction is a property-tested pipeline: a marker secret must never reach any sink (logs, DB, WS, MCP, OTLP).
- Retention: telemetry-class rows follow `retentionDays` (≥ 1; `0` is rejected at config time) and `retentionBytes`; audit-class rows (vault access, blocked requests, auth events, operator actions and requests) follow their own `auditRetentionDays` and are never byte-pruned (spec 03 §7.1).

**Consequences.** Operators get useful history by default and can tighten it with one key; a leak is a failing property test, not a code-review catch.

**Alternatives considered.**
- *Record nothing by default.* Removes the audit value that motivates the product.
- *Record full results.* Unbounded database growth and more secret exposure for little additional insight.

## D-21 Session lifecycle

**Status:** Accepted

**Context.** Launching a browser is slow, can fail at many points, and consumes significant memory. Concurrent launches, crashes and shutdowns must never leak processes, directories or capacity.

**Decision.** An explicit state machine (`reserved → launching{phase} → live ⇄ paused → draining → closed | crashed`). Creation is a named pipeline (`validate → admit → reserve → prepareProfile → resolveIdentity → launch → installPolicies → startTracing → applyIdentity → register`) with a timing span per phase. Capacity is reserved under a short lock; the launch runs outside it. Every phase registers its compensator on an `AsyncDisposableStack`; `create` and `close` take deadlines and an `AbortSignal`. The default `maxSessions` derives from host RAM, `max(1, min(floor(RAM_GiB / 1.5), 20))`, which budgets 1.5 GiB of host RAM per Chromium session with a hard ceiling of 20; an unbounded default would let one agent exhaust the host. `server_status.sessions.limit` reports the effective number (`null` only when configured `unbounded`).

**Consequences.** A failed launch unwinds exactly the phases that ran; `SESSION_LIMIT_REACHED` is reported before any browser starts; the `AdmissionPolicy` seam can grow into a resource governor (D-25).

## D-22 Blocklist

**Status:** Accepted

**Context.** Operators need to keep agents away from certain sites regardless of what the agent asks for, with an audit of attempts.

**Decision.** An operator-maintained blocklist file (one URL glob per line, `#` comments, case-insensitive anchored matching with and without the scheme, a host pattern covering every path beneath it; spec 11 §5) is enforced twice: at the tool level before a navigation starts (`URL_BLOCKED`) and at the network layer for every document request (fail-closed). Every hit is audited with its source (`tool` or `request`). Edits apply without restart: `POST /api/v1/blocklist/reload` and a debounced file watcher replace the rule set atomically, and a failed reload leaves the previous rules in force.

**Consequences.** Sites opened by page scripts or redirects are blocked as reliably as direct navigations. Rules editable in the dashboard and stored in the DB belong to the security-intercept engine (D-25); not built.

## D-23 Naming inside the codebase

**Status:** Accepted

**Context.** Consistent naming across TypeScript, files, wire, config and the database removes a whole class of review comments and mapping bugs.

**Decision.** TypeScript: camelCase identifiers, PascalCase types, `SCREAMING_SNAKE` only for true constants. Files: kebab-case. Wire: snake_case (D-05). Config: camelCase (D-06). Database: snake_case columns with unit-bearing names (`*_at` epoch ms, `*_ms`, `*_bytes`). IDs: `<slug>-<nanoid8>` sessions, `t-<nanoid6>` tabs, `e-<ulid>` events (time-sortable, so event ids order like the events), `a-<nanoid12>` operator requests, `p-<nanoid12>` principals, `n-<nanoid12>` notifications, `m-<nanoid16>` MCP sessions, `c-<nanoid10>` realtime connections.

**Consequences.** ID grammars live in `contracts/ids` as branded schemas; one `IdGenerator` port mints them.

## D-24 Data directory layout

**Status:** Accepted

**Context.** Everything BrowserHive stores must be in one place that an operator can back up, inspect, purge and protect with file permissions.

**Decision.**

```
<data-dir>/
  browserhive.db                 SQLite (events, sessions, auth, vault policy, notifications, migrations)
  browserhive.db-wal, -shm
  browserhive.lock               one owner per data directory (daemon or maintenance command), stale-pid recovery
  backups/browserhive-v<N>-<ts>.db
  admin/credentials.txt          one-time seed password, overwritten and removed after the first change
  sessions/<id>/{userdata/,trace.zip,trace-parts/,screenshots/<event_id>.png,downloads/}
  auth-states/<name>.{storage.json,profile.zip,meta.json,identity.json}
  uploads/
  browserhive.config.json        optional (also discovered in cwd or via --config)
```

OS defaults: `~/Library/Application Support/BrowserHive` (macOS), `%LOCALAPPDATA%\BrowserHive` (Windows), `$XDG_DATA_HOME/browserhive` (Linux). Directories are 0700 and secret files 0600. Narrowing a directory's mode is best effort, as it already is for the database file: a filesystem that rejects `chmod` (CIFS/SMB shares, some container bind mounts, Windows) logs `data dir chmod failed` at `warn` instead of failing boot, and `browserhive doctor` flags the mode. Failing to *create* a directory is still `DATA_DIR_UNWRITABLE`. Full-profile snapshots are zipped with `fflate` (synchronous API, regular files only, zip-slip guard on extract). The lock file prevents a daemon and a maintenance command (or two daemons) from writing the same directory.

**Consequences.** `browserhive purge` and `browserhive doctor` work from this layout; `doctor` reports files in the data directory that are not part of it.

## D-25 What is explicitly not built (seams only)

**Status:** Accepted

**Context.** Several features are likely but not required for the first release. Building their seams now avoids reshaping public contracts later; building the features now would delay the product.

**Decision.** Not built: managed proxy pool and rotation; foreign fingerprint identities; profile blueprints (named, versioned, encrypted); local vault, TOTP, 1Password; extensions registry; external notification channels; security-intercept rule engine; resource governor and eviction; CAPTCHA detection and solving; Web Bot Auth; Tor egress; benchmark harness; multi-user, organisations and OIDC; Firefox and WebKit engines; standalone binaries. Each has a named seam in `01-overall-architecture.md` §9.

**Consequences.** Reserved enum values and config values for these features fail fast with a clear message rather than silently doing nothing.

## D-26 Browser choice: bundled by default, installed browsers by choice, never a silent switch

**Status:** Accepted

**Context.** Every session used Playwright's bundled Chrome for Testing build (channel `chromium`). It is the same everywhere and needs no admin rights, but it reports a pinned full version that real users do not run (measured: `153.0.8010.12`, a beta-only build, while stable was `154.0.8037.57`), and on Ubuntu 23.10+ it cannot use Chromium's sandbox (D-27). Operators who want the browser real users run, and Patchright itself, recommend the installed Google Chrome. The `chrome` and `edge` channels already existed, but nothing told an operator they were there, `doctor` checked only the bundled browser (a configured `chrome` that was not installed showed ✓), and choosing one meant knowing the `defaultChannel` key.

**Decision.**
- `chromium` (bundled, pinned, always installed by `browserhive init`) stays the default and is never removed. `chrome` and `edge` use the browser installed on the host, which updates itself.
- Detection of `chrome`/`edge` reuses Playwright's own executable lookup (`registry.findExecutable(name).executablePath()` in the pinned `playwright-core`, pinned by a test), so detection and launch can never disagree about which binary a channel means. Versions come from `--version` (or, on Windows, the version-named directory beside the executable); managed policies from `/etc/opt/{chrome,edge}/policies/managed`, macOS managed preferences and the Windows policy keys. `RemoteDebuggingAllowed=false` blocks automation.
- `browserhive init` reports the browsers, their versions and whether each can run sandboxed, and on a terminal offers a menu whose pros and cons are computed for the host. Google Chrome is labelled "recommended for stealth" but never pre-selected: Enter keeps the current value. It can install Google Chrome with Google's installer (`playwright install chrome`) when the operator picks it or passes `--installChrome`; never automatically.
- A configured channel whose browser is missing fails with `BROWSER_NOT_INSTALLED` naming the install command. BrowserHive never launches a different browser than the one asked for.
- The version a page sees is always the real engine's (`fullVersionList` from `Browser.getVersion`); BrowserHive never invents or pins a fake version.

**Consequences.** `doctor` fails when the configured channel is missing and warns when the installed browser in use is more than one major version ahead of the tested build. Installed browsers can drift ahead of what a release was tested with; a weekly CI job runs the integration suite against current stable Chrome (spec 06). Edge under stealth is presented with Google Chrome brands while its user agent says `Edg/` (a known ceiling, spec 11 §14), so Chrome, not Edge, is the recommended channel.

**Alternatives considered.** Making `chrome` the default: rejected, since it would fail on every host without Chrome and break CI, Docker and admin-less installs. Falling back to the bundled browser when the configured one is missing: rejected, since a silent switch changes the identity and the sandbox posture behind the operator's back. Pinning or faking the reported version: rejected, since a fabricated version is itself a fingerprint and contradicts the "assert nothing rather than assert wrong" posture (D-13).

## D-27 The Chromium sandbox: `auto` by default, `on` as a guarantee kept at startup

**Status:** Accepted

**Context.** Playwright adds `--no-sandbox` unless `chromiumSandbox: true`, and BrowserHive never set it, so every session ran without Chromium's sandbox: a compromised renderer had the server process's privileges. Turning it on unconditionally is not possible: on Ubuntu 23.10+ (`kernel.apparmor_restrict_unprivileged_userns=1`) a browser without an AppArmor profile, which includes Playwright's download, cannot create the user namespaces the sandbox needs, Chrome refuses the sandbox as root, and Docker's default seccomp profile blocks it. Measured in CI through BrowserHive (plan Phase 0): macOS and Windows sandbox every channel; Ubuntu sandboxes Google Chrome (Ubuntu ships its profile) and not the bundled browser or, on the runner, Edge. The only route before was an agent's `launch_options.chromiumSandbox: true`, which on such a host returned `INTERNAL_ERROR` with `retryable: backoff`.

**Decision.** A config key `sandbox: auto | on | off`, default `auto`.
- `auto` runs each browser sandboxed where it can. The first real launch of each executable tries the sandbox; if that fails and the same browser then starts without it, the sandbox is the cause: the verdict is cached for the process lifetime and sessions fall back with one `warn` log (`sandbox fell back`), a `/system` line and a `doctor` note. It never fails a launch because of the sandbox, never retries it per session, and does not attempt it as root.
- `on` is a guarantee kept at startup: before the listeners open, the configured browser is launched once with the sandbox forced on; if it cannot sandbox, every other installed browser is probed and the server refuses to start with `SANDBOX_UNAVAILABLE` (exit code 3) and guidance computed for this OS and these browsers, working options first. A later `launch_session` for a browser that cannot sandbox fails immediately with the same code, `retryable: never`, naming the channels that work.
- `off` is the behaviour before the key existed.
- An agent may still request `launch_options.chromiumSandbox: true` (it only strengthens the posture); it makes the sandbox a requirement for that session. `chromiumSandbox: false` stays refused (D-12, spec 11 §4).
- A launch failure caused by the sandbox is `SANDBOX_UNAVAILABLE` in every mode, never `INTERNAL_ERROR`. When the failure text is not one BrowserHive recognises, it is proven the way the probe proves it: the same browser starting without the sandbox (Edge's SUID-helper message on Ubuntu was the first such case the cross-OS job found; it is now recognised too).

**Consequences.** On macOS, Windows, most Linux hosts and with Google Chrome on Ubuntu, sessions now run sandboxed without configuration. On Ubuntu with the bundled browser the first session of a process pays one failed launch (about 0.3 s) and runs unsandboxed, as before; `doctor --printApparmorProfile` prints (never installs) a profile that fixes it. Page-visible signals are identical with and without the sandbox (measured on all three OSes). `doctor` reports the fallback with its fix but as ✓, not a warning: sessions still launch, and a `doctor` that started exiting 2 would break healthchecks that passed before; under `on` the same verdict is a failure.

**Alternatives considered.** Default `on`: rejected, since it would refuse to start on every Ubuntu 23.10+ host with the bundled browser, a new failure for operators who asked for nothing. Default `off`: kept only until the cross-OS measurement showed `auto` never breaks a launch. Probing every browser at boot under `auto`: rejected, since it adds a browser launch to every start (and to every test boot) for information the first real launch provides. Installing an AppArmor profile or a setuid helper automatically: rejected, since it needs root and changes the host's security policy (plan §10).

## D-28 `init` may write the configuration file, and never asks without a terminal

**Status:** Accepted

**Context.** `browserhive init` never wrote a config file, so a browser chosen in its menu would be forgotten, while silently rewriting an operator's file, or prompting in CI, would be worse.

**Decision.** `init` saves a chosen `defaultChannel` only after asking (`Save defaultChannel=chrome to <path>? [Y/n]`), or with `--yes`. It merges the one key into the config file in use, keeping every other key, their order and `$schema`; with no file in use it creates `<data-dir>/browserhive.config.json` (0600), the discovery candidate that is always found (spec 08 §3). It never prompts without a terminal on stdin, under `CI`, or in a container; there `--channel` selects, `--yes` accepts the save (without it the step fails and nothing is written) and `--installChrome` installs. Pressing Enter at the menu keeps the current value and writes nothing.

**Consequences.** Non-interactive runs are deterministic. A flag or environment variable that still overrides the file is pointed out after saving.

## D-29 References in config-file values: `{env:NAME}`, one pass, never a command

**Status:** Accepted

**Context.** `browserhive.config.json` is the source that gets checked into a repository, so it is the one place a secret must not be written, yet the only way to supply `authTokens` or an OTLP `Authorization` header without the file was to move the whole key to the environment. Operators want one checked-in file that works on a laptop and in production, with the secret parts supplied at run time, and they need to see afterwards which variable supplied which value. Prior art splits on notation (`${env:VAR}` in the OpenTelemetry Collector and VS Code, `{env:VAR}` in tox), on missing variables (error, empty, or left literal) and on recursion; Log4j 2's recursive `${…}` lookups over runtime data (CVE-2021-44228, CVE-2021-45105) are the governing precedent for the last.

**Decision.**
- A **string value inside `browserhive.config.json`** (a whole value, an array element or an object value, never a key name, number, boolean or `null`) may contain `{env:NAME}` or `{env:NAME:-default}`. It is expanded before the key's parser runs (spec 08 §6 step 2.5), and the result is parsed exactly as the environment spelling of that key would be: the file speaks the env dialect for that value. The grammar and every message are in spec 08 §3.1 and §4.
- `{env:NAME}` is required: unset or set-but-empty is a usage error (exit 64), as an empty value is everywhere else (D-06). `{env:NAME:-text}` uses `text` when `NAME` is unset or empty; `text` is literal.
- **One pass, no rescanning.** A resolved value is never scanned again, and neither the scheme nor the variable name can be computed. The environment is runtime data relative to the file, so a variable can never choose a scheme (`{file:…}` or anything added later); termination needs no depth limit; provenance stays a flat list of names.
- **Single brace, lower-case scheme.** `{env:…}` is inert in bash, zsh, cmd and PowerShell (where `${env:PATH}` is the shell's own syntax). The colon after a lower-case scheme name is what keeps existing text such as `{trace_id}` literal. `${env:…}`, the Collector's habit, is a usage error that names the fix; any other `${word:…}` is left alone as another tool's syntax.
- **Doubling is the escape.** `{{env:X}}` is the literal text `{env:X}` (JSON already uses the backslash). Every other brace is literal.
- **Strict schemes.** A `{word:…}` whose scheme is not supported (`{envv:X}`, `{ENV:X}`, `{file:…}`) is a usage error, never literal text, and the message names the escape. The registry of schemes has one member, `env`; the only inputs a scheme may use are the resolver's injected `env` and `fs`.
- **Provenance, not a new source.** The rung stays `file`. Every surface names the variables (`config-file via $OTLP_TOKEN`, `(default)` when the default was used): shadow lines, `config show`, `GET /api/v1/system/config` (`refs`, and `template` for keys that are not secret), the dashboard and `doctor`. A key flagged `secret` never shows its value or the file's text; a reference whose *name* looks credential-bearing (the key-name list of spec 10 §9) makes the whole key render redacted for that run, so the wire's `secret` flag is per run, not static in the schema.
- **`{cmd:…}` is refused permanently.** `config validate` and `doctor` run the same pure resolver as `serve`; a command scheme would make validating an untrusted repository run its code, and would turn a config-file diff into a code-execution diff. A wrapper that resolves secrets and then execs BrowserHive (`op run -- browserhive …`) is the supported shape.

**Consequences.** No existing file changes meaning: nothing shipped or documented contains a lower-case `{word:…}` (the `otelTraceUrlTemplate` placeholder is `{trace_id}`). The one residual collision is a decoded TraceQL selector such as `{span:name="GET"}` in a URL template, reported with its escape. Enum keys in the generated JSON Schema accept a reference as an alternative (`$defs.configRef`), which costs some editors their enum completion. References in `BROWSERHIVE_*`, `OTEL_*` values, flags and programmatic options are not expanded (the shell already did that) and produce a warning. `{file:…}` (secret files mounted by Docker, Kubernetes or systemd), an opt-in `$secret` list, `config show --refs`, and `op`/`vault` schemes are later additions to the registry, each non-breaking because an unknown scheme is an error today. Error messages name the key and the file, not the line: the JSON parser records positions only on failure.

**Alternatives considered.** *`${env:VAR}`*: familiar from the Collector, but it collides with PowerShell and needs `$$` escaping in shells and docs. *A structured reference (`{"$env": "X"}`)*: cannot embed in a URL, is ambiguous inside `otelHeaders` (a header named `$env`), and would give every key a second input shape. *Leaving unknown or missing references literal (Kubernetes, Compose)*: a silently empty credential becomes a confusing 401, and fail-fast is the rule of D-06. *Expanding in env and CLI values too*: a second expansion after the shell's is how `$$` conventions start, and refusing previously legal values would break them, hence a warning. *Reading `.env` files*: a service manager's job (spec 08 §10), not the resolver's.

## D-30 Harness identity is self-reported observability, resolved per request, with an open vocabulary

**Status:** Accepted

**Context.** Operators run several agents (Claude Code, Codex, Cursor, OpenCode, Gemini CLI and others) against one daemon and want to see which one launched a session, count them and filter by them. The capture path existed since schema v1 (`mcp_connections.client_name`, `harness`, `model`, the `X-BH-*` headers) but was surfaced only as a client line on the session detail. Nothing a client says about itself can be verified: `clientInfo`, headers, `_meta`, the URL and the environment of a stdio process are all set by the client or by the user's own configuration, and the MCP specification says implementations SHOULD NOT change behaviour or make security decisions on `clientInfo`. MCP offers no way to learn the model that drives an agent. MCP revision `2026-07-28` removes `initialize` and `Mcp-Session-Id`, so identity that is read only at the handshake would stop working.

**Decision.**
- **Observability, not trust.** Harness, model, workspace and the meta bag are recorded and shown faithfully as reported; they are never used for access control, quotas, tool visibility or any other decision. Every surface that shows them says once, plainly, that they are reported by the client or by the user's configuration and cannot be verified. No policy is built on them until a harness can be verified (a token binding would be the first such source).
- **Resolved per request, cached on the connection.** Every tool call resolves identity from the signals it carries (its request's headers and URL, its `_meta`) plus the connection's (`initialize`, the stdio environment); `mcp_connections` holds the latest resolution. The ladder, highest first, each step recorded as `harness_source`: `env` (`BROWSERHIVE_HARNESS`, stdio) or `header` (`X-BH-Agent-Harness`, alias `X-BH-Harness`); `injected_env` (`CLAUDECODE` → `claude-code`, `GEMINI_CLI` → `gemini-cli`, stdio); `url` (`?harness=` on `/mcp`); `meta` (`_meta['ai.browserhive/harness']` on the call, then on `initialize`; the `browserhive.ai/` prefix is read too); `client_info` (`clientInfo.name` through the alias table); `user_agent` (through the alias table); `none` → `unknown`. The source vocabulary is open (`token` is reserved for a verified binding). Signals that name a different harness than the winner are recorded as conflicts, logged once per connection at `info` and shown on the connection; a connection is never refused over them.
- **Open vocabulary.** `harness` is a string on the wire and in the database, never a closed enum: a known slug from the table in `contracts/harness` (with a display label), `unknown` (nothing identified the client; a first-class, countable value) or `other`, or a sanitised slug of an unrecognised value (`[a-z0-9-]`, ≤ 32 chars). Generic SDK defaults (`mcp`, `mcp-client`, `example-client`, `test-client`) mean `unknown`. Metric attributes fold every slug outside the known table into `other`.
- **Model and workspace are declared only.** Model: `X-BH-Agent-Model` (alias `X-BH-Model`), `BROWSERHIVE_MODEL`, `_meta['ai.browserhive/model']`, with a `model_source`; absent means "not reported", never a guess. Workspace: `X-BH-Workspace`, `BROWSERHIVE_WORKSPACE`, `_meta['ai.browserhive/workspace']`.
- **A small capped meta bag.** `X-BH-Meta-<Name>` headers and other `ai.browserhive/*` `_meta` keys are kept verbatim, at most 16 keys, 256 bytes per value and 4 KiB in total; the rest is dropped with one log line per connection. The bag is display-only: never a facet, a filter, a metric attribute or an input to any decision.
- **The identity environment variables are not configuration.** `BROWSERHIVE_HARNESS`, `BROWSERHIVE_MODEL` and `BROWSERHIVE_WORKSPACE` describe one stdio process, not the server; the config collector skips exactly these three names (`IDENTITY_ENV_VARS`), so they appear in no config schema, `config show` or `--help` key list, and a misspelling still gets a "did you mean" (spec 08 §4).
- **A session's harness is fixed at launch.** `sessions.harness` is written once when the session is created, so facets, filters and counts do not change when a connection row is updated or pruned. Sessions created before schema v3 read `unknown`.

**Consequences.** With no configuration, Claude Code and Gemini CLI over stdio and Codex, OpenCode, Cursor, Claude Code and others over HTTP are recognised; everything else is `unknown` rather than an empty cell. One header, environment variable or query parameter names any other harness. Per-harness notification routing and per-harness template visibility can read `harness` from session and tool-call event payloads without a query. Metric series grow by at most the size of the known table.

**Alternatives considered.** *Enforcing policy on the reported harness*: rejected; any client can claim any name, so a harness allowlist would be a typo guard presented as a control. *A closed zod enum*: rejected; a new harness ships every month and an unknown value would become a 400. *Inferring the model* (sampling, inherited `ANTHROPIC_MODEL`, a tool argument): rejected; sampling names the model the client picked for that request, is deprecated in `2026-07-28` and would prompt the user, and the others are guesses. *Process inspection of the stdio parent*: rejected; fragile across platforms and a poor look for a local-first tool. *A `/mcp/<harness>` path*: deferred; the query form works with no routing change. *Registering the identity variables as config keys*: rejected; they would appear in `--help` and `config show` as server settings, which they are not.
