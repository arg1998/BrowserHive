---
title: "Coding standards"
spec: "05"
status: Normative
scope: TypeScript configuration and type rules, naming, module and wiring rules, error/async/logging rules, dependency policy, in-source documentation, the anti-pattern catalogue, developer experience and the definition of done.
audience: Contributors writing code in any package; reviewers.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
  - 06-ci-cd-local-dev.md
  - 10-error-handling-and-telemetry.md
---

# 05 — Coding Standards

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Layering is defined in `01-overall-architecture.md` §4; the error model is in `10-error-handling-and-telemetry.md`. These rules are enforced by tooling wherever a tool exists (Biome, `tsc`, `dependency-cruiser`, grep tests, export snapshots). A rule that cannot be enforced by a tool is enforced in review with the checklist in §12.

---

## 1. TypeScript configuration (D-19)

### 1.1 `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    // Language and emit
    "target": "ES2023",              // Bun ≥1.4 supports everything here natively
    "module": "ESNext",              // ESM only (D-01); no CommonJS anywhere
    "moduleResolution": "Bundler",   // package.json "exports" resolution, .ts extensions allowed
    "lib": ["ES2023"],               // DOM is added ONLY by packages/dashboard (see §1.2)
    "allowImportingTsExtensions": true, // imports are written with the real `.ts` extension
    "verbatimModuleSyntax": true,    // `import type` is real; no import elision surprises
    "isolatedModules": true,         // every file transpiles alone (tsdown/vite/bun)
    "noEmit": true,                  // tsc is the checker; tsdown/vite emit
    "declaration": true,             // needed by tsdown's dts build via project references
    "declarationMap": true,
    "composite": true,
    "incremental": true,
    "skipLibCheck": true,

    // Strictness — every one of these stays on
    "strict": true,
    "noUncheckedIndexedAccess": true,       // arr[i] is T | undefined
    "exactOptionalPropertyTypes": true,     // `{a?: string}` cannot receive `undefined` — see §2.6
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true, // `rec["k"]` for index signatures, `rec.k` for declared props
    "useUnknownInCatchVariables": true,     // implied by strict; stated for clarity
    "allowUnusedLabels": false,
    "allowUnreachableCode": false,

    // Ergonomics
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Why each strictness flag: `noUncheckedIndexedAccess` forces a presence check on every indexed read (array elements, database rows, record lookups), which is where unchecked casts otherwise hide; `exactOptionalPropertyTypes` makes the conditional-spread discipline of §2.6 a compiler rule rather than a convention, which the exact MCP result shapes depend on; `noPropertyAccessFromIndexSignature` stops `Record<string, unknown>` payloads from masquerading as typed objects; `verbatimModuleSyntax` + `isolatedModules` are required by every transpiler in the chain.

### 1.2 Per-package `tsconfig.json`

| Package | `types` | `lib` additions | `jsx` | References |
|---|---|---|---|---|
| `contracts` | `[]` | none | — | none (platform-neutral: no `bun-types`, no DOM, no `node:` imports; enforced by `dependency-cruiser`) |
| `core` | `["bun-types"]` | none | — | `contracts` |
| `browserhive` | `["bun-types"]` | none | — | `contracts`, `core` |
| `dashboard` | `["vite/client"]` | `DOM`, `DOM.Iterable` | `react-jsx` | `contracts` |

Root `tsconfig.json` is `{ "files": [], "references": [ …four packages… ] }`; `bun run typecheck` = `tsc -b --pretty`. Tests are included in each package's program (`src/**/*.ts`, `test/**/*.ts`); there is no separate `tsconfig.test.json`, because a split configuration makes it easy for whole directories (tests, or the dashboard) to fall out of the typechecked program without anyone noticing.

The TypeScript 7 native compiler is the checker used by `bun run typecheck`; TypeScript 5.9, pinned exactly, remains installed for tools that need the JavaScript compiler API. The flag set above is identical under both.

### 1.3 Imports

- Relative imports carry the `.ts` (or `.tsx`) extension: `import { Lease } from './lease.ts'`.
- Cross-package imports use the package name and its `exports` map (`@browserhive/contracts/errors`), never a relative path into another package's `src/`.
- Node built-ins are imported with the `node:` prefix; Bun built-ins with `bun:`.
- `import type` for types; Biome's `useImportType`/`useExportType` are errors.

## 2. Type rules

### 2.1 No `any`, no unchecked casts

