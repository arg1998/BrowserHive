---
title: "CLI arguments and configuration"
spec: "08"
status: Normative
scope: How BrowserHive is configured through environment variables, `browserhive.config.json` and command-line arguments; the order of acceptance; the complete key table; the command surface of the `browserhive` binary; help and startup output.
audience: Contributors working on the config resolver and the CLI; operators looking for exact semantics.
related:
  - 00-decisions.md
  - 02-mcp-and-tools.md
  - 10-error-handling-and-telemetry.md
  - 12-usage.md
---

# 08 — CLI Arguments and Configuration

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Governing decisions: D-06 (ladder and naming), D-02 (single port), D-08 (telemetry knobs), D-18 (`init`/`doctor`), D-19 (toolchain), D-24 (data dir).

---

## 1. The ladder

Four sources, lowest to highest precedence. **Rightmost wins.**

```
defaults  <  environment (BROWSERHIVE_*)  <  browserhive.config.json  <  CLI arguments
```

Rules:

- A key is *supplied* by a source when the source provides a non-empty value for it. An empty string in env or JSON is a **usage error**, not "unset": treating empty as unset would hide typos such as `BROWSERHIVE_PORT=` in a service file.
- The winning source is recorded per key as its **provenance**: `default`, `env`, `file`, `cli`, or `derived`. `derived` marks a default computed from another key (`trace` from `admin`, `fingerprint` from `stealth`, `maxSessions` from available RAM, `dataDir` from the OS). The derivation source is recorded as `derivedFrom`.
- When a key is supplied by two or more sources, exactly one line is logged at `info` during the `resolve-config` phase, after the schema has accepted the final value:

```
config: maxSessions=8 (cli) shadows config-file=4, env=2
config: logLevel=debug (config-file) shadows env=info
config: authTokens=<redacted> (cli) shadows env=<redacted>
```

Format: `config: <key>=<winningValue> (<winningSource>) shadows <source>=<value>[, <source>=<value>]`, listing the shadowed sources from highest to lowest precedence. Values of keys flagged `secret` render as `<redacted>` on both sides. Values are rendered in the canonical form the parser accepted (`2h`, not `7200000`).

- Shadow lines are emitted once, at startup, to the log stream (stderr under stdio). They are also available afterwards via `browserhive config show` and `GET /api/v1/system/config` with the same provenance model.
- There is no fifth source. Per-session overrides supplied by an agent in `launch_session` (persistence mode, headless, stealth flags…) are tool arguments, not configuration; they are documented in `02-mcp-and-tools.md` and never appear in the config schema.

## 2. Naming and the mechanical mapping

Every key has exactly one canonical camelCase name. The three external spellings are derived mechanically and never hand-written:

| Canonical key | Environment variable | CLI flag | JSON key |
|---|---|---|---|
| `maxSessions` | `BROWSERHIVE_MAX_SESSIONS` | `--maxSessions` | `"maxSessions"` |
| `otelEndpoint` | `BROWSERHIVE_OTEL_ENDPOINT` | `--otelEndpoint` | `"otelEndpoint"` |
| `allowInsecureBind` | `BROWSERHIVE_ALLOW_INSECURE_BIND` | `--allowInsecureBind` | `"allowInsecureBind"` |

Derivation: env = `BROWSERHIVE_` + camelCase split on case boundaries, joined with `_`, upper-cased. CLI = `--` + canonical key. JSON = canonical key. Acronyms are treated as words (`otelEndpoint`, not `OTelEndpoint`), so the mapping stays reversible.

CLI flags are matched **case-sensitively**. `--max-sessions` and `--maxsessions` are unsupported spellings: they fail fast (§4) with a hint naming `--maxSessions` (§5.5).

### 2.1 Value grammars

One parser per grammar, defined once in `contracts/config/parsers.ts`, shared by all three sources.

| Grammar | Accepted forms | Notes |
|---|---|---|
| boolean | `true`, `false`, `1`, `0`, `yes`, `no` (case-insensitive) | CLI: `--admin` means `true`; `--admin=false` sets false; `--noAdmin` sets false. `--admin false` (space-separated) is **not** accepted for booleans, so `browserhive --admin serve` can never swallow a positional. |
| duration | `<int>` + unit `ms` \| `s` \| `m` \| `h` \| `d`; bare integer = **milliseconds** | Applies to every duration key, including `minAttentionWait`: one grammar everywhere means a bare number never has a key-specific unit. `0` is allowed where documented. |
| bytes | `<int>` + unit `B` \| `KiB` \| `MiB` \| `GiB` \| `KB` \| `MB` \| `GB`; bare integer = bytes | Binary units are powers of 1024, decimal units powers of 1000. |
| integer | decimal, optional leading `-` | Range checked per key. |
| port | integer 1–65535 | `0` is accepted only by the programmatic API (ephemeral port for tests). |
| host | IPv4 literal, IPv6 literal (with or without brackets), or hostname per RFC 1123 | Validated with `node:net.isIP` and a hostname regex; `127.evil.example` is a hostname, not loopback. One shared `isLoopbackHost` (`localhost`, `127.0.0.0/8`, `::1`, `[::1]`). |
| enum | exact member, case-sensitive | Error lists the members. |
| path | any string; relative paths resolve against **cwd** for CLI and env, and against **the config file's directory** for JSON | Resolved absolute path is what the provenance shows. |
| list | env/CLI: comma-separated, whitespace trimmed, empty items rejected; JSON: array of strings | |
| map | env/CLI: `k=v,k2=v2` (first `=` splits); JSON: object of strings | Used by `otelHeaders`. |
| url | absolute `http:`/`https:` URL | |
| string | as-is | Secrets are strings with `secret: true`. |

