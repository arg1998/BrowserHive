---
title: "Testing"
spec: "09"
status: Normative
scope: How the frontend, the MCP surface, the backend and the smaller units are tested; runners, layout, required suites, test doubles, determinism rules, goldens, coverage and the CI mapping.
audience: Contributors writing or reviewing tests; maintainers operating CI.
related:
  - 00-decisions.md
  - 02-mcp-and-tools.md
  - 05-coding-standards.md
  - 06-ci-cd-local-dev.md
---

# 09 — Testing

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Governing decisions: D-17 (runners), D-12 (stable tool contract), D-04 (migrations), D-20 (redaction property), D-18 (package gate).

Website simulations (fake social networks, fake CAPTCHA pages) are not part of the test suite; §9 defines the fixture-server pattern they would plug into.

---

## 1. Pyramid and runners

| Layer | Runner | Runtime | Where | Budget |
|---|---|---|---|---|
| Contract goldens | `bun test` | Bun | `packages/contracts/test/` | seconds |
| Unit (core, cli, contracts) | `bun test` | Bun | colocated `*.test.ts` | < 60 s total, no browser, no network, no real clock |
| Dashboard unit + component | `bun test` + `happy-dom` + `@testing-library/react` + `axe-core` | Bun | `packages/dashboard/src/**/*.test.tsx` | < 60 s |
| Integration (real Chromium) | `bun test` with `--preload test/integration/setup.ts`, tag `integration` | Bun | `packages/core/test/integration/`, `packages/browserhive/test/integration/` | minutes |
| Dashboard end-to-end | Playwright Test | Node (Playwright runner) driving a built dashboard served by a real `browserhive` | `packages/dashboard/test/e2e/` | minutes |
| Package gate | scripts | Bun + npm | `scripts/smoke-installed.ts` | minute |

`bun test` is the only runner for anything that touches `bun:sqlite`, `Bun.serve`, or `Bun.password` (D-01, D-17). Vitest is not used. Playwright Test is the one Node-hosted runner and it never imports BrowserHive code; it talks to a running server over HTTP.

Root scripts: `bun run test` (contracts + core + cli + dashboard unit), `bun run test:integration`, `bun run test:e2e`, `bun run test:goldens` (subset of `test`, runs first), `bun run test:all`.

## 2. Layout

```
packages/<pkg>/
  src/**/x.ts
  src/**/x.test.ts                colocated unit tests (same directory as the unit)
  test/
    goldens/                      committed JSON snapshots (contracts only)
    fixtures/                     fixture data, fixture DBs per schema version (core)
    integration/                  real-Chromium suites (core, browserhive)
    e2e/                          Playwright (dashboard)
    helpers/                      doubles and builders shared inside the package
    setup.ts                      bun test preload for the package
bunfig.toml                       [test] preload, coverage, timeout
```

Tests import their own package through `src/` relative paths and other packages only through the package entry (`@browserhive/contracts`), enforced by dependency-cruiser (`01-overall-architecture.md` §4).

## 3. Required suites

Each item is a suite that must exist; the name in parentheses is the file. "Invariant" lines are assertions that may not be weakened without a decision-log change.

### 3.1 Contracts (goldens)

Committed under `packages/contracts/test/goldens/` and regenerated only through the golden protocol (§7):

- `tools.json` — for each of the 43 tools: name, title, description, annotations, input JSON Schema, output JSON Schema (from `z.toJSONSchema`). **Invariant:** the 43 names and their registration order are fixed (D-12), because MCP clients list tools in that order and agent prompts refer to tools by name; every input schema has top-level `type: "object"`; `scroll` stays a flat object with no `oneOf`/`anyOf` at the top level.
- `openapi.json` — the generated OpenAPI 3.1 document for `/api/v1`. **Invariant:** every route has a problem+json error response; every collection route uses the shared `Page<T>` envelope.
- `ws-protocol.json` — JSON Schema of the envelope, every client command, every server message, every feed payload.
- `config-schema.json` — the config JSON Schema. **Invariant:** every key has `description` and `x-browserhive-env`; reserved keys are listed with `x-browserhive-reserved: true`.
- `errors.json` — the error registry (code, status, category, retryable, title). **Invariant:** every tool-surface code an agent can branch on is present with its category and public message text intact (`contracts/test/errors.registry.test.ts` pins the set and the texts; 10 §1.1); new codes are additive.
- Name-mapping test: for every config key, `namesFor(key)` yields unique env/CLI/JSON names, and the mapping round-trips.

