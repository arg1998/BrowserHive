# Architecture

A summary for contributors. The authoritative design is in [`specs/`](../../specs/README.md): start with [the decision log](../../specs/00-decisions.md) (decisions are cited as `D-xx`), then [the overall architecture](../../specs/01-overall-architecture.md). When a spec and the decision log disagree, the decision log wins.

## What it is

A local-first, MCP-native daemon that runs N isolated Chromium sessions (one browser process and one context per session) for LLM agents, with vault-backed credential injection the model never sees, a human-in-the-loop attention and takeover mechanism, a SQLite audit trail with Playwright trace replay, and an operator dashboard. HTTP is the first-class transport; stdio is a single-client fallback. **The agent is untrusted; the operator is trusted.**

Non-goals: managed proxy networks, hosted CAPTCHA solving, cloud identity, telemetry that leaves the host by default, multi-node scale.

## Runtime topology

One Bun process, one port (D-01, D-02):

```
Bun.serve :9876
 ├─ /mcp              MCP Streamable HTTP (official SDK) ── tool dispatcher ── application services
 ├─ /api/v1/*         admin REST (Hono + zod-openapi), problem+json errors
 ├─ /api/v1/ws        realtime hub: feeds, screencast, takeover input, logs
 ├─ /health           readiness
 └─ / , /trace-viewer dashboard SPA and Playwright trace viewer

Application: sessions · attention · vault · auth · blocklist · notifications · observability
Domain:      session state machine · lease · identity/stealth · vault broker · operator requests
Infra:       browser driver (Playwright/Patchright) · SQLite (Kysely) · logger · OpenTelemetry · file layout
Event bus ─► DB projection · WebSocket feed · notifications · OTLP (opt-in)
```

`--transport stdio` replaces the HTTP front door with the SDK's stdio transport. The dashboard, WebSocket, attention and vault confirmations are then unavailable.

## Packages

Bun workspaces, boundaries enforced by `dependency-cruiser` and TypeScript project references (D-03):

| Package | Published | Contents |
|---|---|---|
| `packages/contracts` (`@browserhive/contracts`) | no | Every wire shape as zod: config schema and key registry, error registry, enums, the 43 tool contracts, REST DTOs and the endpoint manifest, the WebSocket protocol. Platform-neutral; depends on zod only. |
| `packages/core` (`@browserhive/core`) | no | Everything server-side, in layers (below). |
| `packages/dashboard` (`@browserhive/dashboard`) | no | React 19 SPA (Vite, Tailwind v4, TanStack Router/Query/Table). Imports only `@browserhive/contracts`. |
| `packages/browserhive` (`browserhive`) | **yes** | CLI, composition root, programmatic API (`createServer`). Bundles core and the dashboard. |

## Layers inside `core`

| Layer | May import | Must not import |
|---|---|---|
| `kernel` (ids, clock, result, errors, glob, URL classification, secret registry) | contracts | anything else in core |
| `domain`, `ports` (state machines, pure policies, interfaces) | kernel, contracts | infra, app, interface, Playwright, `bun:sqlite`, Hono |
| `infra` (adapters: browsers, persistence, logging, telemetry, vault backends) | kernel, domain, ports, contracts | app, interface |
| `app` (application services, event bus) | kernel, domain, ports, contracts | infra, interface |
| `interface` (MCP tools and dispatcher, HTTP routes, WebSocket hub, static files) | kernel, contracts, app, port types | infra, Playwright |
| `browserhive/composition` | everything | — |

Playwright and Patchright may be imported only under `infra/browsers/`; Kysely and `bun:sqlite` only under `infra/persistence/`.

## Subsystems

