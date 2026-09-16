---
title: "Overall architecture"
spec: "01"
status: Normative
scope: What BrowserHive is, its runtime topology, repository layout, layering rules, subsystems, composition root and lifecycle, development and publishing workflows, extension seams, and the dependency order of subsystems.
audience: Contributors orienting themselves in the codebase; reviewers checking layer boundaries and subsystem ownership.
related:
  - 00-decisions.md
  - 02-mcp-and-tools.md
  - 03-admin-backend.md
  - 04-admin-frontend.md
  - 06-ci-cd-local-dev.md
---

# 01 — Overall Architecture

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: project and codebase structure, tooling, primary development, testing and publishing workflows. Deep dives live in the sibling specs.

---

## 1. What BrowserHive is

A local-first, MCP-native daemon that runs N isolated Chromium sessions (one browser process + one context per session) for LLM agents, with vault-backed credential injection the model never sees, a human-in-the-loop attention/takeover mechanism, a SQLite audit trail with Playwright trace replay, and an operator dashboard. HTTP is the first-class transport; stdio is a single-client fallback. The agent is untrusted; the operator is trusted.

Non-goals: managed proxy networks, hosted CAPTCHA farms, cloud identity, telemetry that leaves the host by default, horizontal multi-node scale.

## 2. Runtime topology (D-01, D-02)

```
┌────────────────────────────── browserhive (one Bun process) ──────────────────────────────┐
│  Bun.serve :9876                                                                            │
│   ├─ /mcp            McpServer (official SDK) ── ToolDispatcher ── application services     │
│   ├─ /api/v1/*       Hono OpenAPI routes ─────────┐                                         │
│   ├─ /api/v1/ws      Realtime hub (feed, screencast, input, logs)                           │
│   ├─ /health         readiness (composition phase)                                          │
│   └─ /  /trace-viewer  dashboard SPA + Playwright trace viewer (static)                     │
│                                                                                              │
│  Application: SessionService · AttentionService · VaultService · AuthService · BlocklistSvc  │
│  Domain: Session state machine · Lease · Identity/Stealth · Vault broker · OperatorRequests  │
│  Infra: BrowserDriver (Playwright/Patchright) · SQLite (Kysely) · Logger · OTel · FS layout  │
│  Event bus ──► DB projection · WS feed · notifications · OTLP (opt-in)                       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ one Chromium process per session                     │ optional OTLP/HTTP
        ▼                                                      ▼
   chromium (session A)  chromium (session B) …          any OTel backend
```

`--transport stdio` swaps the HTTP front door for the SDK's stdio transport; the dashboard, WS, attention, and vault-confirm are unavailable (the attention tools stay registered and return `ATTENTION_REQUIRES_HTTP`, so the tool catalog is identical on both transports, D-12).

## 3. Repository layout (D-03)

```
BrowserHive/
├── package.json                  workspaces, root scripts (bun)
├── bunfig.toml                   test preload, registry
├── tsconfig.base.json            strict flags (D-19); tsconfig.json = project references
├── biome.json                    lint + format (Biome 2.5)
├── .dependency-cruiser.cjs       layer rules (see §4)
├── .changeset/                   Changesets (fixed group)
├── .github/workflows/            ci.yml, release.yml (see 06-ci-cd-local-dev.md)
├── docs/                         user + reference docs shipped with the package (generated parts marked)
├── specs/                        these specs
├── scripts/                      sync-version.ts, smoke-installed.ts, gen-openapi.ts, gen-docs.ts
└── packages/
    ├── contracts/                @browserhive/contracts
    │   └── src/
    │       ├── config/           serverConfigSchema, key registry (env/cli/json names, descriptions)
    │       ├── errors/           error registry (code → status/category/retryable/details schema)
    │       ├── enums/            Channel, PersistenceMode, ClosedReason, UrlCategory, AttentionMode…
    │       ├── tools/            input/output zod schemas for all 43 tools (+ annotations, titles)
    │       ├── http/             REST DTOs, PageQuery/Page<T>, problem+json schema
    │       ├── ws/               envelope, client commands, server messages, feed event payloads
    │       └── index.ts
    ├── core/                     @browserhive/core
    │   └── src/
    │       ├── kernel/           L0: ids, clock, result, glob, url-classify, host predicates, secret registry
    │       ├── domain/           L1: session state machine, lease, identity, vault broker (pure), operator-request model, policies
    │       ├── ports/            L1: interfaces — BrowserDriver, repositories, UnitOfWork, VaultBackend, GeoSeedResolver, ProxyResolver, NotificationChannel, Clock
    │       ├── infra/            L2: adapters — browsers/ (playwright launcher, stealth cdp, fingerprint), persistence/ (kysely, migrations, repos), fs/ (DataDir), logging/, telemetry/, vault-backends/bitwarden
    │       ├── app/              L3: application services — sessions, attention, vault, auth, blocklist, auth-states, notifications, observability; the event bus
    │       ├── interface/        L4: mcp/ (tool definitions + dispatcher), http/ (routes, middleware, serializers), ws/ (hub, topics), static/
    │       └── index.ts          public surface (explicit exports; no export *)
    ├── dashboard/                @browserhive/dashboard (see 04-admin-frontend.md)
    └── browserhive/              published package
        └── src/
            ├── cli/              command parser (schema-driven), commands: serve, init, doctor, purge, config, db, admin, version
            ├── composition/      phased composition root with unwind stack (§6)
            ├── index.ts          programmatic API: createServer(options)
            └── bin.ts            #!/usr/bin/env bun
```

