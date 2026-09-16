---
title: "Specification index"
spec: "README"
status: Informative
scope: Index of the BrowserHive specifications and the conventions (normative keywords, citation forms, naming, glossary) shared by all of them.
audience: Anyone reading or writing a spec; contributors looking up where a subsystem is specified.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
---

# BrowserHive specifications

These documents specify BrowserHive: a local-first, MCP-native daemon that runs isolated browser sessions for LLM agents, with vault-backed credential injection, human-in-the-loop attention and takeover, an audit trail with trace replay, and an operator dashboard. Read [`00-decisions.md`](00-decisions.md) first; every other spec cites its decisions by id (`D-NN`), then [`01-overall-architecture.md`](01-overall-architecture.md) for the map of subsystems.

| # | Spec | Topic |
|---|---|---|
| 00 | [Decisions](00-decisions.md) | Architecture decision log: runtime, packages, persistence, contracts, config ladder, errors, telemetry, auth, realtime, dashboard stack, tool contract, stealth, vault, operator requests, notifications, testing, publishing, privacy, lifecycle, naming, data layout |
| 01 | [Overall architecture](01-overall-architecture.md) | Topology, repository layout, layering rules, subsystems, composition root, workflows, extension points, dependency order |
| 02 | [MCP and tools](02-mcp-and-tools.md) | MCP server surface, tool definition model and dispatcher, the stable 43-tool contract, attention and auth-state models, goldens |
| 03 | [Admin backend](03-admin-backend.md) | HTTP layering and middleware, auth design, complete `/api/v1` reference, WebSocket protocol, live view, SQLite schema, repositories, retention, notifications |
| 04 | [Admin frontend](04-admin-frontend.md) | Dashboard architecture, providers and data layer, design tokens, app shell, responsive rules, shared components, every page, UX rules, extension recipes |
| 05 | [Coding standards](05-coding-standards.md) | TypeScript config and type rules, naming, module rules, error/async/logging rules, dependency policy, in-source docs, anti-pattern catalogue, definition of done |
| 06 | [CI/CD and local dev](06-ci-cd-local-dev.md) | Local setup and scripts, package builds, versioning, CI and release workflows, npm trusted publishing, one-time setup |
| 07 | [Branching and git](07-branching-and-git.md) | Trunk-based flow, Conventional Commits, Changesets, PR and review process, repository hygiene files |
| 08 | [CLI arguments and config](08-cli-arguments-and-config.md) | The env < file < CLI ladder, naming and value grammars, the complete key table, CLI commands, help and startup output, schema-driven resolver |
| 09 | [Testing](09-testing.md) | Runners, layout, required suites per layer, doubles, determinism, goldens, CI mapping |
| 10 | [Error handling and telemetry](10-error-handling-and-telemetry.md) | Error registry and projections, handling rules, logging, request context, spans and metrics, OpenTelemetry wiring, redaction |
| 11 | [Stealth](11-stealth.md) | Stealth pipeline, constants, config knobs, coherence rules, tests, blocklist and deny-list, the reserved proxy design, known ceilings |
| 12 | [Usage](12-usage.md) | User documentation: install, quick start, MCP clients, dashboard tour, configuration, tools, security, telemetry, CLI, upgrades, FAQ |

Specs 00–11 are **normative**: the implementation follows them, and a divergence is a bug in one or the other. Spec 12 and this index are **informative**.

## Conventions

### Normative keywords

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) when, and only when, they appear in uppercase. Lowercase "must" and "should" are ordinary prose.

### Document structure

Every spec starts with YAML front matter (`title`, `spec`, `status`, `scope`, `audience`, `related`), then its H1 and a conventions note linking here. Section numbers are stable: code and other specs cite them, so a section is rewritten in place rather than renumbered, and a section with nothing left to say is kept as "Reserved" with a one-line purpose.

### Citation forms

| Form | Meaning | Example |
|---|---|---|
| `D-NN` | An entry in the [decision log](00-decisions.md). If a spec and the log disagree, the log wins. | `never attention-gated (D-10)` |
| `spec NN §x.y` | Section `x.y` of spec `NN`, used in code comments, tests and docs. | `/** Shutdown budgets (spec 01 §6). */` |
| `NN §x.y` | The same, inside the specs, where "spec" is implied. | `see 03 §6.6` |

### Naming