Every parser produces a **canonical value** (`number` of ms, `number` of bytes, resolved path) and keeps the original text for provenance rendering.

## 3. The config file

- File name: `browserhive.config.json`. Format: **plain JSON** (no comments, no trailing commas). JSONC was considered and rejected: it would need a second parser and the generated JSON Schema is the editor-assistance mechanism instead.
- Discovery order, first hit wins: `--config <path>` (or `BROWSERHIVE_CONFIG`) → `./browserhive.config.json` (cwd) → `<data-dir>/browserhive.config.json`. When `--config` is given and the file does not exist, that is a usage error (exit 64). When the discovered candidates do not exist, the file layer is simply absent.
- `dataDir` is needed to find the third candidate. It is therefore resolved in a **pre-pass** from defaults, env, and CLI only; a `dataDir` inside a config file discovered via cwd or `--config` is honored, but a config file found *in* the data dir may not change `dataDir` (usage error: `config: dataDir cannot be set from a config file located in the data dir`).
- The file may contain `"$schema": "./browserhive.schema.json"`; `$schema` is the only key outside the schema that is tolerated. `browserhive config schema` prints the JSON Schema (generated from the zod schema with `z.toJSONSchema`), and the docs site hosts a versioned copy.
- Unknown keys fail fast (§4). Keys are checked with the same "did you mean" matcher as CLI flags.
- Secrets in the file (`authTokens`) are accepted but `doctor` warns when the file mode is broader than `0600`.

Example:

```json
{
  "$schema": "./browserhive.schema.json",
  "transport": "http",
  "host": "127.0.0.1",
  "port": 9876,
  "admin": true,
  "auth": "token",
  "persistence": "persistent",
  "maxSessions": 6,
  "sessionLease": "2h",
  "attentionTimeout": "6h",
  "minAttentionWait": "30m",
  "stealth": "standard",
  "humanize": true,
  "vault": "bitwarden",
  "blocklist": "./blocklist.txt",
  "blocklistWatch": true,
  "retentionDays": 14,
  "retentionBytes": "2GiB",
  "logLevel": "info,sessions=debug",
  "logFormat": "auto",
  "otel": true,
  "otelEndpoint": "http://127.0.0.1:4318",
  "otelServiceName": "browserhive-lab"
}
```

## 4. Fail-fast rules

All configuration failures are detected before any port is bound, any browser is launched, or the database is opened. The process prints one message to stderr and exits.

| Situation | Exit | Message shape |
|---|---|---|
| Unknown CLI flag | 64 | `browserhive: unknown flag '--maxSession'. Did you mean '--maxSessions'? Run 'browserhive --help'.` (unsupported spellings such as `--max-sessions` get the same shape, §5.5) |
| Unknown `BROWSERHIVE_*` env var | 64 | `browserhive: unknown environment variable 'BROWSERHIVE_MAX_SESSION'. Did you mean 'BROWSERHIVE_MAX_SESSIONS'?` |
| Unknown key in config file | 64 | `browserhive: unknown key 'maxSession' in /path/browserhive.config.json. Did you mean 'maxSessions'?` |
| Reserved key set (§5.4) | 64 | `browserhive: 'proxy' is reserved for a future release and cannot be set.` |
| Invalid value | 64 | `browserhive: invalid value for --sessionLease: '2 hours'. Expected a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds.` |
| Empty value | 64 | `browserhive: BROWSERHIVE_PORT is set but empty. Unset it or provide a value.` |
| Cross-field violation | 64 | one of the exact texts below |
| Policy refusal (security guard) | 3 | `browserhive: [INSECURE_BIND_REFUSED] Refusing to bind 0.0.0.0 without authentication. Set auth=token, or set allowInsecureBind=true to accept the risk.` |
| Config file unreadable / invalid JSON | 64 | `browserhive: cannot read /path/browserhive.config.json: <reason>` |
| Missing subcommand argument | 64 | `browserhive: 'db restore' requires a file argument.` |