### 3.2 Core unit

Domain and application (no I/O, fakes only):

- Session state machine (`domain/session/state.test.ts`): every legal transition; every illegal transition throws a typed error; `crashed` from `live` and from `launching`; `draining` cannot re-enter `live`.
- Lease (`domain/session/lease.test.ts`): sliding reset, pause banks remaining time, resume restores it, expiry while paused is impossible, injected clock only.
- Creation pipeline (`app/sessions/create-pipeline.test.ts`): phases run in declared order; a veto in phase N runs the compensators of phases < N in reverse exactly once; a thrown error in `launch` leaves no reservation, no profile dir, no registry entry; per-phase timings are reported; `AbortSignal` cancels between phases.
- Admission (`domain/session/admission.test.ts`): derived cap from injected host memory; `unbounded`; typed retryable `SESSION_LIMIT_REACHED`.
- Tool dispatcher (`interface/mcp/dispatcher.test.ts`). **Invariants:** exactly one observation per terminal outcome, including argument-validation failures (`INVALID_ARGUMENTS`) and authorization denials; the observer can never alter or replace a tool's result (a throwing observer is logged, the result still returns); ownership is enforced for every tool that names a session, including `close_session`, `list_sessions` (filtered to the caller), `list_saved_auths`, `get_attention_result`; the `[CODE] message` text and the structured error in `_meta['browserhive.ai/error']` agree (10 §2.1); `evaluate` returns `EVALUATE_DISABLED` when `allowEvaluate=false` or the session has `disable_evaluate`.
- Tool contract execution (`interface/mcp/tools/*.test.ts`): every tool executed at least once against `FakeSessionHandle` with defaults applied through the real zod schema (not raw args); result shape asserted against the output schema. A checklist test enumerates the catalogue and fails if any tool lacks an execution test, so a tool whose schema compiles but whose handler never ran cannot ship.
- Redaction property (`app/observability/redaction.property.test.ts`): generate secrets and payloads (fast-check); after arming, a marker secret never appears in: logger sinks, event rows, WS frames, MCP results, OTLP export payloads, error messages. **Invariant:** zero leaks over 1 000 cases; runs in the fast suite with 1 000 cases, nightly with 100 000.
- Config resolver (`app/config/resolve.test.ts`): table-driven ladder cases (env < file < cli), shadow lines exact text, secrets redacted in shadow lines, derived provenance (`trace`, `fingerprint`, `maxSessions`, `dataDir`), every fail-fast message in `08-cli-arguments-and-config.md` §4 reproduced exactly, "did you mean" suggestions and the unsupported spellings of 08 §5.5, reserved keys rejected, empty env rejected, relative path resolution against cwd vs config-file dir, the data-dir-config rule, OTEL sub-source precedence.
- Migration runner (`infra/persistence/migrations/runner.test.ts`, file-backed temp DB): fresh DB ends at `SCHEMA_VERSION`; each fixture DB `test/fixtures/db/v<N>.db` upgrades to head and its pragma-normalised fingerprint equals a fresh install; backup file is created before any DDL and retained per `backupsKeep`; a migration that throws mid-way leaves `user_version` unchanged and no partial schema (crash/rollback); a DB with `user_version > SCHEMA_VERSION` and `min_reader_version <= SCHEMA_VERSION` opens (compat window); with `min_reader_version > SCHEMA_VERSION` it refuses with `DB_NEWER_THAN_BINARY` naming the backup; `application_id` mismatch refuses; a second opener (`purge` inventory) never deadlocks; `db.exec` is used (a test asserts that a multi-statement migration executes all statements).
- Schema snapshot (`infra/persistence/schema.snapshot.test.ts`): pragma-normalised schema of a fresh DB equals the committed golden `test/goldens/schema-v<N>.json`; adding a migration without updating the golden fails.
- Repository conformance (`infra/persistence/repositories.conformance.test.ts`): one suite parameterized over adapters; runs against the SQLite adapter on `:memory:` today and is the acceptance suite for any future adapter. Covers every repository method, keyset pagination stability under concurrent inserts, `ON DELETE CASCADE` for every `session_id` FK, `INSERT` idempotency on primary keys, transaction rollback via `UnitOfWork`.
- Retention (`app/observability/retention.test.ts`): every table has a retention class asserted over the table list; age prune; byte cap converges without `VACUUM` in a loop; artifact deletion via the outbox; `pending_attention`/operator-request rows are pruned once terminal; failures are counted and surfaced, never thrown out of the timer.
- Error registry (`kernel/errors/*.test.ts`): every code projects to MCP, problem+json, and WS frames; `docs/errors.md` generation is deterministic; `INTERNAL_ERROR` never carries host paths in the public message.
- Logger (`infra/logging/*.test.ts`): JSON and pretty renderers with fixed clock and width; field priority order; redaction of key names and registered secrets; `child()` bindings; per-module level spec; ring buffer size and eviction; stdio guard routes `console.*` to stderr.
- Request context / telemetry (`infra/telemetry/*.test.ts`): spans nest under `AsyncLocalStorage`; log records carry `trace_id`/`span_id`; the no-op provider adds no fields when `otel=false`.
- WS hub (`interface/ws/hub.test.ts`, fake socket): envelope shape; `subscribe` with a cursor replays buffered events in order; buffer bounds by count, bytes, and age; overflow yields `resync_required`; screencast is latest-wins per connection and drops frames when the fake socket reports backpressure while feed events are never dropped; auth invalidation closes 4401; five protocol violations close 4400; stale reap 1001.
- HTTP routes (`interface/http/routes/*.test.ts`): the real Hono app with an in-process `:memory:` database and in-memory browser driver, no port; every route has at least one success test and one validation-failure test (400 problem+json with field errors); an auth matrix test iterates all routes × {no cookie → 401, must-change-password → 403 except the allowed three, valid → 2xx/4xx}; response bodies parsed with the contracts schema; response goldens for list routes with a seeded fixture dataset and fixed clock/ids (deep equality).
- Auth (`app/auth/*.test.ts`): provider chain order; present-but-invalid never falls through; password sessions idle/absolute expiry; token hashing and constant-time lookup; grants single-use and revoked with the parent; `Authorizer.can` table; login rate limit and lockout; password change revokes other sessions.
- Vault broker (`domain/vault/broker.test.ts`): the gate suite (every gate, every reason, exactly one audit row per fill, no substring of a secret in any result), principal+slug authorization, and the trace pause/resume hook around the fill (asserted through a fake tracing port).
- Origin check (`domain/vault/origin.property.test.ts`): a 10 000-pair property test in the nightly suite; a 500-pair version in the fast suite.
- Glob, blocklist, URL classification, deny-list (`kernel/*.test.ts`, `domain/policies/*.test.ts`): table-driven cases covering every documented grammar rule and example in 11 §4–§5; blocklist reload replaces rules atomically.
- Humanize (`infra/browsers/humanize/*.test.ts`): seeded RNG schedules with injected `sleep`; budget fallbacks to native; typo model; vault typer fallback.
- Operator requests (`domain/operator-requests/*.test.ts`): attention and vault-confirm share the broker; timeout, cancel on heartbeat rejection, session-close settlement per reason, orphan recovery at startup, lease pause/resume, idempotent ids, bounded queue.
- Notifications (`app/notifications/*.test.ts`): producer rules from the bus; persistence; read/dismiss; WS topic emission.
- Event bus (`app/events/bus.test.ts`): every domain event has a versioned name and a zod payload in contracts; consumers are isolated (a throwing consumer does not stop others).