| Surface | Style | Example |
|---|---|---|
| Wire JSON (MCP tool params and results, REST, WebSocket) | snake_case | `session_id`, `lease_expires_at` |
| Configuration keys (config file, CLI `--flag`) | camelCase | `maxSessions`, `--minAttentionWait` |
| Environment variables | `BROWSERHIVE_` + SCREAMING_SNAKE | `BROWSERHIVE_MAX_SESSIONS` |
| TypeScript identifiers | camelCase; PascalCase types; SCREAMING_SNAKE for true constants | `sessionId`, `SessionSummary`, `RESULT_TEXT_CAP_BYTES` |
| Files | kebab-case | `session-service.ts` |
| Database columns | snake_case with unit suffixes: `*_at` epoch ms, `*_ms` durations, `*_bytes` sizes | `closed_at`, `duration_ms`, `size_bytes` |
| Timestamps on the wire | epoch milliseconds as numbers | `1760000000000` |
| Identifiers | prefixed grammars (D-23) | session `<slug>-<nanoid8>`, tab `t-<nanoid6>`, event `e-<ulid>`, operator request `a-<nanoid12>` |

Decisions: D-05 (wire), D-06 (config), D-23 (code and database).

### Glossary

| Term | Meaning |
|---|---|
| **Hive**, **daemon** | One running BrowserHive process: one `Bun.serve` listener (or the stdio transport), its database and its browser sessions. |
| **Session** | One isolated browser: one Chromium process and one browser context, created by `launch_session`, identified by `<slug>-<nanoid8>`. Not to be confused with an MCP session or an operator's auth session. |
| **Slug** | The agent-chosen name part of a session id (`^[a-z][a-z0-9-]{1,31}$`); vault policies match slugs with globs. |
| **Tab** | A page inside a session, identified by `t-<nanoid6>`; one tab is active and receives tool calls that omit `tab_id`. |
| **Lease** | A session's sliding expiry; every tool call extends it, open operator requests pause it, and an expired lease closes the session. |
| **Principal** | The authenticated caller of a request (`RequestPrincipal`): an `operator`, an `agent` or a `service`. Ownership and authorization are keyed on the principal. |
| **Operator** | The trusted human who runs the hive and uses the dashboard and admin API. |
| **Agent** | The untrusted LLM client that drives sessions through MCP tools. Under `auth=off` every agent is the principal `local`. |
| **MCP session** | One Streamable HTTP client connection (`m-<nanoid16>`, `Mcp-Session-Id`). Browser sessions outlive it; a reconnecting agent keeps its browser sessions. |
| **Auth session** | An operator's login session (`browserhive_session` cookie, `auth_sessions` table). |
| **Grant** | A short-lived, single-use token that opens one trace or screenshot where a cookie cannot be sent. |
| **Operator request** | A durable request that blocks an agent until an operator decides: an **attention request** (`request_attention`, modes `takeover` and `notify`) or a **vault confirmation** (D-15). |
| **Takeover** | Operator input into a session's live view, permitted only while a `takeover` attention request is open. |
| **Live view** | The CDP screencast of a session's active tab streamed to the dashboard over the WebSocket. |
| **Vault** | The credential broker that fills logins without revealing secrets to the agent (D-14). |
| **Vault binding** | The operator's record that exposes one backend entry to agents under a handle, with allowed origins, authorized principals and slugs, and fill options. |
| **Group policy** | Access rules (`manual`, `allow_all`, `reject_all`, slug globs, confirmation) applied to the entries of one backend group. |
| **Auth state** | A saved login snapshot under `auth-states/`: a Playwright storage state or a full persistent profile. |
| **Data dir** | The directory holding everything BrowserHive stores (D-24): database, backups, session directories, auth states, uploads. |
| **Observation** | The single record the tool dispatcher emits for every tool call, which becomes a `tool_calls` row and a feed event. |
| **Soft failure** | A tool call that returns normally but reports failure (for example `vault_fill` status `blocked`, a navigation with HTTP 404); recorded with an audit code, not thrown. |
| **Feed** | The ordered, resumable stream of domain events on WebSocket topics. |
| **Topic** | A named WebSocket subscription, 1:1 with a REST resource (`sessions`, `session:<id>`, `attention`, …). |
| **Seam** | A port or reserved field that exists so a not-yet-built feature can be added without changing public contracts (D-25). |