"Did you mean" uses Damerau-Levenshtein distance ≤ 2 (or a case-insensitive exact match) over the key registry. Every unknown item is reported (all of them, not just the first) before exiting.

### 4.1 Cross-field validations (all in one `superRefine`)

Exact message texts; the key names in messages use the canonical camelCase form.

1. `minAttentionWait must be less than attentionTimeout (got minAttentionWait=45m, attentionTimeout=30m). Set minAttentionWait=0 to disable the floor.` — enforced only when `minAttentionWait > 0`.
2. `humanize=true requires stealth to be 'standard' or 'max' (got stealth=off).`
3. `fingerprint=true requires stealth to be 'standard' or 'max' (got stealth=off).` — only when `fingerprint` was supplied explicitly; the derived default never triggers it.
4. `captcha=attention requires admin=true and transport=http, because CAPTCHA hand-off needs the dashboard.` — only when `captcha` was supplied explicitly (the default `attention` degrades silently to "no captcha handling" without admin, so a plain `browserhive` start never fails on a knob the operator did not touch).
5. `admin=true requires transport=http. The dashboard is not available under stdio.` — reported as the `ADMIN_REQUIRES_HTTP` policy refusal: exit 3 with the code prefix, because it is a documented error code.
6. `auth=token requires transport=http. Under stdio every caller is the local principal.` — rejected rather than half-applied, since there is no bearer to check on a stdio pipe.
7. `otelEndpoint, otelProtocol, otelHeaders, otelServiceName and otelSampleRatio require otel=true.` — reported once, naming the keys that were actually set.
8. `trustedProxies requires a non-loopback host; on a loopback bind X-Forwarded-For is never trusted.`
9. `screenshotTrace=true requires trace=true.`
10. `blocklistWatch=true requires blocklist to be set.`
11. Non-loopback `host` without `auth=token` and without `allowInsecureBind` → `INSECURE_BIND_REFUSED` (exit 3, text above). With `allowInsecureBind=true` the server starts and the banner carries a red warning.

## 5. The key table

Columns: key · type / grammar · default · validation · consumer · boot/runtime. Env, CLI and JSON names are mechanical (§2) and omitted. **Boot** keys require a restart; **runtime** keys may be changed through `PATCH /api/v1/system/config` (the runtime-adjustable keys are `logLevel`, `logFormat` colour and `otelTraceUrlTemplate`; everything else is boot).

### 5.1 Server and transport

| Key | Type | Default | Validation / notes | Consumer | Mode |
|---|---|---|---|---|---|
| `config` | path | — | Config file path; CLI/env only (a config file cannot point at another). | resolver | boot |
| `transport` | enum `http` \| `stdio` | `http` | | composition | boot |
| `host` | host | `127.0.0.1` | validated address; loopback check drives the bind guard | Bun.serve | boot |
| `port` | port | `9876` | | Bun.serve | boot |
| `auth` | enum `off` \| `token` | `off` | `token` ⇒ bearer required on `/mcp`, ownership enforced | auth chain, dispatcher | boot |
| `authTokens` | list of `name:token` · **secret** | `[]` | env-preferred; each token ≥ 32 chars; merged with stored tokens, never persisted; rendered `<redacted>` | token provider | boot |
| `allowInsecureBind` | boolean | `false` | acknowledges a non-loopback bind without auth | bind guard | boot |
| `trustedProxies` | list of CIDR/IP | `[]` | `X-Forwarded-For` honored only from these peers | http middleware | boot |
| `allowedHosts` | list of host names / IP literals (no port) | `[]` | extra names the `Host` check accepts besides loopback and `host` (03 §2); ports are ignored, so one entry covers a proxy on 443 and a port mapping alike; also valid on a loopback bind (a same-machine proxy that preserves `Host`) | host guard, `/mcp` | boot |
| `admin` | boolean | `false` | enables dashboard, REST, WS, trace viewer; requires http | composition | boot |
| `dataDir` | path | OS default (D-24) | absolute after resolution; created 0700 | DataDir | boot |
| `shutdownTimeout` | duration | `20s` | total budget for graceful stop (listeners 2 s → sessions → storage) | composition | boot |
| `sessionCloseTimeout` | duration | `10s` | per-session close/trace-finalize cap | session service | boot |

### 5.2 Sessions and browsers