### 3.3 CLI unit (`packages/browserhive/src/cli/*.test.ts`)

- `planCli(argv, env, fs)` pure: help > version > unknown flags (64) > command > stray flags (64) > config (64) > policy guards (3) > run.
- `--help` output snapshot per command (golden text, width 100, colour off).
- `purge`: inventory rendering with a fixture data dir; `YES` prompt; second `YES` for `--all`; `--dryRun` writes nothing; no TTY without `--yes` refuses.
- `doctor`: each check with injected probes; exit 0/1/2; `--json` shape.
- `init`: idempotent re-run reports "already installed"; failure of the browser download is reported and exits 1 with the exact command to retry.
- `config show/validate/schema`: provenance table; JSON output validated against the schema.
- `db status/backup/restore/migrate`: against a temp file DB.
- Composition root: phase failure in `open-listeners` unwinds storage and closes the DB; `stop()` after failed `listen()` is a no-op; signal handling (first = graceful, second = 130); `createServer` typed options resolve with provenance `cli`.

### 3.4 Integration (real Chromium)

One suite per user-visible guarantee, plus the single-port smoke. All use `PlaywrightBrowserDriver` and the fixture HTTP server (§9); single worker; 60 s timeouts.

- `isolation.test.ts` — cookies, localStorage, sessionStorage, IndexedDB, service workers never leak between sessions. **Invariant:** BrowserHive's reason to exist; runs on every PR on all three OSes.
- `stealth.test.ts` — Phase 0 (UA, `webdriver=false`, brands, deviceMemory, `window.chrome`, plugins, first-request UA on a new tab) and Phase 1 (display chain, languages, Accept-Language weighting, timezone, native-getter masking, humanized pointer/typing observable by the page), exactly the probes listed in `11-stealth.md` §9.
- `tool-surface.test.ts`, `core-tools.test.ts` — every tool driven through the real dispatcher over a fake transport against real pages; screenshot image block; sandbox violations; dialogs; downloads; uploads.
- `auth-states.test.ts`, `persistence.test.ts`, `incognito.test.ts`, `lifecycle.test.ts` — saved auth states and profiles restore, persistent profiles survive a restart, incognito sessions leave nothing behind, and the lifecycle tools behave as specified in `02-mcp-and-tools.md`.
- `performance.test.ts` — 10 parallel sessions launch and close; skip with `BROWSERHIVE_SKIP_LOAD_TEST=1`.
- `observability.test.ts` — tool calls project into rows, screenshots archived by event id, trace.zip finalized, `trace_id` present on rows.
- `vault.test.ts` — Bitwarden adapter with a fake `bw` executable on PATH; fill against the fixture form; credential absent from trace.zip (unzip and grep every part of the merged trace).
- `single-port.test.ts` (`packages/browserhive/test/integration/`) — spawn `bun src/bin.ts --admin --auth token` on an ephemeral port with a temp data dir: MCP `initialize` → `tools/list` equals the catalog golden → `tools/call list_sessions`; `GET /health` is `ready`; `GET /api/v1/openapi.json` parses; WS handshake without a cookie closes 4401, with a login cookie receives `ready`; SIGTERM exits 0 within `shutdownTimeout`.
- `stdio-handshake.test.ts` — spawn with `--transport stdio`; stdout carries only JSON-RPC frames (a test injects a `console.log` in a hook and asserts it lands on stderr).