- `any` is a Biome error (`noExplicitAny`). `unknown` is the input type of every boundary.
- `as` is allowed only for: `as const`, narrowing after a runtime check that the compiler cannot see (with a one-line comment saying which check), and `satisfies`-style shaping. It is **never** used on a wire payload, an env var, a JSON file, or a DB row. Those are parsed:

```ts
// wrong: the cast asserts a shape nothing has checked
const summary = (await res.json()) as SessionSummary;
// right
const summary = SessionSummarySchema.parse(await res.json());
```

- Non-null assertions (`!`) are a Biome error. Use a narrowing helper (`expect(value, 'why it is present')`) that throws an `AppError` with `INTERNAL_ERROR`.

### 2.2 Branded identifiers

Every id that crosses a boundary is branded in `contracts`:

```ts
export const SessionId = z.string().regex(SESSION_ID_RE).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;
```

Functions that take a `SessionId` cannot be handed a `TabId` or a raw string by accident. Construction happens only through the schema (`SessionId.parse`) or the id generator.

### 2.3 Discriminated unions over class hierarchies

State is a discriminated union with a `kind`/`status`/`type` tag; behavior is a function over the union. The session state machine (D-21), the operator-request outcome, the vault fill decision, the config provenance record, the error registry, and every WS message follow this. Class hierarchies are used only where `instanceof` has a job (`AppError`).

Every `switch` over a union ends in `default: assertNever(value)`:

```ts
export function assertNever(value: never, detail?: string): never {
  throw new AppError('INTERNAL_ERROR', { message: `unhandled variant ${detail ?? JSON.stringify(value)}` });
}
```

### 2.4 `readonly` by default

Domain objects, config, DTOs, and event payloads are `Readonly<>`/`readonly` fields/`ReadonlyArray`. The resolved config is deep-frozen at runtime as well (D-06). Mutation happens through explicit methods on the owning aggregate or by producing a new value.

### 2.5 `Result` for parsing and classification; exceptions for failures

`kernel/result.ts` exports `Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`. Use it for pure parse/classify/decide functions (config parsing, glob matching, URL classification, `decideFill`, tool-outcome classification). Throw `AppError` for failures in services and adapters. Never mix: a function returns `Result` **or** throws, and its TSDoc says which.

### 2.6 `exactOptionalPropertyTypes` discipline

An optional property is either present with a defined value or absent. Never write `{ message: maybeUndefined }` into an optional slot; use a conditional spread:

```ts
return {
  status: outcome.status,
  ...(outcome.message !== null && { message: outcome.message }),
};
```

This is also what keeps the stable MCP result shapes exact: keys such as `message`/`resolved_by` are omitted when absent, never present with `undefined` or `null` (D-12).

### 2.7 Zod at boundaries, and only at boundaries

Boundaries are: MCP tool arguments, HTTP params/query/body, WS inbound frames, config sources, JSON/DB rows on read, third-party process output (`bw`), and (in development) HTTP responses in the dashboard. Inside a layer, values are already typed; re-parsing a domain object is a smell.

Every schema lives in `contracts` (wire/config) or in the adapter that owns the boundary (row schemas in `infra/persistence`, `bw` output in `infra/vault-backends`). Domain enums are `z.enum([...])` in `contracts/enums` with the TS union derived by `z.infer`; the DB `CHECK` constraints and the OpenAPI enums are generated from the same source.

### 2.8 Three type families, explicit mappers

| Family | Where | Casing | Example |
|---|---|---|---|
| Row types | `infra/persistence` (generated by `kysely-codegen --verify`) | snake_case columns | `SessionsTable` |
| Domain types | `domain/` | camelCase | `Session`, `Lease` |
| Wire types | `contracts` (zod) | snake_case (D-05) | `SessionSummary` |

A row never reaches the wire; a wire DTO never reaches the domain. Mappers are total functions in one file per aggregate (`infra/persistence/mappers/session.ts`, `interface/http/serializers/session.ts`) and are unit-tested for round-trips.

### 2.9 Explicit public surface

- `export *` is banned (Biome `noReExportAll`, plus a grep test).
- Each package has one `index.ts` (plus declared subpath entries in `exports`) listing every public symbol by name.
- `test/exports.snapshot.test.ts` in each package snapshots `Object.keys(await import('../src/index.ts')).sort()`; a change requires blessing the snapshot in the same PR and a changeset.