| Key | Type | Default | Validation / notes | Consumer | Mode |
|---|---|---|---|---|---|
| `persistence` | enum `memory` \| `persistent` \| `storage-state` | `memory` | default mode; per-session `persistence_mode` overrides | session service | boot |
| `defaultHeadless` | boolean | `true` | per-session `headless` overrides | session service | boot |
| `defaultChannel` | enum `chromium` \| `chrome` \| `edge` | `chromium` | per-session `channel` overrides | session service | boot |
| `sandbox` | enum `auto` \| `on` \| `off` | `off` | Chromium's sandbox (§5.6): `auto` sandboxes each browser where it can and falls back where it cannot, warned once per executable; `on` requires it: the boot preflight refuses to start (`SANDBOX_UNAVAILABLE`, exit 3) and a session whose browser cannot sandbox fails with the same code, `retryable: never`; `off` never uses it (the behaviour before the key existed). An agent's `launch_options.chromiumSandbox: true` makes the sandbox required for that session | sandbox policy | boot |
| `maxSessions` | integer ≥ 1 \| `unbounded` | derived: `min(floor(ramGiB / 1.5), 20)`, min 1, where `ramGiB` is host RAM capped by the smallest cgroup memory limit on the process's cgroup and its ancestors (v2 `memory.max`, v1 `memory.limit_in_bytes`; Linux only) — a container or a systemd `MemoryMax=` slice would otherwise admit sessions for memory it can never get | provenance `derived` (`derivedFrom: hostMemory`); `unbounded` accepted, discouraged in `doctor` | admission policy | boot |
| `sessionLease` | duration ≥ `1m` | `2h` | sliding inactivity lease | lease | boot |
| `attentionTimeout` | duration ≥ `1m` | `6h` | server cap on `request_attention` | operator-request broker | boot |
| `minAttentionWait` | duration | `30m` | `0` disables the floor; must be `< attentionTimeout`; injected into the tool description | attention tool | boot |
| `allowEvaluate` | boolean | `true` | enforced: `false` makes `evaluate` return `EVALUATE_DISABLED` for every session | dispatcher policy | boot |
| `stealth` | enum `off` \| `standard` \| `max` | `standard` | `max` ⇒ `fingerprint` default true | launcher | boot |
| `stealthDriver` | enum `auto` \| `patchright` \| `playwright` | `auto` | a full key in all three sources, so the driver is visible in provenance; `auto` = Patchright if resolvable, else Playwright (fail-open, logged); `playwright` forces stock Playwright; `patchright` makes Patchright mandatory (`BROWSER_NOT_INSTALLED` when unresolvable) | chromium resolver | boot |
| `fingerprint` | boolean | derived from `stealth` (`true` iff `max`) | explicit true requires stealth ≠ off | launcher | boot |
| `humanize` | boolean | `false` | requires stealth ≠ off | interaction tools, vault typer | boot |
| `captcha` | enum `attention` \| `off` | `attention` | `solver` is a reserved member (§5.4) that fails fast until a solver exists; `attention` stays the default so the dashboard tile and `server_status` field keep one meaning | runtime info | boot |
| `blocklist` | path | — | file read at startup; unreadable ⇒ fatal (`BLOCKLIST_LOAD_FAILED`, exit 3) | blocklist service | boot |
| `blocklistWatch` | boolean | `false` | debounced file watcher + `POST /api/v1/blocklist/reload` (D-22) | blocklist service | boot |
| `vault` | enum `off` \| `bitwarden` | `off` | `local`, `onepassword`, `http` reserved (§5.4) | vault subsystem | boot |

### 5.3 Observability, recording, retention

| Key | Type | Default | Validation / notes | Consumer | Mode |
|---|---|---|---|---|---|
| `logLevel` | level spec | `info` | `error` \| `warn` \| `info` \| `debug` \| `trace`, optionally followed by `,module=level` pairs (`info,sessions=debug,http=warn`); module names come from the logger registry, unknown module ⇒ usage error | logger | **runtime** |
| `logFormat` | enum `auto` \| `json` \| `pretty` | `auto` | `auto` = pretty when the log stream is a TTY and transport ≠ stdio, else json; the one knob for the renderer | logger | runtime (colour only) |
| `color` | enum `auto` \| `always` \| `never` | `auto` | `auto` honors `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, TTY | logger, CLI output | boot |
| `trace` | boolean | derived from `admin` | Playwright trace per session | session service | boot |
| `screenshotTrace` | boolean | `false` | JPEG after each tool call; requires `trace` | recorder | boot |
| `screencastQuality` | integer 1–100 | `60` | JPEG quality of the live view | live view | boot |
| `recordToolResults` | enum `full` \| `shape` \| `none` | `full` | D-20; `shape` stores key names and sizes, `none` stores sizes only | recorder | boot |
| `retentionDays` | integer ≥ 1 | `7` | `0` is rejected: zero reads as "keep forever" to some operators and as "delete immediately" to others, so "keep longer" is expressed as a large number. Audit-class rows have their own retention (03) | retention | boot |
| `retentionBytes` | bytes ≥ `64MiB` | `1GiB` | | retention | boot |
| `backupsKeep` | integer ≥ 1 | `5` | pre-migration backups to retain (D-04) | migration runner | boot |
| `otel` | boolean | `false` | installs the OTel SDK, exporters and context manager | telemetry | boot |
| `otelEndpoint` | url | `http://127.0.0.1:4318` | OTLP/HTTP base; `/v1/traces`, `/v1/metrics`, `/v1/logs` appended | telemetry | boot |
| `otelProtocol` | enum `http/protobuf` \| `http/json` | `http/protobuf` | | telemetry | boot |
| `otelHeaders` | map · **secret** | `{}` | e.g. `Authorization=Bearer …`; redacted in provenance | telemetry | boot |
| `otelServiceName` | string | `browserhive` | `service.name` resource attribute | telemetry | boot |
| `otelSampleRatio` | number 0–1 | `1` | parent-based ratio sampler | telemetry | boot |
| `otelTraceUrlTemplate` | string | none | dashboard deep-link template for a trace, e.g. `https://grafana.local/explore?traceId={trace_id}`; `{trace_id}` is substituted; only used by the dashboard | telemetry | runtime |

Standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG` are read as a **sub-source below `BROWSERHIVE_*` env** (provenance `env(otel)`), so an operator with a standard collector setup only needs `--otel`. They never enable telemetry by themselves.

### 5.4 Reserved keys (rejected if set)

These names are registered so that typos and premature use fail fast with the reserved-key message. They have no behavior: `proxy`, `proxies`, `proxyRotation`, `notifications`, `notificationChannels`, `otelMetricsInterval`, `captchaSolver`, `extensions`, `profiles`, `resourceBudget`, `tenant`. Reserved enum members: `vault=local|onepassword|http`, `captcha=solver`, `persistence=blueprint`, `transport=ws`.

### 5.5 Unsupported spellings

Only the mechanical names of §2 are accepted. Some other spellings are common enough in operator habits and other tools that the resolver recognises them and answers with a targeted hint instead of a generic "unknown" (exit 64, all problems reported together). The alias table is `KEY_ALIASES` in `packages/contracts/src/config/registry.ts`; matching is in `core/src/app/config/suggest.ts`.

| Spelling | Answer |
|---|---|
| kebab-case or snake_case flags and file keys (`--max-sessions`, `--dry-run`, `max_sessions`) | converted to camelCase and, when that matches a key or command flag case-insensitively, `Did you mean '--maxSessions'?` |
| `--pretty-logs`, `--log-pretty`, `BROWSERHIVE_LOG_PRETTY` | `Did you mean '--logFormat'?` (or the env / JSON spelling for that source) |
| `BROWSERHIVE_DISABLE_PATCHRIGHT` | `Did you mean 'BROWSERHIVE_STEALTH_DRIVER'?` |
| `--admin-bind`, `--admin-port`, `BROWSERHIVE_ADMIN_BIND`, `BROWSERHIVE_ADMIN_PORT` | no equivalent key; the hint states that the dashboard shares `--host` and `--port` (D-02) |
| anything else | Damerau-Levenshtein suggestions per §4 |

Because `serve`, `config validate` and `doctor` all run the same resolver, they report these identically. `NODE_ENV` is not read: the log renderer is chosen only by `logFormat`.

## 6. How the schema drives everything

One zod object in `packages/contracts/src/config/schema.ts` is the sole definition:

```ts
export const serverConfigSchema = z.object({
  maxSessions: key(zMaxSessions, {
    default: derived('hostMemory'),
    group: 'sessions',
    describe: 'Maximum concurrent browser sessions. Derived from available RAM when unset.',
  }),
  otelHeaders: key(zMap, { default: {}, group: 'telemetry', secret: true, describe: '…' }),
  // …
}).superRefine(crossFieldRules);
```

`key(schema, meta)` attaches metadata via zod's `.meta()`: `group` (help section), `secret`, `restartRequired`, `reserved`, `derivedFrom`, `examples`. The env/CLI/JSON names are **not** stored; they are derived by `namesFor(key)` and asserted unique by a test.

Parsers (`contracts/config/parsers.ts`): `zBool`, `zDuration`, `zBytes`, `zPort`, `zHost`, `zPath`, `zList`, `zMap`, `zUrl`, `zLevelSpec`, `zMaxSessions`. Each is a zod schema that accepts a string **or** the canonical typed value (JSON may supply numbers/booleans/arrays directly) and outputs the canonical value. Each carries a human-readable grammar string used in error messages.

Resolver (`core/src/app/config/resolve.ts`, pure, injected `env`, `argv`, `cwd`, `fs`, `hostMemory`):

1. **Collect** raw layers: `defaults` (from schema), `env` (all `BROWSERHIVE_*` plus the OTEL sub-source), `file` (discovered per §3), `cli` (parsed argv). Each layer is `Map<canonicalKey, { raw, source, location }>`.
2. **Normalize keys**: env and CLI spellings are converted to canonical keys through the registry; anything not in the registry is collected as unknown (with suggestions) and reported together.
3. **Parse per source** with the key's parser; failures are collected with source and location (`--sessionLease`, `BROWSERHIVE_SESSION_LEASE`, `file:/path#sessionLease`).
4. **Merge with provenance**: walk keys; the highest-precedence supplied value wins; every lower supplied value is recorded as shadowed. Unsupplied keys take `default` or `derived(...)` (computed after the merge, in dependency order: `stealth → fingerprint`, `admin → trace`, `hostMemory → maxSessions`, `platform → dataDir`).
5. **Validate**: `serverConfigSchema.parse(merged)` including `superRefine`; then the policy guards (`INSECURE_BIND_REFUSED`, `ADMIN_REQUIRES_HTTP`, `BLOCKLIST_LOAD_FAILED` after reading the file).
6. **Freeze**: return `Readonly<ResolvedConfig>` (deep-frozen) plus `Provenance` (per-key source, shadowed list, raw text) and `Diagnostics` (shadow lines to log).