### 3.5 Dashboard

- Unit: status registry (every state maps to a tone and label; no string tones); URL-state rules (reset to page 1 on filter change, omit defaults, comma lists, 3-way sort cycle) via the router's `validateSearch`; `JsonView` renders agent-controlled strings as text nodes (regression for the innerHTML surface); `RelativeTime` server-anchored; notification producers; WS bridge patches the Query cache from fat events and invalidates on thin ones; resync on `connecting → connected`.
- Component (RTL + happy-dom + axe): `DataTable` (sort gating, `aria-sort`, selection with indeterminate, card-collapse under `sm`, pager clamps and never unmounts), `FilterBar`, `ConfirmDialog` (focus trap, return, Escape), `CommandPalette` (combobox/listbox roles, scrollIntoView), toast region (`role=status`, pause on hover), theme provider (system/light/dark, no FOUC bootstrap), auth machine (`error`/`offline`, 401 interceptor). Every component test runs `axe` with zero violations.
- End-to-end (Playwright, against `bun run build` + `browserhive --admin --vault bitwarden` with the fake `bw`): login with the seed password → forced change → sessions list with URL filters (paste URL reproduces state) → session detail → start live view → agent calls `request_attention` (driven through the MCP endpoint from the test) → takeover input accepted, `input_rejected` shown when no attention is open → resolve → vault confirm approve with visible rollback on a forced failure → blocklist page shows a hit → notifications persist across reload → logout closes the socket. Responsive screenshot suite at 390, 768, 1280, 1920 for every route (visual goldens with a tolerance, updated through §7). Clipboard fallback on an insecure non-localhost origin (Playwright with `http://127.0.0.2`).