## 3. Naming (D-23)

| Thing | Convention | Example |
|---|---|---|
| Files, directories | kebab-case; test files `*.test.ts` colocated; React components `kebab-case.tsx` exporting a PascalCase component | `lease-sweeper.ts`, `session-detail.tsx` |
| Types, interfaces, classes, enums | PascalCase; no `I` prefix, no `Type` suffix | `SessionHandle`, `AppError` |
| Functions, variables, properties | camelCase | `resolveIdentity`, `leaseExpiresAt` |
| True constants (compile-time literal, module scope) | SCREAMING_SNAKE | `MAX_BLOCKLIST_ENTRIES` |
| Config keys, JSON config | camelCase (D-06) | `maxSessions` |
| Env vars | `BROWSERHIVE_` + SCREAMING_SNAKE (D-06) | `BROWSERHIVE_MAX_SESSIONS` |
| CLI flags | `--camelCase` (D-06) | `--maxSessions` |
| Wire JSON (MCP, REST, WS) | snake_case (D-05) | `session_id`, `lease_expires_at` |
| DB tables, columns | snake_case, plural tables, unit-bearing names | `tool_calls.duration_ms`, `sessions.closed_at`, `retention_bytes` |
| Enums | `z.enum` in `contracts/enums`; values lowercase snake_case | `'lease_expired'` |
| Booleans | `is`/`has`/`can`/`should` prefix | `isLive`, `hasOpenAttention`, `canTakeover` |
| Async functions | return `Promise<T>`; never a custom thenable; named as verbs | `launchSession()` |
| Events on the bus | `noun.verb`, lowercase dotted, past tense for facts | `session.opened`, `tool.called`, `attention.resolved` |
| WS topics | resource name, `:<id>` for instances | `session:shop-a1b2c3d4` |
| Ports (interfaces in `ports/`) | noun describing the capability, no `Port` suffix | `BrowserDriver`, `SessionRepository`, `Clock` |
| Adapters | `<Tech><Port>` | `PlaywrightBrowserDriver`, `SqliteSessionRepository` |
| Timestamps | `*At` (camel) / `*_at` (wire, DB), always epoch ms `number` | `createdAt`, `created_at` |
| Durations | `*Ms` / `*_ms` (never bare) | `durationMs`, `lease_window_ms` |
| Sizes | `*Bytes` / `*_bytes` | `resultBytes` |

## 4. Modules and dependencies between them

### 4.1 Layering

The layer table in `01-overall-architecture.md` §4 is law. `.dependency-cruiser.cjs` (excerpt; the full file is generated from this table and committed):

```js
module.exports = {
  forbidden: [
    { name: 'kernel-is-leaf', from: { path: '^packages/core/src/kernel' },
      to: { path: '^packages/core/src/(domain|ports|infra|app|interface)' } },
    { name: 'domain-no-infra', from: { path: '^packages/core/src/(domain|ports)' },
      to: { path: '^packages/core/src/(infra|app|interface)' } },
    { name: 'infra-no-app', from: { path: '^packages/core/src/infra' },
      to: { path: '^packages/core/src/(app|interface)' } },
    { name: 'app-no-infra', from: { path: '^packages/core/src/app' },
      to: { path: '^packages/core/src/(infra|interface)' } },
    { name: 'interface-no-infra', from: { path: '^packages/core/src/interface' },
      to: { path: '^packages/core/src/infra' } },
    { name: 'playwright-only-in-browsers', from: { pathNot: '^packages/core/src/infra/browsers' },
      to: { path: '^(playwright|patchright)' } },
    { name: 'sqlite-only-in-persistence', from: { pathNot: '^packages/core/src/infra/persistence' },
      to: { path: '^(kysely|bun:sqlite)' } },
    { name: 'contracts-platform-neutral', from: { path: '^packages/contracts' },
      to: { path: '^(node:|bun:|bun-types)' } },
    { name: 'dashboard-only-contracts', from: { path: '^packages/dashboard' },
      to: { path: '^packages/(core|browserhive)' } },
    { name: 'no-circular', from: {}, to: { circular: true } },
  ],
};
```

### 4.2 Wiring