Test plan for the resolver (see `09-testing.md`): a table-driven suite where each row is `{ env, file, argv } → expected value + provenance + shadow lines | expected error text`; property test that env/CLI/JSON spellings round-trip through `namesFor`; a test that every key with a default has a consumer (a static list of consumers is asserted against the registry so a key that is parsed but never read cannot ship); a docs-gate test that every key appears in `docs/configuration.md` (generated) and in `--help`.

Generation from the schema: `--help` (§7.2), `browserhive config schema` (JSON Schema draft 2020-12 with `description`, `default`, `enum`, `x-browserhive-env`, `x-browserhive-cli`), `docs/configuration.md` tables (`scripts/gen-docs.ts`, committed and diffed in CI), and the `GET /api/v1/system/config` response schema (OpenAPI component `ServerConfigView` = schema with secrets replaced by `{ redacted: true }`).

## 7. The command surface

```
browserhive [serve] [flags]            start the server (default command)
browserhive init [flags]               install browsers, create the data dir, verify the host
browserhive doctor [flags]             diagnose the host and configuration
browserhive purge [flags]              delete local state (inventory, then confirmation)
browserhive config show|schema|validate
browserhive db status|backup|restore <file>|migrate
browserhive admin reset-password
browserhive admin tokens list|create <principal>|revoke <principal>
browserhive version | --version | -v
browserhive --help | -h                 (also per command)
```

Positional rules: the first argument is the command if it is a known command word; otherwise `serve` is assumed and everything is flags. Commands accept only their own flags; a server flag on `purge` is a usage error, so a destructive command never silently ignores an argument the operator thought applied. `--help` wins over everything including errors; `--version` wins over everything except `--help`. `--` ends flag parsing.

### 7.1 Commands

**`serve`** — resolves config, runs the composition root (`01-overall-architecture.md` §6), prints the banner (§8), waits for a signal. All keys in §5 apply.

**`init`** — the one-time setup that replaces any `postinstall` (D-18). Steps, each idempotent and reported with ✓/✗: create the data dir (0700) and subdirectories; run `playwright install chromium` (respecting `PLAYWRIGHT_BROWSERS_PATH`); if `stealthDriver` is `auto`/`patchright`, run `patchright install chromium`; open/create the database and apply migrations; write `browserhive.schema.json` next to a discovered config file if `--writeSchema`; print next steps (`browserhive`, `browserhive --admin`, docs link). Flags: `--browsers chromium` (only member today; `chrome`/`edge` are branded channels installed by the OS), `--force` (re-download), `--dataDir`, `--config`, `--stealthDriver`. Network is required only for the browser download; a missing browser at first `launch_session` later produces `BROWSER_NOT_INSTALLED` naming `browserhive init`.

**`doctor`** — prints a table and exits 0 (all ✓), 1 (any ✗), or 2 (warnings only). Checks: Bun version ≥ 1.4; Chromium present for the resolved `stealthDriver` (Playwright and Patchright paths, exact versions); data dir exists, owner-only permissions, free disk; config file found and valid (runs the full resolver and prints shadow lines); port free on the resolved host; `bw` CLI on PATH when `vault=bitwarden`; unrecognised data files in the data dir (check `unrecognised data files`, warning: "unrecognised data file 'events.db' found; BrowserHive does not read or migrate it"); database opens, `user_version`, `min_reader_version`, pending migrations, last backup; OTLP endpoint reachable when `otel=true` (HEAD request, 2 s timeout, warning only); `maxSessions` vs available RAM sanity; `authTokens` supplied via a config file with mode broader than 0600 (warning). `--json` emits the same as an array of `{ check, status, detail }`.