## 4. Layering inside `core` (enforced)

| Layer | May import | Must not import |
|---|---|---|
| L0 `kernel` | contracts | anything else in core |
| L1 `domain`, `ports` | kernel, contracts | infra, app, interface, playwright, bun:sqlite, hono |
| L2 `infra` | kernel, domain, ports, contracts | app, interface |
| L3 `app` | kernel, domain, ports, contracts | infra (except through ports at composition), interface |
| L4 `interface` | kernel, contracts, app (services), ports (types) | infra, playwright |
| `browserhive/composition` | everything | — |

Concrete rules in `.dependency-cruiser.cjs`; violations fail CI. Two additional bans: `playwright`/`patchright` MUST be imported only under `infra/browsers/`; `kysely` and `bun:sqlite` only under `infra/persistence/`. Tests import package entry points, never deep paths across packages.

## 5. Subsystems and their responsibilities

- **Session subsystem** (`domain/session`, `app/sessions`): registry, state machine, lease (sliding, pausable), creation pipeline (D-21), tabs, ownership, warnings. Playwright appears only through `BrowserDriver`/`SessionHandle` ports; interaction still uses Playwright `Page` types (engine-neutral lifecycle, Playwright-typed interaction) until a second engine exists.
- **Browser driver** (`infra/browsers`): launcher (channel map, arg merge, deny-list), stealth (Patchright resolution, CDP UA override per page, fingerprint init script, geo seed), tracing, blocklist route. Details in `11-stealth.md`.
- **Tools** (`interface/mcp`): 43 declarative `ToolDefinition`s grouped in packs; one dispatcher (parse → authorize → policy → execute → map error → classify outcome → observe). Details in `02-mcp-and-tools.md`.
- **HTTP/WS** (`interface/http`, `interface/ws`): admin API, realtime hub, static serving, auth middleware. Details in `03-admin-backend.md`.
- **Persistence** (`infra/persistence`): Kysely dialect, migrations, repositories, analytics queries, retention, backups, purge inventory. Schema in `03-admin-backend.md` §Data model.
- **Auth** (`app/auth`, `infra/auth`): provider chain, sessions, tokens, credentials, authorizer (D-09).
- **Vault** (`domain/vault`, `app/vault`, `infra/vault-backends`): broker, bindings/policies repos, redaction, confirm via operator requests (D-14).
- **Operator requests** (`domain/operator-requests`, `app/attention`): attention + vault confirm (D-15).
- **Observability** (`infra/logging`, `infra/telemetry`, `app/observability`): logger, OTel, request context, recorder (event → DB rows), ring buffer, retention. Details in `10-error-handling-and-telemetry.md`.
- **Event bus** (`app/events`): typed, in-process, versioned event names (`session.opened`, `tool.called`, `page.visited`, `attention.created`, `vault.access`, `blocklist.hit`, `system.degraded`, …). Consumers: DB projection (first, synchronous enqueue), WS feed, notifications, OTLP metrics. Every mutation publishes through the bus; the WS layer never synthesizes events itself.

## 6. Composition root and lifecycle

`browserhive/src/composition/` builds the process in named phases, each returning a handle with `stop(deadline)`. Failure in phase N unwinds phases N-1…1 in reverse and rethrows a typed boot error (exit codes: 0 ok, 1 fatal, 3 policy refusal, 64 usage).

```
resolve-config → open-storage (migrate, PRAGMAs, backups) → build-domain (drivers, services, brokers)
→ wire-observers (bus → recorder, ws, notifications, otel) → open-listeners (Bun.serve or stdio)
→ ready (banners, /health=ready)
```