- **Constructor injection, no container.** A service receives a narrow dependency record (an object type listing only what it uses), never the whole `ServerConfig` or a service locator. `composition/` is the only place that knows concrete adapters.
- **Ports in `ports/`.** Any dependency on I/O (browser, DB, filesystem, clock, id generation, random, child processes, network) is an interface in `ports/`; domain and app code import the interface. `Clock` and `IdGenerator` are injected everywhere a time or id is produced — there is exactly one `Date.now()` and one `nanoid()` call site outside tests, both in `infra`.
- **No `process.env` outside `browserhive/src/composition` and the config resolver.** `BW_SESSION`, `LC_ALL`/`LANG`, `DISPLAY`, `NO_COLOR` etc. arrive through an injected `HostEnvironment` record.
- **No mutable module-level state.** Process-wide concerns such as the stdio `console` redirect and the Patchright resolver cache are instance state owned by the composition root, so tests can build several servers in one process and disposal is deterministic; if something must be shared it is explicitly ref-counted and disposed.
- **Runtime objects are built once.** No "patch a slot later": a tool or service that captured a dependency at registration would keep seeing the stale value. If a dependency is optional, the type says `X | null` and the consumer branches.

## 5. Error handling rules (details in `10-error-handling-and-telemetry.md`)

1. Throw `AppError` (from the registry, D-07) in services and adapters; return `Result` from pure functions; return a status value only for task-level outcomes an agent must branch on (`vault_fill`, `request_attention`, `navigate` — frozen by D-12).
2. Every wrap carries `{ cause }`. `String(err)`, `` `${err}` ``, and `err.message` concatenation are banned (grep test); use `serializeError(err)`.
3. Every `catch` does exactly one of: rethrow (wrapped), return `Result.err`, or `logger.warn/error` with `err` and context fields. A `catch {}` with an empty body is a lint error (`noEmptyBlockStatements`).
4. No floating promises: `noFloatingPromises` is on; fire-and-forget is written `void task().catch(reportBackground)`.
5. Background timers never throw out: `setInterval(() => void tick().catch(report), ms)` with per-item isolation inside sweeps.
6. Public vs private messages: what an agent or HTTP client sees is `publicMessage`; host paths, stack frames, and third-party prose stay in the log record.
7. Redaction runs on the error path too (messages, details) before any sink.

## 6. Async rules

- Every I/O call that can hang takes an `AbortSignal` and a deadline (`withDeadline(signal, ms)` in kernel). `create`, `close`, `closeAll`, `launch`, `navigate`, DB drains, `bw` calls, HTTP fetches — all of them.
- Resources use `using` / `await using` and `AsyncDisposableStack` (Bun supports both). A phase that acquires something registers its compensator immediately, before doing the next thing.
- Queues are bounded and their bound is a named constant with a documented drop policy (WS feed buffer, screencast frames, write queue, ring buffer).
- Locks are short and never held across a browser launch or a network call (D-21: reserve → work outside → promote).
- `Promise.allSettled` for fan-out where one failure must not hide the others; results are inspected, never discarded.

## 7. Logging rules (details in `10-error-handling-and-telemetry.md`)

- One logger per module via `logger.child({ module: 'sessions.lifecycle' })`; a module never constructs a `Logger` and never defaults to a silent logger — the composition root injects the real one, tests inject a collecting one.
- Message: lowercase verb phrase, no interpolated values, ≤ 26 characters (Biome custom lint via grep test keeps the pretty renderer aligned). Values go in fields: `log.info('session opened', { sessionId, channel })`, never `` `session ${id} opened` ``.
- Field names are camelCase in code and rendered snake_case by the logger; reserved keys (`ts`, `level`, `msg`, `trace_id`, `span_id`, `request_id`, `session_id`, `principal`, `module`, `err`) cannot be overridden by user fields (namespaced under `data` if they collide).
- Never log secrets. Anything typed `Secret<T>` (brand) refuses to serialize; the redaction pipeline is a second line, not the first.
- Levels: `error` = operator must act; `warn` = degraded but running (every `SessionWarning`); `info` = one line per business event (session opened/closed, tool call, blocked URL, login); `debug` = boundaries and plumbing (CDP, transport, DB drains); `trace` = payloads (off by default, ring-buffer only).

## 8. Dependency management