**`purge`** — resolves only `dataDir` (so a broken config file can never prevent starting over); prints an inventory (row counts per table via a read-only, non-migrating connection; directory sizes; absolute paths; total); default targets are the database (+ WAL/SHM) and `sessions/`; `--all` adds auth states, uploads, backups and admin credentials; the vault policy tables live in the database and are dropped with it, so the inventory states that vault bindings are lost; requires typing `YES`; `--all` asks a second `YES`; `--dryRun` prints and exits 0; `--yes` skips prompts; without a TTY and without `--yes` it refuses (exit 1); warns when open sessions exist in the DB. `--dry-run` is an unsupported spelling answered with a hint naming `--dryRun` (§5.5).

**`config show`** — prints the effective configuration as a table: key, value (secrets `<redacted>`), source, shadowed sources; `--json` prints `{ key: { value, source, shadowed: [...] } }`. `config schema` prints the JSON Schema. `config validate [--config path]` runs the resolver and exits 64 on error, printing exactly what `serve` would.

**`db status`** — `user_version`, `min_reader_version`, `application_id`, pending migrations, size, page count, last backup, integrity check (`PRAGMA quick_check`). `db backup [--out path]` runs `VACUUM INTO`. `db restore <file>` refuses while a server holds the lock, verifies `application_id`, backs up the current file first, replaces it. `db migrate [--dryRun]` applies pending migrations (normally done by `serve`; useful in CI and before a version downgrade to inspect).

**`admin tokens list | create <principal> | revoke <principal>`** — manages agent bearer tokens for `auth=token` (D-09). Tokens are stored hashed, so `create` is the only time the plaintext is shown; `list` shows principal, public prefix, created/last-used timestamps; `revoke` is immediate. Works against the database directly (refuses while the server is running, lock file) or via the REST API when a server is up (`--url`, cookie/bearer). Output is a table, `--json` for scripts.

**`admin reset-password`** — generates a new seed password, marks `must_change_password`, prints it once, refuses while the server is running (lock file), writes `admin/credentials.txt` (0600).

**`version`** — `browserhive 0.1.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright 1.63.0|not installed)`; `--json` for machines.

### 7.2 Help text

Generated from the schema and the command registry; never hand-written. Layout (width-aware, wraps at the terminal width, min 60, max 120):

```
browserhive 0.1.0 — local-first stealth browser MCP server

USAGE
  browserhive [serve] [flags]
  browserhive <command> [flags]

COMMANDS
  serve      Start the MCP server (default)
  init       Install browsers and prepare the data directory
  doctor     Check the host, browsers, and configuration
  purge      Delete local state after an inventory and confirmation
  config     Show, validate, or export the configuration schema
  db         Inspect, back up, restore, or migrate the database
  admin      Administrative actions (reset-password, tokens)
  version    Print version information

FLAGS — server
  --transport <http|stdio>     Transport to serve.                 default: http     env: BROWSERHIVE_TRANSPORT
  --host <address>             Bind address.                       default: 127.0.0.1
  --port <1-65535>             Bind port.                          default: 9876
  --admin                      Enable the dashboard (http only).   default: false
  ...
FLAGS — sessions
  --maxSessions <n|unbounded>  Concurrent session cap.             default: derived from available RAM
  ...
FLAGS — telemetry
  --otel                       Export traces, metrics, logs via OTLP.  default: false
  ...

Precedence: defaults < environment < browserhive.config.json < flags (rightmost wins).
Docs: https://browserhive.ai/docs/configuration
```

Colour (picocolors): command and flag names bold, types dim, defaults cyan, env names dim, section headers underlined. Colour is suppressed by `color=never`, `NO_COLOR`, or a non-TTY stdout. `--help` always writes to stdout even under `--transport stdio` (help never starts a transport).

### 7.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | success; clean shutdown after a signal |
| 1 | fatal runtime error (boot phase failure after config, unhandled corruption, `purge` failure, `doctor` failure) |
| 2 | `doctor` warnings only |
| 3 | policy refusal at startup (`INSECURE_BIND_REFUSED`, `ADMIN_REQUIRES_HTTP`, `BLOCKLIST_LOAD_FAILED`, `PORT_IN_USE`, `DB_NEWER_THAN_BINARY`) — printed as `[CODE] message` |
| 64 | usage error (unknown flag/key, invalid value, cross-field violation, missing argument) |
| 130 | terminated by a second SIGINT before graceful shutdown completed |

### 7.4 Output discipline

