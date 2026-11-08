---
title: "Architecture decision log"
spec: "00"
status: Normative
scope: The cross-cutting architecture decisions of BrowserHive (runtime, packaging, persistence, contracts, configuration, errors, telemetry, identity, realtime, dashboard, tool surface, stealth, vault, operator requests, notifications, testing, publishing, privacy, session lifecycle, naming, data layout, session templates, site packs) with their context, consequences and rejected alternatives.
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

**Purpose.** This log records every decision that shapes more than one subsystem, together with the reason it was made. The topic specs (01–13) describe *how* each subsystem works; this log records *why* the cross-cutting choices are what they are, so that they are not re-argued without new information.

**Citation.** Each entry has a permanent identifier `D-NN`. Specs, code comments and tests cite entries by that identifier (for example `// never attention-gated (D-10)`). Identifiers are never renumbered or reused; a decision that is replaced keeps its identifier and its text is rewritten to the current design.

**Precedence.** If a topic spec and this log disagree, this log wins and the spec is corrected.

**Status values.**

| Status | Meaning |
|---|---|
| Proposed | Under discussion; not yet binding. |
| Accepted | Binding; the codebase implements it, or its **Implementation** line names the planned work that will (until that work lands, the entries it amends describe the running code). |
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
- **Close and second openers:** closing checkpoints the WAL with `TRUNCATE`; SQLite then deletes `-wal` and `-shm`, except where the WAL is persistent (Apple's system SQLite, which `bun:sqlite` uses on macOS, keeps both, the WAL empty). A second opener (CLI maintenance commands, the `purge` inventory) is read-only in effect: `query_only=1`, no migration. It uses a read-only connection when `-wal` and `-shm` exist (a live server keeps both); when they do not (a restored or copied file), it opens the file read-write without create, because a read-only connection to Apple's SQLite cannot create them.
- **Query layer:** Kysely (pinned exact) with an in-repo `bun:sqlite` driver. Kysely types and `sql` never leave `core/src/infra/persistence/`. Repositories are hand-written Promise-returning ports; the SQLite adapter implements them. Reporting queries live in a separate `AnalyticsQueries` read model. Row types are generated by `kysely-codegen` from a freshly migrated database and verified in CI; wire types are zod (D-05); explicit mappers join them.
- **Migrations:** forward-only, embedded as TypeScript in one ordered array; `SCHEMA_VERSION` is the last entry. Runner: `busy_timeout` → `VACUUM INTO` backup (`<data-dir>/backups/browserhive-v<from>-<ts>.db`, newest 5 kept) → `BEGIN IMMEDIATE` → read `user_version` → apply pending migrations → set `user_version` in the same transaction → `COMMIT`. `foreign_keys=OFF` before `BEGIN` for table rebuilds; SQLite's `legacy_alter_table=1` where views exist. A `schema_migrations` audit table (version, name, applied_at, duration_ms, app_version) is surfaced on `/api/v1/system`.
- **Drift:** a CI test migrates a throwaway database and compares a pragma-normalised schema fingerprint (`pragma_table_xinfo`, `index_xinfo`, `foreign_key_list`, sorted, plus trigger and view SQL) with a committed golden; fixture databases for every shipped schema version are replayed through the runner.
- **Downgrades:** no `down()` code. The database stores `user_version` (current schema) and `meta.min_reader_version` (oldest schema version whose code can still read it). A migration declares `compatible: true` when it is purely additive, and then `min_reader_version` is not raised. An older binary opening a newer database opens it normally when `SCHEMA_VERSION >= min_reader_version` (all SQL uses explicit column lists); otherwise it refuses with `DB_NEWER_THAN_BINARY`, naming the pre-upgrade backup and `browserhive db restore <file>`.
- **What lives where:** structured state lives in SQLite under this runner: audit and event rows, sessions, principals and credentials, auth sessions and tokens, vault bindings and group policies, notifications and preferences. Files stay files where they are large binary artefacts or must be usable by other tools: browser profiles, traces, screenshots, downloads, uploads, auth-state snapshots, database backups and the config file.

**Amended by D-54** (planned, spec 13 §9.9): migration v9 is the first with `compatible: false` (`min_reader_version` 9); from v8 on, every `CHECK` list in a migration is a literal frozen in that file, and a shipped migration that builds a CHECK from a live constant is first changed to an equal literal.

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

**Amended by D-55** (planned, spec 13 §10): the one default outbound request is the site-pack update check, an anonymous conditional `GET` of BrowserHive's public signed index every 24 h; it carries no data about the install, pack files are fetched only when the operator downloads them, and `sitePacksUpdateCheck=false` turns it off.

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

**Amended by D-52** (planned, spec 13 §6.1; reserved subjects in PR T0f): the subjects `local`, `browserhive` and `system` and every subject starting with `template:` are reserved and refused by token creation; `browserhive` owns maintenance sessions and `template:<template_id>` is the principal of a template's vault auto-relogin; neither has a token or can log in, and maintenance sessions are refused to every agent principal whatever its subject.

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

**Amended by D-54** (planned, spec 13 §9.5): operator takeover input is also permitted while a `takeover`-mode `security_intercept` request is open on the session.

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

**Amended by D-49** (planned, spec 13 §5): the catalog grows to 44 tools with `list_templates` in the new `templates` pack, appended to the registration order, and `launch_session` gains the optional `template` parameter and a description that distinguishes template sessions; both are additive.

**Amended by D-57** (planned, PR T0d): `navigate` and `new_tab` refuse non-web URL schemes with `URL_SCHEME_NOT_ALLOWED`, a contract rule enforced regardless of history like `allowEvaluate=false`.

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

**Amended by D-51** (planned, spec 13 §5.4): virtual sessions of a session template have no trace in v1, so the guarantee holds there because nothing is recorded. A template's proxy is a BYO proxy: it goes through the `ProxyResolver` (`source: 'byo'`, the auth shim, the forced bypass) and emits `template.proxy_assigned` per host start (spec 13 §2.2).

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

**Amended by D-51 and D-58** (planned, spec 13 §5.5, §8.4, PR T0e): every fill requires the password selector to match exactly one password input (a gate after the origin gate); agent fills are refused in template sessions; vault auto-relogin into a template host runs every gate as the principal `template:<template_id>`, which the binding must list.

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

**Amended by D-54** (planned, spec 13 §9.3, §9.5, schema v9): `security_intercept` is built for site-pack challenges and write confirmations on a session (a host-owned write confirms on the host's maintenance session), with operator takeover permitted while one is open; each has `deadline_at = now + attentionTimeout`, floored at `minAttentionWait`, like every broker request.

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
- Producer rules: attention requested; session crashed; lease-expired reap; vault confirm pending; system degraded (error severity); tool errors. Each produced notification is also a versioned `NotificationMessage` (D-32) with a kind, category, severity, state and revision; the resolution of an attention request or a vault confirmation, the recovery of a degradation and a growing tool-error group are new revisions of the same notification, never new notifications.
- Tool errors are **grouped per session**: one row per group (`"<slug> · N tool errors"`) grows while it is unread, has been idle for less than 5 minutes and is younger than 60 minutes; `notification.updated` carries the full row and clients upsert by id; lists sort by `updated_at`. Session-less caller mistakes (codes whose retry guidance is "different arguments") produce no notification. A failing agent would otherwise flood the inbox and toasts with one row per call, none naming the session.
- `/me/preferences` stores the notification toast preferences (`notifications.toasts`, `notifications.types`), which follow the operator across devices; sidebar state and page size are per-device or per-URL.
- External channels (Telegram, Discord, ntfy, a generic webhook, later more) implement the `NotificationChannel` port and receive the contract through the delivery outbox (D-34). The in-app inbox is itself a channel on that port, delivered inline.
- Scheduled reports (a daily or weekly digest, D-43) and anomaly alerts (D-44) are produced per channel from the analytics read model, never from a single event, and are addressed to the channel that schedules them. The inbox gets one in-app copy per report period (D-45): a digest arrives already read and never toasts; an anomaly alert counts toward the badge and toasts like a `system` notification.

**Consequences.**
- Read state survives reloads and is shared across tabs.
- By default the dashboard does not toast tool errors; the grouped inbox row is the signal.
- A lifecycle revision changes the row's state fields but not its title, body or `updated_at`, so the inbox order does not move when a request is resolved.

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

**Amended by D-50 and D-56** (planned, spec 13 §3, §6.3): a virtual session of a session template runs the same named phases in a shared browser (its template host) instead of launching its own; `maxSessions` bounds browsers (exclusive sessions and running hosts), and virtual sessions are counted as sessions.

## D-22 Blocklist

**Status:** Accepted

**Context.** Operators need to keep agents away from certain sites regardless of what the agent asks for, with an audit of attempts.

**Decision.** An operator-maintained blocklist file (one URL glob per line, `#` comments, case-insensitive anchored matching with and without the scheme, a host pattern covering every path beneath it; spec 11 §5) is enforced twice: at the tool level before a navigation starts (`URL_BLOCKED`) and at the network layer for every document request (fail-closed). Every hit is audited with its source (`tool` or `request`). Edits apply without restart: `POST /api/v1/blocklist/reload` and a debounced file watcher replace the rule set atomically, and a failed reload leaves the previous rules in force.

**Consequences.** Sites opened by page scripts or redirects are blocked as reliably as direct navigations. Rules editable in the dashboard and stored in the DB belong to the security-intercept engine (D-25); not built.

**Amended by D-54** (planned, spec 13 §3.8, §9.3): the interception chain becomes one route with ordered handlers (a self-origin guard on template hosts, the blocklist, the method- and resource-type-aware request guard for site-pack rules); the blocklist file, its grammar and its document-only enforcement are unchanged.

**Amended by D-57** (planned, PR T0d): agent-requested URLs are checked for a web scheme before the blocklist, so its fail-open handling of other schemes no longer applies to them.

## D-23 Naming inside the codebase

**Status:** Accepted

**Context.** Consistent naming across TypeScript, files, wire, config and the database removes a whole class of review comments and mapping bugs.

**Decision.** TypeScript: camelCase identifiers, PascalCase types, `SCREAMING_SNAKE` only for true constants. Files: kebab-case. Wire: snake_case (D-05). Config: camelCase (D-06). Database: snake_case columns with unit-bearing names (`*_at` epoch ms, `*_ms`, `*_bytes`). IDs: `<slug>-<nanoid8>` sessions, `t-<nanoid6>` tabs, `e-<ulid>` events (time-sortable, so event ids order like the events), `a-<nanoid12>` operator requests, `p-<nanoid12>` principals, `n-<nanoid12>` notifications, `m-<nanoid16>` MCP sessions, `c-<nanoid10>` realtime connections, `tp-<nanoid10>` session templates (D-49).

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

**Amended by D-49** (planned, spec 13 §2.4): the layout gains `templates/<template_id>/{userdata/,versions/,downloads/}`, `admin/template.key` (`admin/` 0700) and `site-packs/{cache/,local/}`. PR T0a adds `auth-states/p/<first 16 hex chars of SHA-256(subject)>/` for the snapshots of principals other than `local`.

## D-25 What is explicitly not built (seams only)

**Status:** Accepted

**Context.** Several features are likely but not required for the first release. Building their seams now avoids reshaping public contracts later; building the features now would delay the product.

**Decision.** Not built: managed proxy pool and rotation; foreign fingerprint identities; profile blueprints (named, versioned, encrypted); local vault, TOTP, 1Password; extensions registry; security-intercept rule engine; resource governor and eviction; CAPTCHA detection and solving; Web Bot Auth; Tor egress; benchmark harness; multi-user, organisations and OIDC; Firefox and WebKit engines; standalone binaries. Each has a named seam in `01-overall-architecture.md` §9.

**Consequences.** Reserved enum values and config values for these features fail fast with a clear message rather than silently doing nothing. External notification channels left this list in 0.2: they are built in stages from the contract and outbox up (D-32 to D-39).

**Amended by D-49 and D-54** (planned, spec 13): named, versioned, encrypted signed-in identities are built as session templates rather than as a `blueprint` persistence mode (which stays reserved), and site packs are the first client of the security-intercept and extensions seams.

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

**Consequences.** On macOS, Windows, most Linux hosts and with Google Chrome on Ubuntu, sessions now run sandboxed without configuration. On Ubuntu with the bundled browser the first session of a process pays one failed launch (about 0.3 s) and runs unsandboxed, as before; `doctor --printApparmorProfile` prints (never installs) a profile that fixes it. Page-visible signals are identical with and without the sandbox (measured on all three OSes). Which way each session actually ran is recorded at launch and kept with the session (D-31). `doctor` reports the fallback with its fix but as ✓, not a warning: sessions still launch, and a `doctor` that started exiting 2 would break healthchecks that passed before; under `on` the same verdict is a failure.

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
- **Observability, not trust.** Harness, model, workspace and the meta bag are recorded and shown faithfully as reported; they are never used for quotas, tool visibility or any other decision, and for access control only as the narrowing vault guard of D-48 (a vault binding or group policy may name harnesses, which only ever removes access that the principal and slug rules give). Every surface that shows them says once, plainly, that they are reported by the client or by the user's configuration and cannot be verified. No other policy is built on them until a harness can be verified (a token binding would be the first such source).
- **Resolved per request, cached on the connection.** Every tool call resolves identity from the signals it carries (its request's headers and URL, its `_meta`) plus the connection's (`initialize`, the stdio environment); `mcp_connections` holds the latest resolution. The ladder, highest first, each step recorded as `harness_source`: `env` (`BROWSERHIVE_HARNESS`, stdio) or `header` (`X-BH-Agent-Harness`, alias `X-BH-Harness`); `injected_env` (`CLAUDECODE` → `claude-code`, `GEMINI_CLI` → `gemini-cli`, stdio); `url` (`?harness=` on `/mcp`); `meta` (`_meta['ai.browserhive/harness']` on the call, then on `initialize`; the `browserhive.ai/` prefix is read too); `client_info` (`clientInfo.name` through the alias table); `user_agent` (through the alias table); `none` → `unknown`. The source vocabulary is open (`token` is reserved for a verified binding). Signals that name a different harness than the winner are recorded as conflicts, logged once per connection at `info` and shown on the connection; a connection is never refused over them.
- **Open vocabulary.** `harness` is a string on the wire and in the database, never a closed enum: a known slug from the table in `contracts/harness` (with a display label), `unknown` (nothing identified the client; a first-class, countable value) or `other`, or a sanitised slug of an unrecognised value (`[a-z0-9-]`, ≤ 32 chars). Generic SDK defaults (`mcp`, `mcp-client`, `example-client`, `test-client`, `client`, `cli`, `rmcp`, `acp`) mean `unknown`. Metric attributes fold every slug outside the known table into `other`.
- **Model and workspace are declared only.** Model: `X-BH-Agent-Model` (alias `X-BH-Model`), `BROWSERHIVE_MODEL`, `_meta['ai.browserhive/model']`, with a `model_source`; absent means "not reported", never a guess. Workspace: `X-BH-Workspace`, `BROWSERHIVE_WORKSPACE`, `_meta['ai.browserhive/workspace']`.
- **A small capped meta bag.** `X-BH-Meta-<Name>` headers and other `ai.browserhive/*` `_meta` keys are kept verbatim, at most 16 keys, 256 bytes per value and 4 KiB in total; the rest is dropped with one log line per connection. The bag is display-only: never a facet, a filter, a metric attribute or an input to any decision.
- **The identity environment variables are not configuration.** `BROWSERHIVE_HARNESS`, `BROWSERHIVE_MODEL` and `BROWSERHIVE_WORKSPACE` describe one stdio process, not the server; the config collector skips exactly these three names (`IDENTITY_ENV_VARS`), so they appear in no config schema, `config show` or `--help` key list, and a misspelling still gets a "did you mean" (spec 08 §4).
- **A session's harness is fixed at launch.** `sessions.harness` is written once when the session is created, so facets, filters and counts do not change when a connection row is updated or pruned. Sessions created before schema v3 read `unknown`. Since schema v7 the raw declared name rides next to it (`sessions.harness_declared`, and the latest one on `mcp_connections.harness_declared`; D-48).

**Amended by D-52** (planned, spec 13 §6.1): a session template's grant may also carry a harness list, with D-48's semantics and the same "narrowing guard, not a boundary" wording.

**Consequences.** With no configuration, Claude Code and Gemini CLI over stdio and Codex, OpenCode, Cursor, Claude Code and others over HTTP are recognised; everything else is `unknown` rather than an empty cell. One header, environment variable or query parameter names any other harness. Per-harness notification routing and per-harness template visibility can read `harness` from session and tool-call event payloads without a query. Metric series grow by at most the size of the known table.

**Alternatives considered.** *Enforcing policy on the reported harness*: rejected as a control; any client can claim any name, so a harness allowlist would be a typo guard presented as a control. D-48 admits exactly that typo guard on vault rules, named and documented as one, never as a boundary. *A closed zod enum*: rejected; a new harness ships every month and an unknown value would become a 400. *Inferring the model* (sampling, inherited `ANTHROPIC_MODEL`, a tool argument): rejected; sampling names the model the client picked for that request, is deprecated in `2026-07-28` and would prompt the user, and the others are guesses. *Process inspection of the stdio parent*: rejected; fragile across platforms and a poor look for a local-first tool. *A `/mcp/<harness>` path*: deferred; the query form works with no routing change. *Registering the identity variables as config keys*: rejected; they would appear in `--help` and `config show` as server settings, which they are not.

## D-31 A session's sandbox state and browser version are recorded at launch

**Status:** Accepted

**Context.** Since D-27 a session's summary says whether its browser runs inside Chromium's sandbox, and with which real browser version, but the value was read from the live browser handle only: once the session closed it was gone, and history could no longer answer "did this session run sandboxed?". Under `sandbox=auto` the answer depends on the browser and the host (Ubuntu with the bundled browser falls back, Google Chrome on the same machine does not), so it cannot be inferred from the configuration afterwards.

**Decision.**
- Schema v4 (`0004-session-browser`, `compatible: true`) adds two nullable columns: `sessions.sandboxed` (`INTEGER CHECK IN (0,1)`) and `sessions.browser_version` (`TEXT`). Nothing is backfilled: a guess would be worse than no answer.
- The session aggregate keeps the launch facts it attached (`browserInfo`: the verdict the sandbox policy applied and `Browser.version()`), including after teardown. They are written with the `session.updated` patch once the browser has launched (first when the session becomes live) and never cleared. If a session's browser is launched again, the latest launch wins, since that is what the session ran with last; today no path relaunches a session's browser.
- `SessionSummary.browser` keeps its shape (`{version, sandboxed}`, optional). Every builder applies the same order: the live handle, then the recorded launch (in memory or from the row, when `sandboxed` is not NULL), else absent. When the driver has no `Browser` object to ask, the version is `null` while the verdict is still recorded (Chromium persistent contexts do expose one: measured, the version is recorded).
- Absent means "not recorded" (sessions from before v4, sessions whose browser never launched, drivers that report no launch facts). No surface shows it as "no" or "not sandboxed"; the dashboard distinguishes "not launched" where the state says so.
- The MCP tool surface is unchanged (D-12): the record is on the admin API and the dashboard only.

**Consequences.** Closed sessions keep showing whether they ran sandboxed and with which browser version, in the API, over WS and in the dashboard. Older readers still open the database (the migration is additive). History from before the upgrade honestly reads "not recorded".

**Alternatives considered.** *Inferring the verdict for old rows from the channel and the host*: rejected; the policy's verdict depends on the executable, the host and the mode at the time, none of which is stored. *First launch wins*: rejected in favour of the latest launch, which is what the session actually ran with last. *A new `sandbox: 'sandboxed' | 'unsandboxed' | 'unknown'` wire field*: rejected; the existing optional `browser` already expresses "not recorded" by its absence, and a second field would duplicate it.

## D-32 The notification contract is producer-owned, versioned and full-state

**Status:** Accepted

**Implementation:** the notification foundations (plan N0): contract, producers, JSON Schema, `degrade()`.

**Context.** Notifications are about to leave the machine: Telegram, Discord, ntfy and a generic webhook first, more later (D-16). Each platform renders differently, some can edit a sent message and some cannot, and a user may build their own consumer from the webhook. If every adapter read domain events or the database, each would re-derive what happened, re-decide what may leave the machine, and break whenever the core changes. The in-app row (`Notification`) was designed for the inbox and carries neither severity, lifecycle, structure nor links.

**Decision.**
- BrowserHive owns one message contract, `NotificationMessage` (`@browserhive/contracts/notifications`): zod-first, JSON-serialisable, `schema: 1`, with a JSON Schema published at `docs/reference/notification-message.schema.json` and regenerated in CI like the other references. It carries `id`, `revision`, `thread`, `kind`, `category`, `severity`, `state`, `alert`, `at`, `title`, `summary`, semantic `blocks` (a tiny inline AST, never a markdown string), up to 5 `actions` (`act` commands with an `open` fallback, or `open` dashboard paths), routing `entities` and the `privacy` already applied. Field names are snake_case like every other wire shape (D-05).
- **Producers own it; consumers only render it.** Producers are pure, table-driven functions from observed bus events (spec 03 §9). A platform adapter receives the contract and nothing else: it never reads domain events or the database. **Agents never author notifications**: every message derives from facts BrowserHive observed (D-09, D-12); there is no `notify` tool.
- **Full-state revisions.** A notification keeps its `id` for life; every state change is `revision + 1` and the message is complete at every revision, so a re-send or re-edit is always correct and adapters are idempotent.
- **Redaction happens before the contract** (spec 10 §9): every string a producer copies from an event goes through the `Redactor` (registered secrets and credential patterns) and URLs through `sanitizeUrl`. Content levels (`counts` < `titles` < `full`) are applied by the core per channel, never by an adapter.
- **Versioning.** Additive changes (a new optional field, a new kind, block, inline or command) keep `schema: 1` (N3 added the kind `digest.weekly`, the `chart` block and the optional `report` field this way); consumers MUST ignore what they do not know (an unknown block renders as nothing, an unknown action is skipped). Removing or re-typing a field bumps `schema`, and the generic webhook announces the version it sends.
- A shared, pure `degrade(message, capabilities)` adapts a message to what a renderer supports (tables → lists, charts → a line of text bars, images dropped or linked, `act` → `open`, truncation with "… Open in BrowserHive"); renderers never implement fallbacks themselves. A new block type is added only when `degrade` can turn it into something every renderer already draws.

**Consequences.** Adding a platform is a renderer plus a transport against a fixed input, testable with golden files. The contract is a public compatibility surface: its JSON Schema is diffed in review. The in-app `Notification` DTO keeps its shape and gains the contract's classification fields (`kind`, `category`, `severity`, `state`, `revision`, `thread`) additively. Rows from before schema v5 have no stored message (`message_json` NULL): nothing is fabricated for them.

**Alternatives considered.** *Adapters over the wire DTO* (the research's envelope): no structure, no lifecycle, and every adapter would derive links and severity itself. *A markdown string body*: every platform escapes markdown differently (Telegram MarkdownV2 reserves 18 characters) and a page title would break messages. *Letting agents send notifications*: a prompt-injected page would become a message from BrowserHive on the operator's phone; `request_attention` already is the agent's way to reach a human.

## D-33 No hosted infrastructure; bring your own credentials; secrets only as environment variable names

**Status:** Accepted

**Implementation:** binding on every channel; the storage (`secret_refs_json`) since the notification foundations (N0); the checks (API validation, the exit-64 flag refusal, the set/missing check that never shows a value) since the first channels (N1).

**Context.** BrowserHive is local-first. A relay, a shared bot or a hosted callback would make BrowserHive a service with an operator, an uptime and a data-protection story, and would see every user's messages. Channel credentials (bot tokens, webhook URLs, access tokens) are live secrets; the database is backed up (`db backup`) and copied around.

**Decision.**
- BrowserHive provides no server, relay or shared bot, now or later. Everything it does with a platform is an **outbound** connection from the user's machine (HTTP requests, Telegram long polling, the Discord gateway WebSocket, ntfy subscriptions); nothing needs a public URL or an open port.
- Every user brings their own Telegram bot, Discord webhook or bot and ntfy topic, and has full authority over it.
- **Secrets live only in the environment.** A channel stores the *names* of environment variables (`secret_refs_json`, `token=env:BH_TG_TOKEN` in a startup channel), never a value, so a database backup never contains a token. An inline secret is refused: over the API with a validation error, on the command line with exit 64. The dashboard shows whether a variable is set, never its value. Names starting with `BROWSERHIVE_` are refused, because the config loader reserves that prefix.

**See D-55**: the site-pack registry on browserhive.ai is static files on the project's website, not a server BrowserHive runs, so this decision stands. A template proxy's `password_env` follows the channel rule: a name starting with `BROWSERHIVE_` is refused.

**Consequences.** Changing a token is an environment change plus a restart. Features that seem to need an inbound connection are designed without one: act buttons arrive through Telegram long polling, the Discord gateway or a second ntfy topic (D-38, D-41, D-42).

**Alternatives considered.** *A shared BrowserHive bot*: users would share a rate limit and trust a third party with every message. *Storing tokens encrypted in the database*: the key would have to live next to the database, so a backup would still carry both.

## D-34 Notification delivery is a transactional outbox: at least once, full-state, silent edits, no degradation loop

**Status:** Accepted

**Implementation:** the notification foundations (N0): tables, worker, breaker, retention, metrics; the Telegram, Discord webhook, ntfy and generic webhook adapters since N1.

**Context.** An external platform can be down, rate-limited or misconfigured, and BrowserHive can stop at any moment. A delivery made from an in-memory callback is lost on restart, and the producer's in-memory de-duplication set does not survive one either. A channel failure reported as a system degradation would itself produce a notification, delivered through the failing channel: a feedback loop.

**Decision.**
- A notification change and its delivery jobs (`notification_deliveries`, one row per channel × revision × op) are written in **one transaction**; a worker drains the jobs. `notification_deliveries` is both the outbox and the delivery log; `notification_channel_messages` maps a channel and notification to the platform message it produced, its last revision and its TTL deadline.
- **At least once.** Jobs left `sending` by a crash are retried at the next start. Edits and deletes are idempotent (full-state, D-32); a crash in the middle of a *new* send can duplicate that message, which is documented.
- **Coalescing.** A job renders the notification's current state; a job whose revision a later delivery already covered is `superseded`. At most one edit per message every 3 s.
- **Edits are silent.** Anything that must wake the user is a new message (`alert: true`). When a platform cannot edit, or the message was deleted in the chat, an alerting revision is sent as a new message and anything else is `superseded`.
- **Retries.** Exponential backoff with jitter, honouring `retry_after` / `Retry-After`; a job is `dead` after 8 attempts or 24 h.
- **Circuit breaker.** 5 consecutive failures mark the channel `broken`. That is shown in-app (a `channel.broken` notification and the channel's status) and **never** raised as a system degradation. The loop is cut structurally by kind: `channel.broken` notifications are delivered in-app only and are never enqueued for an external channel.
- **Backlog.** After an outage only the latest revision per notification is sent, and more than 20 pending `info` sends on one channel collapse into the newest one with a "you missed N" note.
- **Suppressed deliveries are logged** with a reason (`filtered`, `quiet_hours`, `throttled`, `channel_paused`, `content_blocked`, `image_blocked`, `edit_unsupported`, `delete_unsupported`, `collapsed`), so "why didn't I get it?" always has an answer.
- With no external channel configured nothing is enqueued, no worker timer runs and the only cost is one indexed read of `notification_channels` at startup.
- **Addressed notifications.** A scheduled report (D-43, D-44) is planned for the one channel it was produced for, and only that channel's paused/adapter state applies; every other notification is planned for every channel, filtered by its rules.

**Consequences.** Delivery rows are telemetry-class (30 days, spec 03 §7.1); channels are configuration and never pruned. `browserhive.notifications.deliveries{channel_kind,status}` counts outcomes and every platform call is a span (spec 10). A per-principal routing model is not built: channels are instance-wide and deliveries are enqueued once per produced notification, matching the single shared inbox (spec 03 §9).

**Alternatives considered.** *Fire-and-forget calls from the producer* (the pre-0.2 seam): no retry, no log, lost on restart. *A retry counter to stop the degradation loop*: it bounds the loop instead of removing it, and a slow loop still spams the other channels. *Delivering the latest revision per thread* (the plan's first wording): a thread can hold several notifications (a session's crash and its wrap-up), so coalescing is per notification.

## D-35 Message TTL is performed by BrowserHive

**Status:** Accepted

**Implementation:** `expires_at` and the sweeper since the notification foundations (N0); the rules, platform deletes, the 47 h Telegram cap and the wizard since the first channels (N1).

**Context.** Users want notifications that clean themselves up. No platform offers a per-message timer to bots; Telegram's auto-delete timer is a whole-chat setting chosen by the user, and a bot may delete its own messages only within 48 hours of sending them.

**Decision.** BrowserHive deletes the message itself. A TTL can be set per channel and category; the default is **never** for every category. The deadline is stored as `expires_at` on the channel message when it is sent, so a deletion that fell due while BrowserHive was stopped happens at the next start and is logged as late. "Delete when resolved" is offered per channel and category and is **off** by default. The setup wizard caps Telegram TTLs at 47 h and suggests Telegram's own chat timer as a backstop; a message that became too old while BrowserHive was stopped is logged as `could_not_delete: too_old`. The UI says plainly that a lock-screen preview someone already saw cannot be taken back, and that ntfy.sh drops attachments after 3 h regardless.

**Consequences.** TTL deletes are ordinary outbox jobs (`op = delete`) with the same retries and log.

## D-36 Screenshots in notifications are opt-in; vault screenshots are taken before the fill

**Status:** Accepted

**Implementation:** implemented with the first external channels (N1): capture at attention, vault-confirm and crash, per-channel variant selection, masking (spec 03 §9.5); the contract's `image` block and `privacy.has_image` since N0.

**Context.** A screenshot is the most useful and the most dangerous thing a notification can carry: a logged-in page, an inbox, a balance, or a credential being typed.

**Decision.** Screenshots are off by default and switched on per channel and category, for three triggers only: an attention request (CAPTCHA requests are attention requests with a CAPTCHA reason; no new detector), a vault fill and a session crash (its last screenshot, when one exists). The vault screenshot is taken **before the fill sequence starts** (the login page and the origin being filled), never during or after a fill and never while a secret window is open. Images are never sent when `recordToolResults=none` or when the channel's content level is below `full`. An optional setting masks form fields (Playwright's screenshot `mask`). The wizard recommends a self-hosted ntfy for images or warns about ntfy.sh's public 3-hour attachment store.

**Amended by D-54** (planned, spec 13 §9.5): site-pack challenge requests (`security_intercept`) are not a screenshot trigger in v1; their notifications link to the live view.

## D-37 `publicUrl` builds notification links and is trusted automatically

**Status:** Accepted

**Implementation:** implemented in N1: the config key (08 §5.8), the link builder, host and origin trust, the `/health` `instance_id` check in `doctor` and on the System page; the `LinkBuilder` port since N0.

**Context.** "Open session" in a notification is a link, and a `127.0.0.1` link does nothing on a phone. Users who reach their dashboard remotely do it through their own reverse proxy, Cloudflare, Caddy, nginx or a Tailscale name, which today also needs `allowedHosts` and can fail the origin check when a proxy rewrites `Host`.

**Decision.** A config key `publicUrl` (absolute `http(s)://`; a warning for `http` on a non-loopback host) holds the address where the user made the dashboard reachable. Every open link in a notification is `publicUrl + path`, built by one `LinkBuilder`; without `publicUrl` links use the local address and are labelled "Open on this computer". The `publicUrl` host is added to the Host allow-list and accepted by the origin (CSRF) guard. `doctor` and the System page check it by fetching `<publicUrl>/health` and comparing this start's random instance id. Links never carry tokens; opening one still needs a login. BrowserHive provides no proxy or tunnel.

## D-38 A Discord channel uses webhook mode or bot mode, one per channel

**Status:** Accepted

**Implementation:** webhook mode since the first channels (N1); bot mode with act buttons since N2; `notification_channels.mode` since N0.

**Context.** A Discord webhook takes 30 seconds to create and needs no connection, but its messages cannot carry interactive buttons. A bot needs a Developer Portal application and a gateway connection, and is the only way to receive button presses without a public endpoint (an Interactions Endpoint URL and the gateway are mutually exclusive).

**Decision.**
- Each Discord channel uses exactly one mode: **webhook** (default: open links only; act buttons degrade to "Open in BrowserHive") or **bot** (opt-in: act buttons over the gateway WebSocket while BrowserHive runs). A webhook-mode channel names a `webhook` variable; a bot-mode channel names a `token` variable and a target `channel_id` (with `guild_id` and display names). Switching mode is an edit of the channel that replaces the other mode's variable and keeps the rules.
- Bot mode sends, edits and deletes through the bot REST API (`POST /channels/{id}/messages`, `PATCH`/`DELETE …/messages/{id}`) with the same embed as webhook mode (D-40). The setup builds the invite link with the minimal permissions (View Channel, Send Messages, Embed Links, Attach Files: `52224`), lists the bot's servers and their text channels through the bot API, and links the operator's Discord account with a one-time "This is me" button, whose press becomes the first allow-list entry (D-41).
- Presses arrive as `INTERACTION_CREATE` over the gateway, which BrowserHive implements itself (Hello, Identify with intents `0`, heartbeat with zombie detection, Resume, Reconnect, Invalid Session, fatal close codes) on Bun's WebSocket client with no dependency. Every press is answered within Discord's 3-second window: an ephemeral reply when the command finishes in 2 s, otherwise a deferred ephemeral reply edited when it does. The connection reconnects with backoff and resumes where Discord allows it; its state (connected, reconnecting, offline) shows on the channel card. One gateway connection serves every channel of the same bot.
- The setup explains the two modes with pictures of BrowserHive's own messages, never images copied from Discord or the web.

**Consequences.** A bot token is a secret like any other (D-33). While BrowserHive is stopped, Discord shows "This interaction failed" for a press; nothing is queued.

**Alternatives considered.** *An Interactions Endpoint URL*: needs a public HTTPS endpoint (D-33). *discord.js*: a large dependency for four gateway opcodes.

## D-39 Startup channels come from command-line flags only and are read-only

**Status:** Accepted

**Implementation:** the registry merge and clash rule since the notification foundations (N0); the flag, its parser and the read-only dashboard rows implemented in N1.

**Context.** Some users want a channel that exists from the first start (a server, a container) without clicking through the dashboard. Nested per-channel rules do not fit the flat config grammar (spec 08 §2), and a second copy of a channel in the config file and the database would be two truths. Process arguments are visible to other users of the machine (`ps`).

**Decision.** Startup channels are declared only with a repeatable `--notificationChannel` flag (spec 08 §5.7): not in the config file and not in the environment. A startup channel references secrets by environment variable **name** (`token=env:BH_TG_TOKEN`); an inline secret is a usage error (exit 64). At each start the startup channels are projected into `notification_channels` with `source = 'startup'` (their configuration columns rewritten from the flags, their status and failure counters kept), so deliveries keep their foreign keys and the breaker state survives restarts; a startup channel no longer passed is removed with its delivery log. The dashboard and API show them read-only with a "from startup" badge. A startup channel whose name matches a dashboard channel stops startup with `CONFIG_INVALID` (exit 64); neither silently shadows the other.

**Alternatives considered.** *A `notificationChannels` config key with a URI grammar* (the research's P1): secrets would sit in a file that gets committed, and per-channel rules would need a grammar the config ladder does not have. *Seeding the database from config on first run*: friendlier once, but the file would then lie about what is configured.

## D-40 Platform message formats: Telegram Rich Messages with a classic fallback, Discord embeds

**Status:** Accepted

**Implementation:** Discord embeds and the classic Telegram renderer since the first channels (N1); Telegram Rich Messages since N2.

**Context.** Telegram's Rich Messages (`sendRichMessage`, Bot API 10.1, June 2026; blocks and media 10.2; button rows and expandable quotes 10.3) add headings, real tables and footers. The first channels shipped classic HTML because the rendering on real clients was unverified; the owner has since checked Rich Messages on a phone (images, links, bold and italics, code blocks and buttons all render). Discord's documentation states that a webhook message with `IS_COMPONENTS_V2` may carry only components: `content`, `embeds` and `files[n]` fail with 400, so a V2 webhook message cannot upload a screenshot.

**Decision.**
- Telegram channels send **Rich Messages**: `sendRichMessage` with `rich_message.html` (headings, paragraphs, a bordered table for tables, a compact table for fields, an expandable blockquote, `pre`/`code`, `footer`, `tg-time`), the screenshot as a media block (`<img src="tg://photo?id=shot">` with `media: [{id, media: attach://shot}]`, multipart), `skip_entity_detection: true` so page text never becomes a mention or a command, and an inline keyboard for links and act buttons (`style` success/danger/primary). Revisions use `editMessageText` with `rich_message`, re-using the photo by its `file_id`. The capabilities declare `tables: true`.
- **Classic HTML is the fallback only**: when Telegram rejects a rich call (400, or 404 from a Bot API server that does not know the method), the same delivery is sent as the classic `sendMessage`/`sendPhoto` with `parse_mode: HTML` (tables written as lines), and a 404 makes the channel classic for the rest of the run. Each message remembers its format in its ref, so messages sent classic (including every message from before N2) keep being edited classic.
- Discord sends one embed (colour by severity, fields, image as `attachment://`) plus action rows (link buttons, and interactive buttons in bot mode), not Components V2, in both modes.

**Consequences.** Tables arrive as tables on Telegram. A formatting mistake costs one extra call, not a lost message. The contract needed no change.

**Alternatives considered.** *Classic HTML only*: no tables, no headings. *Rich `blocks` (JSON) instead of `html`*: the same result with a larger, less readable payload and preview. *Discord Components V2*: no screenshots through a webhook.

## D-41 Act buttons: single-use command tokens, allow-lists, presses over outbound connections

**Status:** Accepted

**Implementation:** N2 (Telegram, Discord bot mode, ntfy; the generic webhook carries act actions as-is).

**Context.** An attention request or a vault confirmation waits for a person who may be away from the dashboard. Answering from the chat is the fastest path, but a button in a chat is a remote control for the agent's browser: it must work only for the right person, once, while the request is still open, and it must not need a public endpoint (D-33).

**Decision.**
- **Opt-in per channel.** `rules.act_buttons` is off by default. With it on, a platform that can receive presses keeps the `act` actions (`degrade` otherwise turns them into their `open` fallback): Telegram, Discord in bot mode, ntfy with a reply topic (D-42). The generic webhook, with act buttons on, carries the `act` actions of the contract unchanged and without tokens; its consumer answers through the REST API with its own bearer token (`POST /api/v1/attention/{request_id}/resolve`, scope `attention:resolve`), so BrowserHive adds no callback endpoint.
- **Command tokens.** Each act button carries `bh1:<token>`: 11 URL-safe characters (66 random bits) minted by the outbox just before the platform call and written first, so an early press finds its row. `notification_action_tokens` binds the token to its channel, notification, action, `op` and `args`, and stores it only as a SHA-256 hash, like API tokens and grants. A token is single use (claimed atomically) and expires after 24 h (Telegram keeps undelivered presses that long). Because only the hash is kept, every platform call that draws act buttons mints fresh tokens; an edit of a still-open message leaves the tokens it replaced valid until they expire, bound to the same command, so a press racing the edit still works.
- **Checks, in order.** The token is known; it belongs to the channel the press came from, and the press came from that channel's chat (Telegram chat id, Discord channel id); act buttons are still on and the channel is active; the token is unused and unexpired; the notification is still `open`; the presser's platform user id is on the channel's **allow-list** (`rules.allow_list`; by default the person who connected the chat in the setup: the Telegram `/start`, or the Discord "This is me" button; more ids can be added). ntfy has no per-user identity (D-42). Then the command runs through the same application service as the dashboard route: `attention.resolve` (resolve or reject) and `vault.confirm.resolve` (approve or deny), the two ops producers put on buttons. `session.extend_lease` and `session.close` are reserved in the contract but no producer offers them (there is no operator-side lease extension), so a press of one is refused.
- **Actor and audit.** The actor is `telegram:<user id>`, `discord:<user id>` or `ntfy:topic-b`; it is the request's `resolved_by`, so the revised message says who answered and from where. Every press of a known token writes one `notification_actions` row (audit class): when, channel, notification, action, op, actor and display name, outcome (`done`, `failed`, `not_allowed`, `used`, `expired`, `stale`, `wrong_channel`, `disabled`) and detail. A press with an unknown token is answered and counted, not stored, so a stranger cannot fill the audit table. The presser gets a short answer in the chat (a Telegram toast, an ephemeral Discord reply); a refusal names the reason, and a refused allow-list check names the presser's id so the operator can add it.
- **The message follows the state.** A successful command settles the request; the settlement is a revision (03 §9.1) and the outbox's silent edit removes every button and shows the outcome and the actor. A press made while BrowserHive was stopped is processed at the next start if the platform kept it (Telegram 24 h, ntfy's cache 12 h) and refused as `stale` or `expired` when the request no longer waits (the startup reconcile settles orphaned requests first).
- **No second confirmation.** A press is the answer: Approve or Reject from the chat acts at once, with no "are you sure?" round trip (confirmed after the N2 review). The safeguards are the ones above: the opt-in, the allow-list, the chat binding, a single-use token and a request that must still be open.
- **Scopes.** A press acts with the authority of the operator who enabled act buttons (the single operator holds every scope, D-09); each op is tied to the scope of its dashboard route (`attention:resolve`, `vault:confirm`).
- **Presses arrive only over outbound connections**: Telegram `getUpdates` long polling (one poller per bot token, shared with the setup's `/start` wait, its offset persisted so a press is handled once), the Discord gateway (D-38), an ntfy subscription (D-42). Their connection state shows on the channel card.

**Consequences.** Tokens never appear in logs, the delivery log, previews (which show `bh1:preview-<action>`) or the API. Deleting a channel deletes its tokens; its audit rows keep the channel's name. `notification_actions` follows `auditRetentionDays`; used or expired tokens are pruned a day after they expire.

**Alternatives considered.** *A second confirmation in the chat* ("Approve? Yes / No"): every answer from a phone would take two taps and two messages, and it adds nothing the allow-list and the single-use token do not already check. *An HMAC-keyed token* (the plan's first wording): with 66 random bits, a 24-hour life and single use, a keyed hash protects nothing a plain SHA-256 does not, and it adds a key to generate, store and back up. *A signed URL on the dashboard* for the buttons to call: needs a public URL and exposes a callback to the internet (D-33). *Telegram webhooks*: a public HTTPS endpoint. *Act buttons on by default*: a chat is shared more casually than a dashboard login.

## D-42 ntfy answers through a second, private topic

**Status:** Accepted

**Implementation:** N2, after a spike (2026-09-28) against `binwiederhier/ntfy:v2.28.0` and ntfy.sh.

**Context.** ntfy has no bot identity and no callbacks; its `http` action makes the phone send a request when a button is tapped. The plan proposed pointing that request at ntfy itself. The spike showed: a notification whose `http` actions target the same server's topic B is accepted unchanged; a streaming subscription to topic B receives a phone-style `POST` within a second; `?since=<id>` returns only later messages; a notification is replaced by its `sequence_id`. ntfy documents the `http` action as supported on Android and iOS (iOS since app 1.1, May 2022).

**Decision.**
- An ntfy channel may name a **reply topic** ("topic B": a literal `reply_topic`, or one from a variable) on the same server, and an optional `reply_token` variable to read it (default: the channel's `token`). With act buttons on, each act button becomes an `http` action that POSTs `bh1:<token>` to `<server>/<reply topic>` and clears the notification; ntfy allows three actions, filled by importance (act buttons first, then links).
- BrowserHive subscribes to topic B (`GET /<topic B>/json`, streaming, outbound), resumes after a restart or a dropped connection from the last message id it handled (`since=`; ntfy's cache keeps 12 h), ignores anything that is not `bh1:<token>`, and answers a valid press like any other (D-41). The resolution replaces the topic-A notification by sequence id (a silent revision). A refused press changes nothing on the phone.
- ntfy has no per-user identity: the actor is `ntfy:topic-b` and there is no allow-list. **Whoever can read topic A can press its buttons**, so topic A must be private: an unguessable name on ntfy.sh, or access control on a self-hosted server. Topic B only needs to be writable by the phone: on a self-hosted server the recommended ACL is `everyone` write-only on topic B, with BrowserHive reading it with a token. Someone who learns only topic B can post to it (ignored unless it is a live token), replay used tokens (refused) and see tokens that were already used; they cannot guess a live token (66 bits) and so cannot act.

**Consequences.** Two-way ntfy needs no BrowserHive endpoint. Presses made while BrowserHive was stopped for more than ntfy's cache time are lost (the request is settled by then anyway).

**Alternatives considered.** *Open links only on ntfy*: the fallback if the spike had failed. *Putting an access token in the `http` action's headers*: anyone who reads topic A would get a write token.

## D-43 Scheduled reports: addressed to each channel, in its time zone, sent late once, never empty

**Status:** Accepted

**Implementation:** N3: `ReportScheduler` and the report producers (`app/notifications/reports*.ts`), the `digest` rule, `POST /channels/{id}/digest`, the wizard's Reports section, `--notificationChannel … digest=…`.

**Context.** A daily summary is the notification people keep when they do not want to be interrupted. "09:00" means the operator's wall clock, which moves with daylight saving time and differs between the phone a channel reaches and the host BrowserHive runs on. BrowserHive is a local daemon: it is stopped, the laptop sleeps, a container restarts. A report must neither be lost because the daemon was off at 09:00 nor arrive five times after a long weekend, and a report that says "nothing happened" is noise.

**Decision.**
- **Per channel, addressed.** A channel opts in with `rules.digest` (`every: 'day'|'week'`, `at: 'HH:MM'`, `day` for weekly, `weekdays_only` for daily). Every report is its own notification, addressed only to that channel (the outbox plans it for no other channel), because the window, the time zone, the thresholds and the content level are the channel's. The schedule is the opt-in: the channel's category, severity, session and harness filters do not apply to its reports. The channel's copy is stored read and dismissed (like a test send), so it never shows in the inbox; the delivery log keeps its record, and the inbox and the Reports tab get **one in-app copy per period** instead (D-45).
- **Defaults.** "Every day" runs every day, weekends included, at 09:00; an optional **weekdays only** runs Monday to Friday, and Monday's digest then covers the whole weekend (its window starts at Friday's run). "Every week" runs on **Friday at 17:00** in the channel's zone and covers the full seven days before it, weekends included. Both are changeable; the startup flag uses the same defaults (`digest=weekly` alone is Friday 17:00).
- **Time zone.** `rules.time_zone` (an IANA name) is the channel's zone for its reports and its quiet hours (`quiet_hours.time_zone`, when set, still wins for quiet hours). Absent, it is **the host's zone, read at each evaluation** (so a moved host follows). The window of a report is the local period that ends at the scheduled time: yesterday 09:00 to today 09:00 (23 or 25 hours across a DST change), or the previous week. A local time that does not exist on a day (spring forward) fires at the same wall time shifted by the gap; a local time that occurs twice (fall back) fires once, at its first occurrence.
- **Durable, exactly once per window.** The last handled occurrence and the end of the last window are kept in `notification_cursors` (`digest:<channel_id>`), written in the same transaction as the report's notification and delivery row. Changing a schedule re-arms it from the moment of the change: an edit never causes a late report.
- **Late, once.** When the daemon starts (or wakes) after one or more scheduled times passed, the **most recent** missed window is produced and marked late ("Sent late: BrowserHive was not running at 09:00"); older missed windows are skipped and counted in one line ("2 earlier digests were skipped while BrowserHive was off"). A report is late when it is produced more than 5 minutes after its scheduled time. At most one late report per schedule, and that is final (confirmed after the N3 review): the skipped windows are never produced later or merged into the next digest; the dashboard's Overview covers them.
- **Never empty.** A window with no session started, no tool call, no attention request, no vault access, no blocked request and no open degradation produces no message: the notification is stored and its delivery row is `suppressed` with the reason `empty`, so "why didn't I get a digest?" has an answer. "Send a digest now" (the dashboard, `POST /channels/{id}/digest`) sends even an empty one.
- **Quiet hours.** A digest is sent at the time the operator chose even inside the channel's quiet hours, but **silently** there (`alert: false`: no sound, no vibration). Quiet hours hold back alerts; a digest scheduled into them is still wanted.
- **Content levels.** A report is built at the channel's content level: `counts` carries numbers and fixed labels only; `titles` (the default) adds BrowserHive's own vocabulary (tool names, error codes, harness slugs, vault results, degradation codes, blocklist patterns, session slugs); `full` adds degradation messages and the most blocked domain. Every copied string passes the `Redactor` (spec 10 §9) like any other notification.
- **Structure.** Reports use tables and the additive `chart` block (D-32) and carry the optional `report` field (window, time zone, `late`, skipped windows, `manual`), so the generic webhook's consumers and the delivery log read the window without parsing text.
- With no channel scheduling a report, no timer runs and no query is made.

**Consequences.** Reports cost one scheduler tick a minute while any channel schedules one, a handful of indexed queries per report, and no table. The delivery log shows every report with its window and the late marker. A report addressed to a channel that was paused when it fell due is logged `suppressed: channel_paused` and not re-sent after the resume.

**Alternatives considered.** *Reports in UTC*: testable, but "09:00" would move twice a year and differ from the operator's clock. *One shared digest for every channel*: the window and level differ per channel. *Sending every missed window*: a long weekend would arrive as a burst of stale messages. *Skipping missed windows silently*: data loss with no trace. *Merging missed windows into the next digest*: a 24-hour digest that suddenly covers four days reads as a mistake. *No record of empty digests*: "why didn't I get one?" would have no answer.

## D-44 Anomaly alerts: hourly checks with thresholds and hysteresis, silent unless something crosses

**Status:** Accepted

**Implementation:** N3: `evaluateAnomalies` (pure), the hourly check in `ReportScheduler`, the `anomaly` rule, `--notificationChannel … anomaly=on`.

**Context.** Individual notifications already cover each attention request, crash and degradation. What they miss is a trend: a fleet whose tool calls start failing, a blocklist suddenly hit hundreds of times, a queue of requests nobody answers, sessions pinned at the limit. A check that reports on every tick is ignored within a day; one that flaps around a threshold is worse.

**Decision.**
- A channel opts in with `rules.anomaly` (each check can be tuned or switched off: `null`). Once an hour (at the top of the hour; after downtime one check runs at once, and nothing is reported late), BrowserHive computes the facts of the trailing 60 minutes once and evaluates each channel's checks:

| Check | Fires when (defaults) | Clears when |
|---|---|---|
| `error_rate` | ≥ 20 % of tool calls failed, with at least `min_calls` (20) calls | below half the threshold, or fewer than half the minimum calls |
| `attention` | an attention request has waited ≥ `attention_minutes` (30) | no request waits that long |
| `capacity` | live sessions ≥ `maxSessions` | below 90 % of `maxSessions` (at least one below) |
| `blocked` | blocked requests ≥ `blocked_spike` (3) × the hourly average of the 24 hours before, and ≥ `blocked_min` (50) | below half of both |
| `degraded` | an unresolved error-severity system event exists | none is unresolved |

- **Hysteresis and state.** Each channel's active checks, when each became active and the open alert are kept in `notification_cursors` (`anomaly:<channel_id>`), so a restart neither repeats nor forgets an episode. A check that becomes active is a **crossing**: it produces a new, alerting message that lists every active check (the new ones first) with its value and threshold. A change without a crossing (one of several checks clears) is a silent edit of the open alert. When every check has cleared, the alert is revised to `resolved` with a silent edit ("Back to normal since 15:00"). The resolution stays silent by design (confirmed after the N3 review): good news edits the alert in place and rings nothing, on a platform or in the dashboard. Nothing is sent while nothing crosses.
- **Quiet hours.** No check runs for a channel during its quiet hours; the first check after them reports what is still wrong (held, not lost).
- Severity `warn`, `error` while `degraded` or `capacity` is active; addressed to the channel like any report (D-43), at its content level (the checks' names and numbers are fixed labels, so every level carries them; `full` adds the degradation messages).

**Amended by D-56** (planned, spec 13 §6.3): the `capacity` check compares browsers in use (exclusive sessions plus starting or running template hosts) with the limit, not the session count.

**Consequences.** The check is five indexed counts and one list per hour, shared by every channel. The thresholds are per channel (advanced settings, `anomaly.*` flag parameters). The anomaly alert complements, and does not replace, the per-event notifications.

**Alternatives considered.** *A statistical baseline for every metric*: opaque ("why did this fire?") and noisy on a small fleet; fixed, visible thresholds with one relative check (blocked) are explainable. *A check every minute*: faster, but an hourly window is what makes a rate meaningful on a small fleet. *Re-alerting while a check stays active*: that is the flapping the hysteresis removes.

## D-45 Reports in the dashboard: one in-app copy per period, an in-app schedule, digests never ring

**Status:** Accepted

**Implementation:** N3 (follow-up on the same PR): the in-app copies and the anomaly watches in `ReportScheduler`, `GET /notifications/reports`, `GET /notifications/reports/{notification_id}`, `GET`/`PUT /notifications/report-settings`, the inbox's Reports chip, the Notifications → Reports tab and the report page.

**Context.** D-43 and D-44 addressed every report to a channel and kept its row out of the inbox, pointing at the Overview. In review the owner asked for the reports in BrowserHive itself: someone who reads the dashboard every morning wants the digest there, a history of reports to look back at, and reports without setting up any external channel. Two channels on the same schedule must not put the same digest in the inbox twice, and a daily summary must not behave like an alarm.

**Decision.**
- **One in-app copy per period.** Every report a schedule produces also has an **in-app copy**: an ordinary inbox row (principal `null`, like every produced notification) built at the `full` content level (the dashboard is the operator's own screen; content levels protect the platforms, D-43), in the report's time zone, whose target is its report page (`/notifications/reports/<notification_id>`). Channels that share a **period** share one copy. A digest's period is its schedule identity (`scheduleKey`: frequency, weekday, time, weekdays-only, time zone) plus its window `[since, until)`; two channels with "every day at 09:00, Europe/Berlin" produce the same period and one copy, while 09:00 Berlin and 08:00 London are two periods even when the instants coincide, because the text is written in different zones. The copy's thread is `report:digest:<scheduleKey>:<since>:<until>`: the first schedule to produce the period writes it, the others find it by thread in their own transaction. An on-demand digest ("Send a digest now") is a period of its own (the window that ends at the press, `report:digest:now:<zone>:<since>:<until>`). An empty digest has no in-app copy (nothing to tell; its channel rows still say `suppressed: empty`).
- **Channel copies stay out of the inbox.** A channel's own row (its content level, its window text, its delivery rows) keeps being stored read and dismissed, and names its in-app copy in `source_event_id`, so the Reports tab can say which channels a report reached. Nothing else changes for channels.
- **Anomaly watches.** The in-app anomaly alerts come from **watches**: one per distinct set of effective thresholds among the channels with anomaly alerts, plus the defaults when the in-app switch is on. Each watch is evaluated once an hour with the same facts and hysteresis as D-44 (no quiet hours: the inbox rings nothing that the toast preferences do not allow), and its crossings, silent revisions and "Back to normal" apply to its in-app copy (thread `report:anomaly:<watch key>:<started at>`). Two channels with the same thresholds therefore produce one in-app alert per episode. A channel's own alert names the open alert of its watch. When a watch is no longer wanted (the last channel with those thresholds changed or went), its open alert is closed silently ("No longer checked.").
- **Badge and toasts.** A digest is a record, not a call to act: its in-app copy is stored **already read** (it never counts toward the bell's badge or the Unread filter) and it **never toasts**, whatever the preferences. An anomaly alert is stored unread (it counts toward the badge) and has type `system`, so it follows the existing toast preferences: it toasts, in the warning tone and fading, exactly when the operator's toast types include System (the default); its revisions (superseded, "Back to normal") are silent edits that close its toast.
- **In-app schedule.** The Reports tab's settings (`notification_cursors['settings:in-app-reports']`, server-wide, like the channels) hold a digest schedule (off by default; every day, optionally weekdays only, or every week; a time; a time zone, default the host's) and the anomaly switch (off by default). The same `ReportScheduler` evaluates them as a schedule without a channel (`digest:in-app`), so reports work with no external channel at all, and they share periods with the channels like any other schedule.
- **Finding them.** The inbox gains a **Reports** filter chip (`category=reports`; `type` and `category` together are one facet, a row matching either). The Notifications area gains a **Reports** tab: the full history of in-app copies (a dismissed row leaves the inbox, not the history) until notifications retention prunes it, filtered by kind, by where it went (a channel, or "BrowserHive only": reached no channel) and by period; each opens a report page that renders the message natively (facts, chart, tables) with its window, zone, late and on-demand markers, the channels it reached, and "Open Overview for this period".

**Consequences.** No migration: the copies are notification rows, the links reuse `source_event_id` and `thread`, the settings and watches live in `notification_cursors`. A report reaching three channels is four rows (the in-app copy and one per channel). The anomaly facts are still gathered once per hour, shared by every watch and channel.

**Alternatives considered.** *A new notification type `report`*: the natural chip, but `notifications.type` has a `CHECK` constraint, so it needs a table rebuild for a filter the `category` column already expresses. *Showing each channel's copy in the inbox*: the same digest once per channel, at levels chosen for platforms. *A separate reports table*: a migration for data the notification rows already hold. *Toasting digests*: a summary scheduled at 09:00 would interrupt like an alarm. *Deduplicating by window only*: two zones would share a copy written in only one of them.

## D-46 `/mcp` bounds request bodies, batches and tool-input elements

**Status:** Accepted

**Context.** `/mcp` bypasses the REST middleware stack (03 §2), including its body limit. Up to SDK 1.30.0 nothing bounded an MCP request: an HTTP request of any size, a JSON-RPC batch of any length, or a tool call whose arguments held millions of array elements could exhaust the daemon's memory (GHSA-f897-62hf-6gxq, GHSA-46jr-4wx8-v453). SDK 1.30.1 bounds the bodies its transport reads (4 MiB, `413`) and batch length (100, `400`); 1.32.0 adds an opt-in element cap, `maxToolInputElements`, which runs inside the SDK's own `tools/call` handler. BrowserHive reads the `initialize` body itself (to resolve identity before the transport exists) and replaces `tools/call` with the dispatcher (02 §2.3), so the SDK's limits do not reach either path on their own.

**Decision.**
- `/mcp` request bodies are capped at **4 MiB** (`MCP_MAX_REQUEST_BODY_BYTES`, the SDK default, passed explicitly as `maxRequestBodySize`); the `initialize` body BrowserHive reads itself uses the same bound and the same answer: HTTP `413` with JSON-RPC error `-32000`. Batches over 100 messages get HTTP `400` (SDK).
- A tool call's arguments may hold at most **100,000** array elements and object members, counted at every depth (`MAX_TOOL_INPUT_ELEMENTS`). The dispatcher counts before validating; over the cap the call ends as `INVALID_ARGUMENTS` (`input: arguments contain more than the maximum of 100000 elements`), observed like any other validation failure. The cap is far above any real input (a full browser cookie jar for `set_cookies` is about 30,000).
- Both caps are constants, not configuration.

**Consequences.** Under D-12 these are new failures only for inputs no working agent sends; the error code is an existing one. stdio has no body limit (the client is the parent process), but the element cap applies to both transports because it lives in the dispatcher.

**Alternatives considered.** *Setting `maxToolInputElements` on `McpServer`*: it has no effect, because the dispatcher replaces the SDK's `tools/call` handler. *A configurable cap*: no user has needed one, and a knob invites raising it past what is safe. *The REST stack's 1 MiB default*: MCP clients already rely on the SDK's 4 MiB.

## D-47 Stored tool-call arguments are capped at 64 KiB

**Status:** Accepted

**Context.** D-46 bounds what reaches the dispatcher (a 4 MiB body, 100,000 input elements), not what is recorded. The recorder stored every call's arguments whole in `tool_calls.args_json`, including calls rejected with `INVALID_ARGUMENTS`, so an agent looping on oversized calls could add about 4 MiB of history per call: gigabytes of database, and a session timeline whose detail requests return megabytes. Result text has been capped since D-20 (16 KiB); arguments had no rule. Arguments leave the process only through that column: the `tool.called` feed row, session exports, the `events` log, OTLP span attributes, log lines and notifications carry no arguments (they carry `has_detail`, the tool name, the error code and message).

**Decision.**
- `tool_calls.args_json` holds at most **64 KiB** of serialized UTF-8 JSON (`TOOL_ARGS_CAP_BYTES`). The recorder applies the cap to the arguments as they will be stored: after the capture policy (`full|shape|none`) and after redaction (key heuristics, `Secret` placeholders and the `SecretRegistry` literals, 10 §9). Redaction always runs before the cap, never after, so a cut can neither hide a key that marks a secret nor split a registered literal so that it escapes the scrub.
- Arguments over the cap are stored as a marker object, still valid JSON, so the column stays `TEXT NOT NULL` holding a JSON object and every reader keeps parsing it as before: `{"_truncated": true, "bytes": N, "preview": "…"}`. `bytes` is the UTF-8 size of the full serialization of the redacted arguments; `preview` is the longest prefix of that serialization (never splitting a UTF-16 surrogate pair) for which the whole marker still serializes to at most 64 KiB. A prefix of JSON is not JSON, so `preview` is text to read, not a value to parse.
- The marker is the stored value: `GET …/tool-calls?expand=detail`, `GET /tool-calls?expand=detail` and `GET …/tool-calls/{event_id}` return it unchanged in `args_json`, whose wire type was already any JSON value. The dashboard recognizes the exact shape (`_truncated: true`, numeric `bytes`, string `preview`, no other key) and shows the preview as text with a note giving the full size.
- The cap applies to every call alike, successful or rejected; it is a constant, not configuration (as in D-46).
- `result_text` keeps its D-20 rule (16 KiB, redacted first, cut on a code point and ended with `…[truncated]`; `result_size_bytes` keeps the full size). It is free text, so a text marker is enough; no change.
- Rows written before this decision are not rewritten (no migration); retention removes them.

**Consequences.** One recorded call costs at most about 80 KiB of text (64 KiB of arguments, 16 KiB of result), about 50 times less than a 4 MiB call. Real arguments (URLs, selectors, typed text, `evaluate` scripts, attention messages) are far below 64 KiB and are stored whole. An agent can send a small object of the marker's exact shape, and the dashboard will show it as truncated; that only misrepresents the agent's own input to the operator who is auditing it, which is acceptable.

**Alternatives considered.** *Storing the cut serialization as is*: not valid JSON, so every reader of `args_json` (which parses an object) would fail on it. *Shortening values inside the structure* (long strings, long arrays): keeps the shape but cannot say clearly what was removed, and a value-by-value walk over 100,000 elements costs more than one cut. *Storing `{}`*: loses everything the operator needs to see what the agent tried. *A new `args_truncated` column*: needs a migration for information the marker already carries. *16 KiB like results*: arguments are the agent's intent and are small in practice; 16 KiB would cut long `evaluate` scripts, the arguments most worth reading in full.

## D-48 Vault rules may name harnesses: a narrowing guard, not a security boundary

**Status:** Accepted

**Context.** Operators run several agents against one daemon (D-30) and want to say "only my coding agents may use the deploy credentials" or "never let an unidentified client fill anything from the *Banking* folder". Vault access is decided by caller principal and session slug (D-14). That is enough when each agent has its own token and naming scheme, but most setups share one principal (`local` with `--auth off`) and slugs are chosen by the agent. The harness is the one thing the operator already sees per session, but it is self-reported (D-30): any client can claim any name. A rule on it cannot stop a hostile client; it can stop the wrong agent from using the wrong credentials by mistake.

**Decision.**
- **Where.** Vault bindings and vault group policies gain an optional `harnesses` list (`vault_bindings.harnesses_json`, `vault_group_policies.harnesses_json`). No list (`NULL`, the API omits the field, the dashboard says "All harnesses") keeps today's behaviour. A list allows only the harnesses it names. An **empty list allows nothing**: it is kept as written, and the editor shows a warning that nothing can fill the entry until a harness is added or "All harnesses" is chosen.
- **A narrowing guard.** The harness check runs after the principal and slug checks (gate order principal → slug → harness, spec 02 §3.13). It only ever removes access the other rules give, and never grants any. It is not a security boundary: a client can declare any harness. Real enforcement is one API token per agent with `authorized_principals` (D-09, D-14). The dashboard and the docs say so in one short line.
- **Values.** Each entry is either a known slug of `contracts/harness` (`HARNESS_SLUGS`, including `unknown` and `other`), matched against the session's launch slug, or a **custom name**, matched exactly and case-sensitively against the session's launch *declared* name. An entry is 1 to 64 characters after trimming, with no control characters; a list holds at most 32 entries and is deduplicated in order. A malformed list is `400 VALIDATION_FAILED` with a field-level issue (no new error code). A custom name that normalises to a known slug (`Claude-Code`) is stored as written and matched exactly; the editor suggests the built-in harness.
- **The declared name.** The raw value of the winning harness signal when its source is a declared one (`env`, `header`, `url`, `meta`: steps 1, 3 and 4 of spec 02 §1.4), trimmed and capped like every declared value (200 characters); `NULL` when the harness came from `injected_env`, `client_info`, `user_agent` or nothing. `mcp_connections.harness_declared` holds the latest resolution; `sessions.harness_declared` is written once at launch, next to `sessions.harness`.
- **Which harness a fill uses.** The session's launch harness and declared name, never the per-call identity, so a client cannot rename itself mid-session to pass a rule. A session without a launch harness (created before schema v3) reads `unknown`; a session without a declared name (created before schema v7, or identified another way) never matches a custom name, only `unknown` or a known slug.
- **Binding and group combine.** A fill or a listing needs every list that applies to allow the session: the binding's own list (manual bindings) and the list of the policy of the entry's group (the `__ungrouped__` policy for ungrouped items), whatever the group's access mode. A folder's list therefore restricts every binding in it, as `reject_all` already does. The group's principal and slug rule still applies only to `allow_all` items, as before.
- **What the agent sees.** Exactly what any other authorization refusal gives: `vault_fill` returns `{status: 'blocked', redacted: true, reason: 'not_authorized'}` (the text an unknown handle and a principal or slug refusal give, classified `VAULT_FILL_BLOCKED`), with no extra work before it, and `vault_list_available` leaves the entry out. No response, hint or note mentions harnesses (D-14: the agent learns only entry names, allowed origins and fill outcomes).
- **What the operator sees.** The fill's single audit row (D-14) carries the real reason, `harness_not_allowed`, with `details {harness, harness_declared, rule: 'binding'|'group'}`; it shows in the Vault log and the fill's detail. The dashboard binding and group-policy editors have a Harnesses field: chips for the known harnesses and **Unknown**, "All harnesses" as the default, **+ Add custom name** marked case-sensitive, the one-line note, and four warnings: an empty list, a custom name that normalises to a known slug, a list that would refuse every session launched in the last 30 days, and a list used while every recent session shares one principal (suggest per-agent tokens). `GET /vault/harnesses` feeds the picker and the warnings with the harnesses and declared names seen on this daemon in the last 30 days and the number of distinct principals that launched them.
- **API and export.** `harnesses` is an optional field of `VaultBinding`, `VaultGroupPolicy` and their export forms (absent means all harnesses); `PUT` bodies accept `harnesses: string[] | null` (`null` clears the list, absent keeps it). Optimistic concurrency (`version`, `If-Match`) and the version-3 export document are unchanged; the field round-trips through export and import, and an older document imports as "all harnesses".
- **The tester agrees with the broker.** The dashboard tester (`POST /vault/bindings/resolve`) takes an optional harness (a slug, `unknown` included) and declared name; a declared name alone is normalised into its slug, as a declared signal would be. Given one, it runs the broker's own check (`checkHarnessRules` over the same binding + group lists, after principal and slug) and reports a refusal as `harness_not_allowed` with the rule that refused. Without one it checks no list and names the bindings whose rules carry one, so a "would fill" never silently ignores a list. This output is operator-only (`vault:read`); nothing changes for agents.
- **Vocabulary for the pickers.** The known-slug table grows to the harnesses with evidence of the exact `clientInfo.name` they send (source code or a recent wire capture, recorded per row as verified live or from source in `docs/guide/mcp-clients.md`): Amp, Kiro, Amazon Q Developer CLI, Warp, Qwen Code, Factory Droid, Augment, Antigravity, Grok CLI, Kimi Code, ChatGPT, Letta Code, Cherry Studio, LibreChat, Jan and MCP Inspector, plus current names of existing ones (`kilo`, `windsurf-client`, `junie-client`, `lmstudio-mcp-server-session`, `openai-mcp (Codex)`, `Visual-Studio-Code`, `@cline/…`); `cli`, `rmcp` and `acp` join the generic SDK names. No injected environment variable is added: the candidates (`KILO`, `COPILOT_AGENT_SESSION_ID`) also reach shells and nested agents, and an injected variable outranks `clientInfo`. Harnesses with no distinctive name (Visual Studio, Mistral Vibe, OpenHands, Kimi CLI) stay `unknown` until they send one. The picker also offers every harness and declared name seen on this daemon.
- **Room for a verified harness.** List entries stay plain strings. A later "verified harness only" option is a separate column checked against `harness_source = 'token'` (D-30); nothing here has to change for it.
- **Out of scope.** A verified harness and a "verified only" rule; harness restrictions anywhere outside the vault (tools, sessions, notifications), except session templates (**amended by D-52**, planned, spec 13 §6.1: a template's grant may carry a harness list with exactly these semantics).

**Consequences.** Schema v7 (`0007-vault-harnesses`, `compatible: true`) adds the four nullable columns and backfills nothing: every existing rule keeps meaning "all harnesses" and every existing session has no declared name. A binary older than v7 can still read the database and ignores the lists; since they only narrow, such a downgrade can only widen access back to what the principal and slug rules allow, which is acceptable for a guard that is not a boundary. The harness vocabulary in `contracts/harness` now feeds a decision, so additions to it are reviewed like any other vault change; the alias tables still only identify, they never widen a rule.

**Alternatives considered.** *Treating an empty list as "all"*: an operator who unticks the last harness expects nothing to pass; silently allowing everything is the dangerous reading. *Matching custom names case-insensitively, or through `normalizeHarness`*: a custom name exists precisely for values the slug table does not know, and folding would make `Claude-Code` the built-in Claude Code behind the operator's back; exact matching plus a warning is predictable. *Using the per-call harness*: a client could switch its header between calls to pass a rule. *A distinct agent-facing reason (`harness_not_allowed`)*: tells a misbehaving agent which name to claim. *Applying the group list only to `allow_all` items*: a "Deploy folder for OpenCode and Claude Code" would then not cover the folder's manual bindings, which is what operators mean. *A new error code*: refusals are returned statuses (10 §1.4) and malformed lists are ordinary validation failures.

## D-49 Session templates are their own object

**Status:** Accepted

**Implementation:** planned: PRs T1a and T1b of spec 13 §17 (schema v8, `0008-templates`).

**Context.** With the vault, every agent signs in by itself: ten parallel agents on one site are ten sign-ins, slow and suspicious to the site. The owner asked for "templated sessions": an operator signs in once to several sites, saves the result, and agents launch sessions from it by name. Saved auth states (`auth-states/`, 02 §6) are per-principal snapshots with no policy, versions, health or encryption. The reserved "profile blueprints" of D-25 are a persistence mode, and `persistence_mode` is a frozen enum with a CHECK constraint (D-12, 03 §7). A template also has to pin a whole identity, because a site that sees a new device on every launch signs the account out.

**Decision.**
- A **session template** is a first-class object: an id-keyed directory `<data-dir>/templates/<tp-id>/` (the live profile, the encrypted rolling checkpoint and versions, the host's downloads) plus rows in `templates`, `template_sites`, `template_versions` and `template_probes` (spec 13 §2). Identifiers are `tp-<nanoid10>`; agents address a template by its unique `name` (the slug grammar).
- The identity is **pinned**: seed, locale, languages, timezone, operator-given geolocation and the proxy (server and an environment variable *name* for its password, D-33) are fixed at creation; Chrome major, client hints, screen and window are recorded at the first host start (`identity_observed`), never faked (D-26), and a later drift is reported, not hidden. Launches are refused rather than sent from the host's IP when the pinned proxy is unreachable.
- **Checkpoints and versions are different things**: one rolling encrypted checkpoint is overwritten on an interval; numbered versions are written only at milestones (recording, re-login, restore, manual, import, a sign-in change, daily) with the per-site health they were taken in, and retention always keeps the newest version in which every site was signed in. Rolling cookies therefore never push useful versions out.
- A template is **not** a persistence mode: `persistence=blueprint` and the key `profiles` stay reserved, and a template session reports `persistence_mode: 'memory'`.
- Sessions record their template in nullable columns (`sessions.template_id`, `template_name`, `template_version`, `template_mode`, `sealed`; migration `0008-templates`, `compatible: true`).

**Consequences.** D-24's layout gains `templates/` and `site-packs/`; D-25's "profile blueprints" item is realised by templates for the signed-in-identity use case. Spec 11 §6's reserved "profile ↔ fingerprint ↔ proxy pinning" is built here. Templates can be seeded from a storage-state file where nobody can sign in inside the host (a headless server, a site that refuses automation-controlled browsers).

**Alternatives considered.** *Extending auth states with a third kind*: `list_saved_auths` pins its `kind` enum and its flat namespace had an overwrite bug (fixed separately, spec 13 T0a). *Building the D-25 blueprint persistence mode*: a fourth `persistence_mode` value needs a `sessions` table rebuild and breaks D-12, and a persistence mode cannot carry policy, health or versions. *Every changed checkpoint as a version*: rolling cookies would turn ten kept versions into about 2.5 hours of history. *Pinning only the seed*: geo and proxy drift are the logout triggers vendors name first.

## D-50 Live mode: one shared browser per template, one window per session

**Status:** Accepted

**Implementation:** planned: PR T0c (the `BrowserHost`/`SessionView` split, no behaviour change) and PR T1a of spec 13 §17.

**Context.** Two ways exist to run ten sessions from one sign-in. *Fork mode* gives each session its own browser seeded from a copy of the cookie jar: Google supersedes a copied snapshot within about 10 minutes, refresh-token rotation with reuse detection revokes the whole token family (RFC 9700 §4.14.2), device-bound session credentials (DBSC) cannot be copied at all, and antidetect vendors therefore run one profile on one device at a time. *Shared mode* runs one browser per identity with a window per task, which is what a person does. Measured on Playwright and Patchright 1.63 with headed Chromium: `Target.createTarget({newWindow: true, browserContextId})` opens a window Playwright adopts; focus emulation keeps pages visible and focused in background tabs and unfocused windows; ten sessions in one browser take about 1.3 GB against 2.3 GB as ten browsers. The cost is the session model itself: D-21, spec 11 §2.2 and the driver port say one session is one browser and one context.

**Decision.**
- **Live mode is the only concurrent template mode.** A template has at most one **host**: a persistent context on its `userdata/`, headed by default (headless allowed per template, with a warning, and refused for sites whose pack requires headed), with a **sentinel window** that keeps the browser alive without sessions. Serial checkout is deferred; N concurrent copies of one jar are never built.
- A **virtual session** is an ordinary session row whose browser is the host: it owns one or more windows, created **in the background** and never activated by BrowserHive, and `close_session` closes only its pages. **Amends D-21 and spec 11 §2.2**: "one session = one browser + one context" holds for *exclusive* sessions; a host's browser and context are shared by its virtual sessions only, and two templates never share a browser.
- **Page attribution is the isolation boundary**, decided in this order before any session sees a page: a claim by target id, then the opener (`TargetInfo.openerId`, with tombstones for closed openers), else the page is parked. The window a page appears in is never used: a tab the operator opens by hand, even in an agent's window, is parked. An attribution never changes and no page is in two sessions (spec 13 §3.4). The driver port splits `SessionHandle` into `BrowserHost` and `SessionView` in a PR of its own, with property tests of the invariant, before any template code depends on it.
- The host is the **single writer**: only it opens `userdata/`; a recycle drains its sessions before the browser restarts; there is no overlap.
- A host crash fans out to every session of the template (`SESSION_DEAD`); the supervisor restarts it with backoff and marks it `failed` after 5 consecutive failures in 30 minutes. A browser the operator quits by hand is an operator stop, not a crash.
- Hosts follow the sandbox policy (D-27) and record `sandboxed` and `browser_version` on each virtual session (D-31); Chrome's password manager, autofill, browser sign-in and page restore are turned off in the host profile.

**Consequences.** Live mode loses per-session context settings (user agent, locale, timezone, permissions, proxy, routes, HTTP cache, clock, downloads directory: spec 13 §4) and per-session tracing (D-51); agents can observe shared storage, sibling sign-outs and the shared crash (spec 13 §5.6). A host is always routed, so it has no HTTP cache. A headed host needs a display, decided by trying the launch; on servers that is Xvfb with access control, and recording there needs VNC or a seeded state. The interception chain resolves the owner of each request instead of a fixed session id.

**Alternatives considered.** *Fork mode as the concurrent mode*: the failure modes above. *Tabs in one shared window, or tab groups*: background tabs run `requestAnimationFrame` at about 15 fps, and tab groups exist only through an extension API that is itself a fingerprint. *One window per agent tab*: a session with five tabs becomes five windows on the operator's desktop. *Attributing by window*: Chromium places site-opened tabs and the operator's own tabs in whichever window was active last, so the window says nothing about who opened a page. *`bringToFront()` on `switch_tab` in headed hosts*: it raises the window and un-minimizes it, stealing the operator's focus.

## D-51 Template sessions are sealed by default; tracing is off for virtual sessions

**Status:** Accepted

**Implementation:** planned: PR T1a of spec 13 §17.

**Context.** A template is a bearer credential: its cookies bypass the password and MFA of every site in it. Every hosted product surveyed hands the agent full cookie access; the agent here is untrusted (D-09), and a prompt-injected page could ask it to export the sign-in. In live mode one jar serves every session. A Playwright tracer is per context: a host trace would record every agent, and the vault's stop/start of the trace around a fill (D-13) would cut sibling traces.

**Decision.**
- **Sealing keeps the raw session material out of agent results; it does not stop an agent from acting as the account.** Template sessions are sealed unless the operator unseals the template: `get_cookies` returns only the template's sites' cookies with empty `value`s and the additive `sealed: true`; `disable_evaluate` is forced on (`EVALUATE_DISABLED`, `scope: 'session'`); `set_cookies` and `save_storage_state` answer the new `SESSION_SEALED`; `save_full_profile` answers `INVALID_PERSISTENCE_CONFIG`; cookie values of the jar are replaced with `[sealed]` in every agent-facing text result and in `tool_calls`. Four unseal flags (`cookie_values`, `evaluate`, `cookie_writes`, `state_export`) relax one behaviour each, optionally for listed principals only; they are set by an operator and audited, and the editor states that `evaluate` and `state_export` unseal everything.
- Sealing covers tool-initiated reads by agents whose only access is the MCP interface. It relies on D-57 (no `javascript:` or `file:` navigation) and says plainly that an agent able to run code as BrowserHive's OS user is out of its scope.
- Agent `vault_fill` is refused in template sessions: a fill would sign the shared jar in for every principal the template allows.
- **Agent-facing text describes capabilities, never the mechanism** (owner decision 2026-11-08): the session starts signed in to the template's sites; signing out or changing account, security or privacy settings is not allowed and may be blocked or need approval; sign-ins and site data it changes are kept in the template and carried into later sessions; cookie values are hidden and `evaluate` and saving the login are unavailable unless allowed. No agent-visible string or result explains the shared browser or reveals other agents or sessions: no session counts, no `mode`, no host state, capacity errors such as "This template is at capacity".
- **Tracing is off for virtual sessions in v1** (`trace.enabled: false`, `TRACE_UNAVAILABLE`). This narrows D-13's scope: D-13's guarantee holds trivially because there is no trace; a per-page trace split is deferred.

**Consequences.** A sealed refusal tells an agent its session comes from a template; it does not tell it the mechanism. Agents that depend on `evaluate` need the operator's "Allow evaluate". Credential-minting flows are stopped by `credential` guards (D-54), not by sealing. Cookie values still never reach the database (D-20).

**Alternatives considered.** *Unsealed by default, like other products*: the login would be one tool call away from leaving the machine. *Refusing `get_cookies` outright*: agents legitimately check whether a cookie exists. *Allowing agent fills when the binding's principals cover the template's*: two rule sets would have to stay aligned forever; re-login is the operator's. *Reference-counted trace pauses on a shared tracer*: still records every agent into one file.

## D-52 Template access: operators manage, agents list and launch, grants by principal and harness

**Status:** Accepted

**Implementation:** planned: PR T1a of spec 13 §17 (reserved subjects in PR T0f).

**Context.** Several agents share one daemon (D-30). An operator wants "only my job-hunting agent may use the LinkedIn template". The vault already has the shapes for this: an `AuthorizationRule` over principals and D-48's harness lists. D-30 and D-48 restrict the use of the self-reported harness to the vault.

**Decision.**
- Operators create, edit, record, re-login, restore and delete templates, under the new scopes `templates:read`, `templates:write` and `templates:login` (the last for anything that drives a signed-in window or watches one; linking a vault binding also needs `vault:write`); site packs use `sitepacks:read` and `sitepacks:write`. Agents hold `mcp:tools` only and can only list and launch; no tool changes a template; no launch/edit/manage roles exist in v1.
- A template's grant is `authorized_principals` (empty = any) plus an optional `harnesses` list with D-48's exact semantics, checked principal → harness with `isHarnessAllowed`. **Amends D-30 and D-48**: harness lists may also narrow who can list and launch a template, with the same wording everywhere: a narrowing guard, not a security boundary.
- A refusal is indistinguishable from absence (`TEMPLATE_NOT_FOUND`, and the template is left out of `list_templates`); the operator sees the reason in the access tester and the log.
- **Default access**: any principal and all harnesses under `auth=off` (one principal anyway); under `auth=token` an explicit choice is required, because "any" would make the new credential usable by every token at once.
- **System principals.** Maintenance sessions are identified by `template_mode`, never by slug, and are refused to every agent principal; the subjects `local`, `browserhive` and `system` and the prefix `template:` are reserved (amends D-09). Vault auto-relogin acts as `template:<template_id>`, which the binding must list.

**Consequences.** The harness vocabulary in `contracts/harness` now feeds two decisions. Slug globs are not part of a template grant in v1 (a slug is chosen at launch, after listing).

**Alternatives considered.** *Launch/edit/manage roles*: no second operator exists yet (D-09 builds one operator). *A new harness rule format for templates*: two matchers would drift. *Distinct agent-facing refusals*: would tell a misbehaving agent which principal or harness to claim (D-48). *"Any principal" as the default everywhere*: simpler, but a silent widening under `auth=token`.

## D-53 Template state at rest: encrypted checkpoints and versions, the live profile protected by modes, honestly documented

**Status:** Accepted

**Implementation:** planned: PR T1b of spec 13 §17.

**Context.** Nothing in BrowserHive is encrypted today; saved profile zips are effectively plaintext because Chromium under Playwright encrypts cookies with a published constant key on Linux and a mocked keychain on macOS (DPAPI per user on Windows), and their protection is file mode 0600. Templates will be backed up and copied around. Encryption with nowhere safe for the key is theatre, and a key the operator can lose turns a recoverable situation into data loss.

**Decision.**
- Every template checkpoint and version is an AES-256-GCM envelope (`BHTE`, format 1, key id, random 12-byte nonce, ciphertext, tag) whose additional data covers the header and binds it to its template and slot (spec 13 §2.4). Files are written atomically; plaintext state exists only in memory.
- The key is `templateKey` (a secret config key, base64 of 32 bytes, from the environment) or, by default, `<data-dir>/admin/template.key` (0600 in a 0700 directory), created exclusively and only when no encrypted file exists. A missing key with existing files is reported (`TEMPLATE_KEY_MISSING`) and never re-created; checkpoints pause and hosts keep running. Rotation is `browserhive templates rekey`, with `templateKeyPrevious` for reading old files meanwhile.
- The **live profile is not encrypted**: it is the browser's working directory, protected by 0700/0600. The docs state per platform what is protected (copies of version files without the key) and what is not (the live profile, downloads, exported auth states, a host where an attacker reads the data directory, a running process, an agent running as BrowserHive's OS user).
- A file written with another key is reported (`TEMPLATE_KEY_MISMATCH`), never crashed on. Saved auth states stay unencrypted in this program.

**Consequences.** Backing up a template means copying its directory and its key together. `doctor` checks the key and its mode. An OS-keychain or passphrase key provider can be added behind `TemplateKeyProvider` later.

**Alternatives considered.** *OS keychain by default*: breaks headless servers and containers. *A passphrase prompted at start*: an unattended restart could not use templates. *No encryption in v1*: versions are exactly the files that get copied into backups. *Re-creating a missing key file*: every existing file would become unreadable without a word.

## D-54 Site packs are signed data that select from a closed strategy set compiled into the binary

**Status:** Accepted

**Implementation:** planned: PR T0b (the interception chain and request guard), PRs T3a and T3b (local packs, guards, challenges, strategies, classification, schema v9) and PRs T4a and T4b (the registry) of spec 13 §17.

**Context.** Each site detects automation, parallel logins, session sharing and tracking differently, signs accounts out through its own URLs (including `POST` forms and `fetch` calls the blocklist cannot match), challenges through its own pages and providers, and tolerates its own pace. The owner wants per-site optimisation so templated sessions behave like a human and withstand each site's detection, with per-site stealth and behaviour strategies picked from strategies compiled into the binary. Updating code remotely would be remote code execution in a process that holds the vault and signed-in browsers; Firefox's password-manager site recipes show signed per-site *data* with a packaged copy has worked for about ten years.

**Decision.**
- A **site pack** is strict, versioned, declarative data about one registrable domain (spec 13 §9.2): sign-in, signed-in detection by cookie *names*, probe, logins shared with other sites, human-only sign-in, method-aware request guards and element guards (kinds `logout`, `account`, `credential`, `destructive`, `write`), challenges, concurrency and pacing labelled official or vendor with a source, browser and headedness, device binding, consistency, the terms clause, stance and write policy, and **behaviour and stealth strategies chosen from a closed set compiled into the binary** (pacing, spacing, ramp-up, serialisation, dwell, humanized input, warm-up with referrer, keep-alive, active hours, device-bound detection; a stealth floor, single focus per site, a WebRTC IP policy). A pack never carries code, regular expressions, launch arguments, proxies, vault rules or any value BrowserHive sends anywhere.
- Ports `SitePackSource` and `SiteStrategy`, and `SitePackRegistry` modelled on the blocklist's atomic hot reload (D-22). **No pack version applies until an operator approves it** (owner decision 2026-11-08): adding a site to a template approves the version shown with its provenance; bundled versions shipped by a later release wait as pending updates; registry versions are applied by the operator (D-55); unsigned local files need no signature but an operator's approval once per content hash, and a changed file waits again while the approved content keeps applying. Precedence: approved local content > the approved version from another source > nothing. Matching by eTLD+1; a domain belongs to one pack.
- Enforcement: the request guard (handler 3 of the host's `InterceptionChain`, method- and resource-type-aware; **amends D-22**: the blocklist file and grammar are unchanged) is the boundary; element guards at the tool layer are an early refusal. A write `confirm` is a `security_intercept` with the attention deadline (D-15); challenges count only visible challenge surfaces, never invisible provider badges, and nothing an agent navigates to itself changes health. Under `stdio`, `confirm` blocks.
- The binary enforces what makes malicious data harmless: URLs are paths inside the pack's own domains; patterns use spec 11's glob grammar; selectors are standard CSS with an allow-listed set of pseudo-classes and are only ever queried; every number has a floor and a ceiling; every change is classified by a **default-deny** classifier as tightening, neutral, restrictive (tightening that can stop a site) or loosening, shown to the operator with the diff; only auto-update acts on it, and even then loosening and restrictive changes and new or removed domains wait; a revocation never applies a looser fallback without approval.
- Packs apply to template sessions only in this program. **Amends D-25**: the security-intercept rule engine and the extensions registry gain their first concrete client. **Amends D-15**: `security_intercept` is built (schema v9).

**Consequences.** Migration v9 rebuilds `operator_requests` for the new kind and is the first migration that is not backward compatible (`min_reader_version` 9), **accepted by the owner 2026-11-08**; the T3a release notes and `docs/guide/upgrading.md` say that going back needs the pre-upgrade backup; migrations freeze their enum literals. Every shipped pack field is verified against a live signed-in session first. Terms clauses are data the operator uses to set a write policy; a pack's default follows its stance (prohibited or writes-restricted → confirm). What the chain cannot see (redirect hops, WebSocket frames) is documented.

**Alternatives considered.** *Code plugins or remote scripts*: remote code execution with vault access. *Regular expressions in packs*: ReDoS surface. *Only guards, no strategies*: the owner's purpose includes behaving like a person on each site. *Per-page canvas and audio noise switches*: one device would behave two ways inside one host; packs set a template-level floor instead.

## D-55 Site-pack registry: signed static files, check on, apply after approval, auto-update off

**Status:** Accepted

**Implementation:** planned: PRs T4a and T4b of spec 13 §17.

**Context.** Packs go stale faster than releases, so installs that do not upgrade need fresh site knowledge. D-08 says nothing leaves the host by default; D-33 says BrowserHive runs no server. The owner's decision of 2026-11-05: browserhive.ai or a CDN hosts a static, signed registry; BrowserHive downloads configuration from it and sends no instance data; the bundled snapshot and the update check are on by default; applying an update needs the operator's approval by default, with what changed shown; auto-update is off by default; the check can be turned off; packs can be downloaded by hand into a folder or imported from a file.

**Decision.**
- **Amends D-08**: by default BrowserHive makes exactly one kind of outbound request: an anonymous `GET` of BrowserHive's public, signed site-pack **index** (`keys.json`, `index.json` and their signatures) at `sitePacksUrl` (default `https://browserhive.ai/registry/v1/`), every 24 h ± 2 h, whether or not a template exists (owner decision 2026-11-08). It carries no cookie, query, body, version, install identifier or echoed tracking ETag (only the hash of the body it holds) and is the same for every install. Pack files are fetched only when the operator downloads one (which reveals that version to the registry; **Download all** avoids it) or auto-update does.
- **D-33 stands**: the registry is static files on the project's website, not a server BrowserHive runs.
- Trust: Ed25519 (TUF-lite): two offline root keys pinned in the binary sign `keys.json` (expiry ≤ 120 days), which names a short-lived CI key (`not_after` ≤ 90 days, checked against the clock) that signs `index.json` (monotonic `version`, `expires` ≤ 14 days, re-signed weekly); pack files are content-addressed and trusted through the index; rollback, freeze and fast-forward are refused; an expired index keeps the last good one and reports `SITE_PACKS_STALE`. Signing runs in an approval-gated GitHub environment limited to `main`, in a job that installs no dependencies and re-verifies the artefact, separate from the deploy token.
- Policy (owner decision 2026-11-08): `sitePacksUpdateCheck=true`, `sitePacksAutoUpdate=false`. The index lists each version with its size, hash, date and signed notes; the operator chooses per pack **Download & review** (fetch, verify, classify, exact diff), **Apply** (the previous approved version is kept for **Revert**), **Reject** or **Pin**, in the dashboard, the CLI and from a notification. A per-pack **Follow updates** setting (automatic: followed while a template uses the pack) limits pending updates and notifications to the packs the operator cares about. With auto-update on, followed packs' tightening and neutral registry changes are downloaded and applied by themselves; loosening and restrictive changes, domain changes, bundled versions and local files still wait. `sitePacksUpdateCheck=false`, `browserhive sitepacks import|export` and a local packs folder (signed layouts verified like imports; unsigned files approved once per content hash, D-54) cover air-gapped and opted-out hosts.
- Each npm release bundles a verified snapshot under `dist/site-packs/`, so an install never starts empty and works offline.

**Consequences.** browserhive.ai's deploy gains the registry files and their cache headers. The owner holds the root keys and approves each signing run; a missed weekly re-sign makes installs report stale data after 14 days without breaking anything. `doctor`, the wizard and the security guide disclose the request. A compromised online key can withhold updates and, only with auto-update on, apply tightening changes to followed packs; it can never loosen a pack without approval.

**Alternatives considered.** *Opt-in only*: installs that never upgrade would keep the shipped knowledge forever, which the owner rejected. *Release-only updates*: the same. *Auto-apply by default*: a bad limit could get accounts banned on every install at once. *Full TUF or Sigstore verification in the client*: heavier than one publisher needs; a build attestation is published in addition.

## D-56 Capacity: a template host is one browser slot; virtual sessions count as sessions

**Status:** Accepted

**Implementation:** planned: PR T1a of spec 13 §17.

**Context.** D-21 budgets 1.5 GiB of host RAM per session because each session is a browser. A virtual session costs one page (about 80–100 MB) in an existing browser, so counting it as a slot would refuse launches the host can afford, and not counting it at all would hide it from `server_status`.

**Decision.**
- `maxSessions` bounds **browsers**: each exclusive session and each starting or running host takes one slot, counted under the registry lock. **Amends D-21's admission rule** accordingly; the derived default is unchanged.
- Operator surfaces count virtual sessions as sessions (`/system.capacity.live`, `browserhive.sessions.active` with `mode`) and add `/system.capacity.browsers`, which the limit bounds and the capacity bar and the D-44 `capacity` check use. The agent-visible `server_status.sessions.count` is defined as that browser count, so it never exceeds `limit` and never reveals template sessions (D-51). Maintenance sessions are counted nowhere but the `mode` metric attribute.
- Per template, at most `max_concurrent` agent virtual sessions (default 5, 1–20), further bounded by the sites' packs; agent pages at most `templateMaxPagesPerHost` per host (default 40) and `max(2, floor(templateMaxPagesPerHost / cap))` per session; parked pages are not counted. Over a template limit: `TEMPLATE_BUSY`; no slot for a host start: `SESSION_LIMIT_REACHED`.
- Template admission is its own asynchronous step within a 50 s launch budget (below common MCP client timeouts), not a decoration of the synchronous slot policy.

**Consequences.** `server_status.sessions.count` means browser slots in use, which equals the session count on a server without templates. A host can grow to `templateRecycleRss` (3 GiB, two slots' worth of D-21's budget) before a memory recycle, which first trims the largest session; `doctor` counts recently used templates at that size.

**Alternatives considered.** *Weighted admission (a virtual session = a fraction of a slot)*: harder to explain than "a host is a browser". *Counting virtual sessions as slots*: wastes the memory advantage that motivates live mode. *Page caps per host only*: one session could take every page from its siblings.

## D-57 Agent-requested URLs are limited to web schemes

**Status:** Accepted

**Implementation:** planned: PR T0d of spec 13 §17 (every session; shippable before the rest of spec 13).

**Context.** `navigate` and `new_tab` pass any string to `page.goto`, and the blocklist ignores every scheme but `http(s)`, `ws(s)` and `ftp(s)` (11 §5). A `Page.navigate` from CDP is browser-initiated, so Chromium honours schemes a web page could never open: `file://` reads any file BrowserHive's user can read (the data directory, `admin/credentials.txt`, other profiles) and shows directory listings; `chrome://` pages expose history, saved passwords, downloads and settings that change the whole profile; `view-source:file://` does the same as `file://`; `javascript:` runs agent-written script in the page (measured: the cookie reaches the DOM though `goto` reports `ERR_ABORTED`), which defeats `disable_evaluate` and `allowEvaluate=false`; external protocol schemes (`mailto:`, app schemes) launch applications on the host.

**Decision.**
- `navigate` and `new_tab(url)` accept only `http:`, `https:` and exactly `about:blank`, plus `data:` in exclusive sessions (refused in virtual sessions); the URL is parsed with WHATWG `URL`, the scheme compared lowercased, and the browser is given the normalized `href`. Anything else, unparseable or scheme-less input included, answers the new `URL_SCHEME_NOT_ALLOWED` (`400`, `different_args`, details `{scheme}`) before the browser is touched; the check runs before the blocklist.
- Backstop: a page whose main frame commits a URL outside `http:`, `https:`, `about:blank`/`about:srcdoc`, `blob:`, `chrome-error:` (and `data:` in exclusive sessions) is closed and its tab removed.
- Site-initiated `blob:` and `data:` navigations and downloads are unaffected; history tools need no check.
- **Why a new code rather than `URL_BLOCKED`**: `URL_BLOCKED`'s frozen public message and resolution attribute the refusal to the operator's blocklist pattern and say "do not retry, do not try another route", and its details would carry the raw `javascript:`/`data:` payload into the message. A scheme refusal is a fixed product rule no operator configures, and the right agent behaviour is to retry with an `http(s)` URL (`different_args`).
- **Amends D-12**: refusing these inputs is a contract rule enforced regardless of history, like `allowEvaluate=false`; descriptions and the error list of both tools change additively. **Amends D-22**: the scheme check precedes the blocklist, whose fail-open handling of other schemes now only ever sees web schemes from agents.

**Consequences.** Agents that navigated to `file://` or `chrome://` pages lose that ability; `data:` stays available in exclusive sessions (the existing integration tests use it). A `data:` page runs script in an opaque origin, which is no more than an agent-chosen `https:` page can do.

**Alternatives considered.** *Applying the rule only when `disable_evaluate` is on*: `file://` and `chrome://` are dangerous in every session. *Refusing `data:` everywhere*: breaks agents and tests for no gain over `https:`. *Relying on the blocklist*: it is operator configuration, fail-open by design, and blind to non-network schemes.

## D-58 A vault fill writes the password only into a password input

**Status:** Accepted

**Implementation:** planned: PR T0e of spec 13 §17 (every session; shippable before the rest of spec 13).

**Context.** `vault_fill` takes agent-chosen selectors. The broker checks the page's origin and the form's `action` (D-14), not what the password selector names, so an agent can direct the password into a visible text field or a search box and read it back with `snapshot` or `screenshot`, defeating "the model never sees the credential".

**Decision.**
- Before fetching the credential and again immediately before entering it, the broker requires the password selector to match exactly one enabled, writable `<input type="password">`, and the username selector exactly one `<input>` whose type is not `password`, `hidden`, `file`, `checkbox`, `radio`, `submit`, `button`, `image` or `reset`. Otherwise the fill returns `blocked` with `reason: 'password_target_invalid'` and its `vault_access` row records that reason; nothing is fetched.
- **Amends D-14**: this check joins the fill's fixed gates after the origin gate. A template session refuses agent fills altogether (D-51), and vault auto-relogin into a template host runs every gate as the principal `template:<template_id>` (spec 13 §8.4).

**Consequences.** Sites whose password field is not an `input[type=password]` cannot be filled. A site's own "show password" control can still reveal a filled password; `redact_username` and `require_no_evaluate` remain the per-entry hardening, and the vault guide says so.

**Alternatives considered.** *Clearing the field after a short delay*: the agent can read it in between. *Checking only the first fill*: a page can swap the element between check and fill.