- Bun workspaces; `bun.lock` committed; `packageManager: "bun@1.4.x"` and `.bun-version` pin the toolchain; `engines.bun >= 1.4`.
- **Exact pins** (no range) for `hono`, `@hono/zod-openapi`, `@hono/mcp`, `@modelcontextprotocol/sdk`, `kysely`, `zod`, `playwright`, `patchright`, `@biomejs/biome`, `typescript`, `tsdown`, `vite`, `@tanstack/*`, `tailwindcss`. Caret for the rest. Reason: each of these has a "minors are majors" or fast-moving release policy and sits on a contract.
- `dependencies` vs `devDependencies` is exact: only what the published `browserhive` package needs at runtime is a dependency (third-party deps are externalized by tsdown and must be declared once, in `packages/browserhive/package.json`; a test asserts that every external import in `dist/` is declared there, so the dependency list is checked rather than copied between manifests that could drift).
- Optional integrations (`patchright`) are `optionalDependencies` resolved fail-open with a logged `warn` and a `doctor` check.
- Licenses: `core`, `contracts`, `browserhive` may depend only on MIT/Apache-2.0/BSD-2/BSD-3/ISC/0BSD/CC0/Unlicense/MPL-2.0-file-level-only-if-unmodified packages. GPL/LGPL/AGPL/SSPL/BUSL are banned, because the published package must be usable in proprietary agent stacks without copyleft or source-available obligations, and are checked in CI with `license-checker-rseidelsohn --onlyAllow`. The dashboard has the same list.
- Adding or upgrading a dependency requires one line in the PR description: what it replaces, why the built-in or existing dep does not do it, license, and weekly downloads/maintenance signal. Renovate keeps pins fresh in grouped weekly PRs (see `06-ci-cd-local-dev.md`).

## 9. In-source documentation

- **TSDoc on every exported symbol**: one-sentence summary, `@param`/`@returns` when non-obvious, `@throws` listing error codes, `@remarks` for invariants. Biome does not check this; the export-snapshot test fails when an exported symbol has no leading doc comment (simple source scan).
- **Module header**: every file begins with `/** @module <layer>/<name> — <one-line responsibility> */`. `dependency-cruiser` reads nothing from it; humans and agents do.
- **"Why" comments** on non-obvious constants and shapes. The following rationales MUST stay next to the code they explain: `scroll` is a flat object + `superRefine` because strict MCP clients reject top-level `oneOf`; channel `chromium` maps to the full Chromium binary, never `chrome-headless-shell`; `acceptLanguage` is unweighted because Chrome appends `q=` itself; Playwright's 1280×720 is absent from the display catalogue; identity context options are spread before caller options so the caller wins; `SESSION_ACCESS_DENIED` mirrors `SESSION_NOT_FOUND` text to avoid existence leaks; `fill`/`drag_and_drop`/`select_option` stay native even under humanize; `zipSync` because fflate's worker path breaks under Bun; `db.exec` never `query().run()` for multi-statement migration SQL.
- **Decision links**: code that implements a decision cites it: `// D-13: tracing is stopped around the fill so the credential never lands in trace.zip`.
- **No commented-out code.** Delete it; git remembers.
- **TODOs** are `// TODO(#123): …` with an issue number; a grep test rejects bare `TODO`/`FIXME`.
- **Docs generated from source** (`docs/configuration.md` table, `docs/errors.md`, tool catalog, OpenAPI) carry a header `<!-- generated by scripts/gen-docs.ts; do not edit -->` and CI fails when regeneration produces a diff.

## 10. Formatting and lint (Biome 2.5)