Shutdown on SIGINT/SIGTERM: `stop` with budgets (listeners 2 s, sessions drain 15 s, storage flush 5 s incl. `wal_checkpoint(TRUNCATE)`), second signal forces exit with a message. `unhandledRejection`/`uncaughtException` handlers are installed by the CLI with an explicit policy (log + mark degraded; exit only on storage corruption). Every timer callback is wrapped (`void tick().catch(report)`).

The programmatic API `createServer(options)` uses the same composition root; `listen()`/`stop()` are idempotent; `stop()` after a failed `listen()` unwinds correctly.

## 7. Development workflow (summary; details in `06-ci-cd-local-dev.md`)

```
bun install
bun run init:browsers        # playwright install chromium (+ patchright)
bun run dev                  # server in watch mode with pretty logs + dashboard Vite dev server proxying the API
bun run browserhive --admin  # daemon from source + Vite on --port + 10000 (D-11)
bun run typecheck            # tsc -b (all projects incl. dashboard)
bun run lint / lint:fix      # biome
bun run test                 # bun test (unit, fast, no browser)
bun run test:integration     # real Chromium
bun run test:e2e             # playwright against a built dashboard
bun run build                # contracts → core → dashboard → browserhive (tsdown + vite)
bun run check                # lint + typecheck + depcruise + test + contract goldens
```

## 8. Publishing workflow (summary; details in `06-ci-cd-local-dev.md`, D-18)

PR → Changeset → merge to `main` → Changesets bot opens "Version Packages" → merge → `release.yml` builds, runs the `package` gate, publishes `browserhive` with OIDC provenance, tags `vX.Y.Z`, creates the GitHub Release. `next` channel via `changeset pre enter next`.

## 9. Extension points (seams that exist without their features)

| Seam | Where | Reserved for |
|---|---|---|
| `BrowserDriver.launch(spec) → SessionHandle{capabilities}` | ports | Firefox/WebKit/Camoufox engines, direct-CDP |
| `ProxyResolver`, `LaunchSpec.proxy`, `proxy_label` | ports/domain | managed pool, rotation, exit-geo |
| `GeoSeedResolver` (`source: host|proxy`) | ports | proxy-exit geo |
| `VaultBackend` + `capabilities` | ports | local vault, 1Password, HTTP vault, TOTP |
| `OperatorRequestBroker.kind` | domain | security intercept, approval gates, CAPTCHA takeover |
| `AuthenticationProvider` chain, `Authorizer`, `tenant_id` | app/auth | better-auth, RBAC, orgs, OIDC/SAML |
| `NotificationChannel.send` | ports | webhook, ntfy, Telegram, Slack, email |
| `AdmissionPolicy` in the create pipeline | domain | resource governor, queueing, eviction |
| `InterceptionChain` (blocklist route is the first handler) | domain | security rules, egress firewall, Web Bot Auth signing |
| `ToolPack` registry with `requires` | interface/mcp | profile tools, proxy tools, captcha tools |
| Event bus consumers | app/events | OTLP metrics, audit hash chain, session bundle export |
| `PersistenceMode` enum | contracts | `blueprint` profiles |

## 10. Upgrades and data compatibility

- The database schema evolves only through the forward-only migration runner (D-04): every upgrade takes a `VACUUM INTO` backup first, and an older binary refuses a database outside its compatibility window with `DB_NEWER_THAN_BINARY`, naming the backup and `browserhive db restore <file>`.
- The tool catalog is a stable contract across upgrades (D-12); changes within a major version are additive.
- Files in the data directory are those of the D-24 layout. BrowserHive does not read or convert files it does not recognise; `browserhive doctor` reports them.
- Saved auth-state manifests without an `owner` field are treated as owned by `local` (02 §6).

## 11. Dependency order of subsystems

Each step depends only on the steps before it; a new contributor reading bottom-up, or a change that touches several layers, follows the same order.

1. `contracts` (config, errors, enums, tool schemas, DTOs, WS protocol) + goldens.
2. `core/kernel`, `infra/persistence` (dialect, runner, schema, repositories, conformance tests).
3. `infra/logging` + `telemetry` + request context; error model.
4. `domain/session` + `infra/browsers` + `app/sessions`; isolation and stealth integration suites.
5. `interface/mcp` dispatcher + all 43 tools; stdio transport; tool-surface tests.
6. `app/auth`, `interface/http` (routes), `interface/ws`, static; `composition`; `browserhive` CLI.
7. Vault, operator requests, auth states, blocklist, notifications, retention, purge.
8. Dashboard foundation (shell, tokens, component set), then pages.
9. Package gate, docs generation, release.