- **Sessions:** registry, explicit state machine (`reserved → launching → live ⇄ paused → draining → closed | crashed`), sliding pausable lease, and a named creation pipeline (`validate → admit → reserve → prepareProfile → resolveIdentity → launch → installPolicies → startTracing → applyIdentity → register`) where every phase registers a compensator (D-21).
- **Browser driver:** channel map, launch-argument deny-list, Patchright resolution, identity and fingerprint, tracing, blocklist route ([spec 11](../../specs/11-stealth.md)).
- **Tools:** 43 declarative tool definitions in packs, one dispatcher pipeline: parse → authorize → policy → execute → map error → classify → observe. The tool surface is frozen (D-12, [spec 02](../../specs/02-mcp-and-tools.md)).
- **HTTP and WebSocket:** routes as data from `HTTP_ENDPOINTS`, auth middleware, realtime hub with ordered resumable feeds and a latest-wins screencast channel (D-10, [spec 03](../../specs/03-admin-backend.md)).
- **Persistence:** `bun:sqlite` with Kysely, forward-only embedded migrations with automatic backups and a compatibility window for downgrades (D-04).
- **Auth:** provider chain (password session cookie, bearer token, short-lived grant), `Authorizer.can(principal, scope)`, ownership on every tool (D-09).
- **Vault:** broker with fixed gate order and one audit row per fill, Bitwarden backend, bindings and folder policies in SQLite (D-14).
- **Operator requests:** one broker for attention and vault confirmations with deadlines, lease pause, cancellation and restart recovery (D-15).
- **Observability:** structured logger with per-module levels and a ring buffer, OpenTelemetry API everywhere with exporters opt-in, redaction by construction (D-08, D-20, [spec 10](../../specs/10-error-handling-and-telemetry.md)).
- **Event bus:** typed in-process events (`session.opened`, `tool.called`, `page.visited`, `vault.access`, …). Every mutation publishes through it; the WebSocket layer never synthesizes events.

## Contracts drive everything

One zod schema per concept generates the rest:

- The config schema generates the parser, `--help`, the config-file JSON Schema and [the configuration reference](../reference/configuration.md) (D-06).
- The error registry generates `AppError`, the MCP/HTTP/WebSocket projections and [the error reference](../reference/errors.md) (D-07).
- Tool contracts generate `tools/list`, the goldens and [the tool reference](../reference/tools.md).
- `HTTP_ENDPOINTS` and the DTOs generate the router, the OpenAPI document, the dashboard client and [the API reference](../reference/api.md).

Wire JSON is snake_case, TypeScript is camelCase, config keys are camelCase, database columns are snake_case.

## Composition and lifecycle

`packages/browserhive/src/composition/` builds the process in phases, each returning a handle with `stop(deadline)`:

```
resolve-config → open-storage → build-domain → wire-observers → open-listeners → ready
```

A failure in phase N unwinds phases N-1…1 in reverse and exits with a typed boot error. Shutdown stops listeners, drains sessions, then flushes storage. `createServer()` uses the same composition root.

## Extension points

Seams exist for features that are deliberately not built yet: other browser engines (`BrowserDriver` capabilities), managed proxies (`ProxyResolver`, `LaunchSpec.proxy`), other vault backends (`VaultBackend`), security intercepts and approval gates (`OperatorRequestBroker.kind`, `InterceptionChain`), multi-user auth (`AuthenticationProvider`, `tenant_id`), external notification channels (`NotificationChannel`), resource governance (`AdmissionPolicy`). See [spec 01 §9](../../specs/01-overall-architecture.md#9-extension-points-seams-that-exist-without-their-features).

## Working on the code

```bash
bun install
bun run init:browsers
bun run browserhive --admin   # daemon from source + Vite with hot reload on :19876
bun run dev          # same, with the server in watch mode (Vite on :5173)
bun run check        # lint, typecheck, dependency rules, unit tests, docs gate
```

Coding standards are in [spec 05](../../specs/05-coding-standards.md), testing in [spec 09](../../specs/09-testing.md), CI and releases in [spec 06](../../specs/06-ci-cd-local-dev.md). After changing a contract, run `bun run gen:docs` so the generated references stay in sync; CI runs `bun run gen:docs --check`.