`biome.json` (essentials):

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.5.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["dist", "coverage", "**/*.gen.ts", "**/routeTree.gen.ts", "packages/core/src/version.ts"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100, "lineEnding": "lf" },
  "javascript": { "formatter": { "quoteStyle": "single", "jsxQuoteStyle": "double", "semicolons": "always", "trailingCommas": "all", "arrowParentheses": "always" } },
  "css": { "parser": { "tailwindDirectives": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error", "noConsole": "error", "noEmptyBlockStatements": "error", "noReExportAll": "error" },
      "style": { "useImportType": "error", "useExportType": "error", "noNonNullAssertion": "error", "useNamingConvention": "off", "noParameterAssign": "error" },
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "error", "useExhaustiveDependencies": "error", "noUndeclaredDependencies": "error" },
      "nursery": { "noFloatingPromises": "error", "useSortedClasses": "off" },
      "a11y": { "recommended": true }
    }
  },
  "overrides": [
    { "includes": ["packages/browserhive/src/cli/output/**"], "linter": { "rules": { "suspicious": { "noConsole": "off" } } } },
    { "includes": ["packages/dashboard/**"], "linter": { "rules": { "a11y": { "useKeyWithClickEvents": "error", "noStaticElementInteractions": "error" } } } }
  ]
}
```

CI runs `biome ci --error-on-warnings`. Tailwind class sorting is not gated (`useSortedClasses` stays off: it mishandles variants).

Rules Biome cannot express live in `packages/core/test/lint/grep-rules.test.ts` (fast, runs in the unit suite): `String(err)` / template-interpolated errors, bare `TODO`, `export *`, `process.env` outside allowed paths, `Date.now()`/`nanoid(` outside `infra`, `console.` outside the CLI output module, log messages longer than 26 characters, `dangerouslySetInnerHTML` anywhere in the dashboard.

## 11. React / dashboard standards (details in `04-admin-frontend.md`)

- Function components only; hooks obey `useExhaustiveDependencies` with no suppressions.
- No inline `style={{}}` (Biome custom grep) and no raw hex/px in components: Tailwind classes over tokens only. New tokens go in `theme.css`, never inline.
- Feature folders: `src/features/<area>/{routes,components,queries,lib}`; shared primitives in `src/components/ui` (shadcn-owned) and `src/components/app` (ours). A component file is ≤ 250 lines; split otherwise.
- Colocated tests (`*.test.tsx`) next to the component; stories are not used.
- `data-testid` only on elements that have no accessible name to query by; prefer `getByRole`.
- Every interactive element is a real `<button>`/`<a>`/input; every overlay is a Base UI primitive (portal, focus trap, dismiss layer).
- State: URL first (TanStack search params), then TanStack Query, then component state. No module-level singletons; the socket, auth, notifications, and theme are providers.
- Wire payloads are parsed with the contracts schemas in development and asserted in production builds (a single `parseWire()` helper decides).

## 12. Anti-pattern catalogue

| Anti-pattern | Why it is harmful | Rule |
|---|---|---|
| God files | A route table, event store or page component that grows past a thousand lines mixes unrelated responsibilities, defeats review and makes every change a merge conflict | Soft limit 400 lines (TS) / 250 (TSX); CI warns, review blocks |
| Stringly-typed config overrides | Typed values stringified only to be re-parsed lose their type, duplicate the grammar and let two parsers disagree | One zod schema, typed layers, no string round-trips (D-06) |
| Hand-rolled JSON validation | Per-field `typeof` checks and `JSON.parse(...) as T` silently accept malformed input (a failed parse becomes `{}`) and never report which field was wrong | zod parse at the boundary; 400 with field errors |
| Context smuggling | Hiding per-call data (an event id) in a prototype-chained copy of a framework context object is invisible to types and breaks when the framework copies the object | Explicit `ToolCallContext` built by the dispatcher (D-12) |
| Monkey-patching globals | Patching `console` to capture one dependency's output misses every other writer and couples correctness to a string prefix | Own the transport; under stdio, `console` is redirected to stderr once by the process owner |
| Presence-only booleans | A flag that can only be set to `true` cannot override a `true` from env or the config file | Every boolean accepts `--key`, `--key=false` (D-06) |
| Duplicated dependency lists | Two manifests declaring the same runtime dependencies drift, and the published package breaks at install time | Declared once; a test checks externals against the manifest |
| Dead config keys | A key that is parsed but never read tells the operator a setting took effect when it did not | Every key has a compile-checked consumer; a test walks the schema keys and asserts a reader exists |
| Silent catch | A swallowed error hides the failure; for a security policy (blocklist route) it fails **open** | §5.3; policy failures fail closed and loudly |
| Rejections in timers | `void sweepOnce()` with no catch turns one transient failure (disk full) into an unhandled rejection that can kill the process | §6; every tick wrapped and isolated |
| Whitelist-and-drop | Unknown sort keys or query parameters that silently fall back make a typo look like a working request with wrong results | Unknown keys/values are 400 errors (`INVALID_ARGUMENTS`) |
| Rows as wire | `SELECT *` serialized directly leaks storage details (`headless: 1`, filesystem paths) and freezes the schema into the API | Row → domain → wire mappers (§2.8) |
| Prototype/structural tricks for fakes | Production casts such as `(this.context as { on?: unknown })` exist only so incomplete test doubles compile, and they weaken the real code's types | Ports have honest fakes that implement the whole interface |
| Module-level singletons in the SPA | Module `let`s and DOM-as-store state leak between tests and between app instances and cannot be reset | Providers + `useSyncExternalStore` stores created per app instance |
| Several spellings of one knob | Hand-written flag, env and file names diverge (`--pretty-logs` vs `--log-pretty` vs `logPretty`) and documentation cannot keep up | One key registry generates all names (D-06) |
| Two truths for one schema | A base DDL string plus hand-synced column patches produce databases whose shape depends on their upgrade path | Migrations are the only schema definition (D-04) |
| `INSERT OR IGNORE` hiding violations | It swallows NOT NULL and foreign-key failures under the name of idempotence | `ON CONFLICT (pk) DO NOTHING` only where idempotence is the intent; constraint errors surface |
| Regex over error prose | Parsing a `[CODE]` prefix or Playwright's English messages breaks silently when the text changes | Structured `AppError.code`; Playwright classification pinned by a test against a vendored message list |
| Unbounded fan-out | Serializing every frame per viewer with no backpressure lets one slow client grow server memory without limit | Bounded buffers with documented drop policy (D-10) |

## 13. Developer experience

- `bun run browserhive --admin` is the main dev loop: the daemon runs from source on its port, and a Vite dev server next to it (`--port` + 10000) serves the dashboard with hot reload, proxying `/api` (WS included), `/mcp`, `/health` and `/trace-viewer` to the daemon (`BHDEV_DAEMON_URL`) with `changeOrigin: false` so the Origin check passes (06 §2.1). `bun run dev` is the same with the server in watch mode. The daemon contains no dev-server code: Vite in front is the standard arrangement, needs no dev-only CSP exception or proxy in the shipped binary, and cannot serve a page that mixes two React bundles. Dev-only variables use the `BHDEV_` prefix because they are not config keys and the CLI rejects unknown `BROWSERHIVE_*` variables.
- Recommended VS Code: Biome (formatter + lint on save), Tailwind CSS IntelliSense, Playwright Test, `bun` VS Code extension. `.vscode/settings.json` and `extensions.json` are committed with `editor.defaultFormatter: biomejs.biome` and `editor.codeActionsOnSave: source.organizeImports.biome`.
- Script naming: `verb[:qualifier]` — `test`, `test:integration`, `test:e2e`, `test:watch`, `gen:openapi`, `gen:docs`, `gen:routes`, `check`, `ci:local`, `release:*`. Package scripts mirror root scripts; root delegates with `bun run --filter`.
- Generated files are committed and checked, never hand-edited: `packages/dashboard/src/routeTree.gen.ts`, `packages/core/src/version.ts`, `packages/contracts/generated/openapi.json`, `docs/reference/*.md` tables, `packages/core/src/infra/persistence/generated/db.d.ts`. CI regenerates and fails on diff. Biome ignores them.

## 14. Definition of done (PR checklist)

- [ ] `bun run check` passes locally (lint, typecheck, depcruise, unit, grep rules, goldens).
- [ ] New/changed behavior has a test at the outermost observable surface (tool result, HTTP response, WS transcript, DB row), not a test of internals.
- [ ] Any wire/schema/config/error change: contracts updated, goldens re-blessed with explanation, docs regenerated, changeset added.
- [ ] No new `any`, `as` on payloads, `!`, `String(err)`, silent catch, floating promise, `process.env` read, or module-level mutable state.
- [ ] Every exported symbol has TSDoc; every new file has a `@module` header; every non-obvious constant has a "why".
- [ ] New dependency justified in the PR body; license allowed; pinned per §8.
- [ ] Dashboard changes: keyboard-operable, tokens only, both themes checked, one screenshot at 390 px and one at ≥1280 px.
- [ ] Decision references (`D-xx`) added where code implements a decision; no decision changed without an update to `00-decisions.md` in the same PR.

## Design notes

- `noUndeclaredDependencies` in Biome flags Bun built-ins (`bun:sqlite`) unless `bun-types` is present in the package; it is, for `core` and `browserhive`. For `contracts` the rule doubles as the platform-neutrality guard.
- `noFloatingPromises` is a nursery rule in Biome 2.5; if it proves noisy on `void` expressions the fallback is the grep test plus `typescript-eslint` in CI only (not as a second formatter).
- The 26-character log message limit is the width of the pretty renderer's message column: a longer message pushes that line's fields out of the aligned field column. The number lives in one constant (`MAX_MESSAGE_LENGTH` in `infra/logging/pretty-renderer.ts`) and the grep test reads it from there.