### 3.6 Package gate (`scripts/`)

- `publint` and `@arethetypeswrong/cli --pack` on the built `browserhive` package.
- `smoke-installed.ts`: `npm pack` → clean directory → `bun install <tarball>` → `browserhive --version` → stdio handshake (`initialize`, `tools/list` equals the catalog golden, `list_sessions`) → `import { createServer } from 'browserhive'` and `listen()`/`stop()` on port 0.
- Tarball content assertions: contains `dist/`, `README.md`, `LICENSE`, dashboard assets; excludes `src/`, `test/`, `.tsbuildinfo`, sourcemaps.
- `release-dry-run` = build + gate, run on tags and on demand.

## 4. Test doubles

All doubles live in `test/helpers/` of their package and implement a **port**, never a concrete class.

| Double | Implements | Notes |
|---|---|---|
| `FakeBrowserDriver` | `BrowserDriver` | records `LaunchSpec`s; returns `FakeSessionHandle`; can be told to fail at launch, to crash later, or to hang (for deadline tests) |
| `FakeSessionHandle` | `SessionHandle` | capabilities configurable; emits `disconnected`; tracing port records start/stop/pause/resume calls |
| `FakePage` | the Playwright `Page` subset the tools use | scripted URLs, titles, dialogs, downloads, element actionability outcomes; every method records calls |
| `FakeTransport` | MCP transport seam | drives the real `McpServer` + dispatcher in-process (`client.callTool`) rather than calling handlers directly, so schema defaults and validation are always exercised |
| In-memory repositories | every repository port | `Map`-backed; used by app-layer tests; the conformance suite (§3.2) keeps them honest against the SQLite adapter |
| `FakeClock`, `FakeIdGenerator` | `Clock`, `IdGenerator` ports | deterministic `now()`, `advance()`, sequential ids for goldens |
| `FakeSocket` | the WS transport seam | scripted `send()` results (`-1` backpressure), `bufferedAmount`, close codes |
| `FakeVaultBackend` | `VaultBackend` | in-memory entries with configurable `capabilities`; every call recorded |
| `fake-bw` | executable on PATH | a Bun script emulating `bw status/list/get/sync` for integration and e2e; `BW_SESSION` equal to `FAKE_BW_TOKEN` means unlocked (there is no `unlock`, because BrowserHive never runs it) |
| `FakeOtlpCollector` | HTTP server | accepts OTLP/HTTP, stores payloads for assertions |

## 5. Determinism rules

- No real timers in unit tests: `Clock` is injected everywhere; `bun test` fake timers (`mock.timers` or an injected scheduler) drive sweeps and heartbeats.
- Seeded RNG for humanize and fingerprint tests; the seed is part of the test name.
- Fixed ids (`FakeIdGenerator`) and a fixed clock for every golden and every response snapshot.
- No `sleep(n)` waits; wait on promises, events, or fake-timer advancement. Integration tests may poll with a bounded deadline.
- Temp directories through one helper (`withTempDir(async dir => …)`) that always removes the directory; no fixed `/tmp` paths; each test gets its own data dir.
- Ports: `0` (ephemeral) everywhere; the port is read back from the server handle.
- Environment: tests never read `process.env` implicitly; the resolver and all subsystems receive an injected env.
- Console output during tests is captured and asserted empty unless the test is about output.

## 6. Coverage