- Under `transport=stdio`, **stdout carries only MCP frames**. Banners, shadow lines, logs and warnings go to stderr. A global guard replaces `console.*` with the logger (stderr) for the whole process so a dependency can never corrupt the stream.
- Under `transport=http`, human output (banner, pretty logs) goes to stdout when it is a TTY; JSON logs go to stderr so `browserhive 2> logs.jsonl` works while the banner stays readable on the terminal.
- Commands other than `serve` write their primary output to stdout and diagnostics to stderr, so `browserhive config show --json | jq` works.

## 8. Startup output

Printed once the `ready` phase is reached (never before the listener is bound):

```
 BrowserHive 0.1.0  ·  bun 1.4.2  ·  patchright 1.63.0
 MCP        http://127.0.0.1:9876/mcp            (auth: token)
 Dashboard  http://127.0.0.1:9876/               (admin)
 Data dir   /home/me/.local/share/browserhive     (db v7, 12 MiB, 3 backups)
 Config     env:2  file:/home/me/browserhive.config.json:9  cli:1
 Sessions   cap 8 (derived from 12 GiB RAM) · lease 2h · persistence memory
 Stealth    standard · patchright · humanize on · fingerprint off
 Telemetry  otel → http://127.0.0.1:4318 (http/protobuf)
 Vault      bitwarden (locked)

 config: maxSessions=8 (cli) shadows config-file=4
 admin:  first-run password: Kq7…  (also in /home/me/.local/share/browserhive/admin/credentials.txt)
 agent:  bearer token for principal agent-1: mT4…  (saved to the database; shown once)
 Press Ctrl-C to stop.
```

Rules: colour per `color`; the seed password and seeded agent token are printed exactly once (first run) and never logged; the non-loopback warning is a red block; when `transport=stdio` the banner is two lines on stderr. Log line format and levels are specified in `10-error-handling-and-telemetry.md`.

## 9. Programmatic API

`createServer(options: CreateServerOptions)` in `browserhive` accepts the **typed** camelCase keys of the schema directly (`{ port: 9876, admin: true, sessionLease: '2h' | 7_200_000 }`), never strings that are re-parsed. The options object is one source with provenance `cli` (it plays the role of flags); `env` (default `process.env`, `{}` isolates), `configFile: false | string` (default: discovery per §3), `output: { stdout, stderr }` sinks, `logger` (external sink adapter), and `hostMemory` (for tests) are the only extra fields. `createServer` resolves and validates eagerly (throws `ConfigError` with the same messages as the CLI), then returns `{ config, provenance, url, listen(), stop(deadline?) }`.

## 10. Scenario examples

| Scenario | Command |
|---|---|
| S1 just run it | `browserhive` |
| S1 stdio fallback | `browserhive --transport stdio` |
| S2 persistent sessions, two agents | `browserhive --persistence persistent --maxSessions 2` |
| S3 watch the agents | `browserhive --admin` |
| S4 vault-backed login | `bw login && export BW_SESSION="$(bw unlock --raw)" && browserhive --admin --vault bitwarden` (or start without `BW_SESSION` and paste the token on the Vault page) |
| S5 replay yesterday | `browserhive --admin` then Sessions → Open trace |
| S6 keep agents off sites | `browserhive --admin --blocklist ./blocklist.txt --blocklistWatch` |
| S7 start over | `browserhive purge` (`--all` to also drop saved logins and credentials) |
| LAN exposure | `browserhive --host 0.0.0.0 --auth token --admin` |
| Telemetry | `browserhive --admin --otel --otelEndpoint http://collector:4318` |
| Env-only deployment | see below |

```sh
# .env for a service manager (systemd EnvironmentFile, docker --env-file)
BROWSERHIVE_TRANSPORT=http
BROWSERHIVE_HOST=0.0.0.0
BROWSERHIVE_PORT=9876
BROWSERHIVE_AUTH=token
BROWSERHIVE_AUTH_TOKENS=ci-runner:REPLACE_WITH_32_PLUS_CHARS
BROWSERHIVE_ADMIN=true
BROWSERHIVE_DATA_DIR=/var/lib/browserhive
BROWSERHIVE_LOG_FORMAT=json
BROWSERHIVE_OTEL=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

## Design notes

- `minAttentionWait` uses the shared duration grammar, so a bare number is milliseconds like every other duration (D-06: every value typed). Operators who mean minutes write `30m`, which is also the default.
- Per-module verbosity is part of the `logLevel` level-spec grammar (`info,sessions=debug`, with a `trace` level below `debug`) rather than a separate key, so there is one knob for verbosity and it is runtime-adjustable as a whole (10 §4.1).
- A config file found in the data dir may not set `dataDir` (§3): otherwise the file could relocate the directory it was discovered in, making discovery non-deterministic.
- `admin tokens list|create|revoke` (§7.1) is the CLI surface for bearer tokens (D-09), and `otelTraceUrlTemplate` (§5.3) is the dashboard's link into an APM (D-08).