`bun test --coverage` (c8/istanbul output) on the unit suites of contracts, core, cli, and dashboard. A **ratchet** stores the last accepted line/branch percentages in `coverage.ratchet.json`; CI fails if coverage drops more than 0.5 points below the ratchet; the ratchet is raised by a script when coverage improves. There is no 100 % gate. Integration and e2e are excluded from the ratchet.

## 7. Golden protocol

- Goldens are committed JSON (or text for help/CLI output, PNG for visual e2e) and compared with deep equality (visual: pixel tolerance 0.1 %).
- Regeneration only via `UPDATE_GOLDENS=1 bun test …`; the diff appears in the PR, and the PR description must state why the contract changed. A CI check rejects a golden change whose PR body lacks a `Contract change:` line.
- A golden for a frozen contract (tool names, error codes) additionally requires a decision-log update; the test names the decision it guards (`D-12`).

## 8. CI mapping

| Suite | Per PR | Nightly / on tag |
|---|---|---|
| lint, typecheck (all projects incl. dashboard), depcruise | ✓ | ✓ |
| contract goldens, unit (core, cli, contracts, dashboard) | ✓ (ubuntu) | ✓ |
| integration (real Chromium) | ✓ isolation + tool-surface + single-port on ubuntu; full suite on ubuntu/macos/windows | full suite, all OSes |
| dashboard e2e | ✓ smoke subset (login → sessions → detail) on ubuntu | full incl. responsive goldens |
| property tests | ✓ small case counts | large case counts |
| package gate | ✓ | ✓ + release dry-run |
| coverage ratchet | ✓ | ✓ |

Playwright browsers are cached with a key derived from the resolved `playwright`/`patchright` versions. Windows runs use `--disable-dev-shm-usage`-equivalent flags only where the launcher already sets them; nothing is skipped silently: a suite that cannot run (no Chromium) fails with a clear reason instead of `skip`.

## 9. Fixture HTTP server

`test/helpers/fixture-server.ts` starts a `Bun.serve` on `127.0.0.1:0` serving deterministic pages, all defined as TypeScript templates so no assets are read from disk:

- `/form` — username/password form with a configurable `action` (same-origin, cross-origin, `javascript:`), used by vault and interaction tests.
- `/redirect?to=` — 302 chains, used by blocklist request-layer tests.
- `/dialog?kind=alert|confirm|prompt` — fires on load.
- `/download` — `Content-Disposition: attachment` with a known body.
- `/popup` — `window.open` to another fixture path.
- `/probe` — stealth probe page in the main world (the Phase 0/1 assertions read from it).
- `/slow?ms=` — delayed responses for timeout tests.
- `/sw.js` — no-op service worker for isolation tests.

Website simulations (full fake sites for CAPTCHA, SSO, or job boards) would be added as additional routes or as a separate `test/simulations/` package using the same helper; they are not part of the suite today.

## 10. Flake and regression policy

- A test that fails twice in a week on `main` without a code change is quarantined (`test.todo` with a linked issue) within one day and fixed or deleted within two weeks; quarantined tests are listed by a CI step so they cannot be forgotten.
- Retries are disabled in unit suites; Playwright e2e allows one retry and reports the retry as a warning.
- Every bug fix ships a regression test whose name contains the issue id (`fixes #123: retention survives pending attention rows`).
- Failure modes that are easy to reintroduce each have a named regression test in the suite that owns the behavior: retention pruning a row that other rows still reference by foreign key, a server that keeps running against a newer database it cannot write to and silently records nothing, `allowEvaluate=false` not actually disabling `evaluate`, an optimistic vault-confirm update left stranded when the request fails, and a WebSocket client that never notices its connection has died.

## Design notes

- Dashboard component tests run under `bun test` + happy-dom rather than a browser-mode runner; Playwright e2e covers real-browser behavior. If a component needs layout measurement (resizable panes, container queries), it is tested in e2e, not in happy-dom.
- The repository conformance suite is written against the ports so that a Postgres adapter, if it ever exists, has its acceptance test ready at no extra cost.
- Visual goldens for the responsive suite are stored under `packages/dashboard/test/e2e/__screenshots__/` and are large; Git LFS is not used; it SHOULD be introduced if the directory exceeds ~20 MB.
