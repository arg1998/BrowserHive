# @browserhive/contracts

Platform-neutral wire contracts (zod 4 only, no `node:`/`bun:` imports). Everything a client,
the server and the dashboard agree on is defined here once and imported by name through the
subpath exports.

| Subpath | What lives there |
|---|---|
| `@browserhive/contracts/enums` | one `z.enum` per file (`Channel`, `SessionStatus`, `ClosedReason`, `LogLevel`, …); the TS union is `z.infer` of the schema |
| `@browserhive/contracts/ids` | branded ids and their regexes (`SessionId`, `TabId`, `EventId`, …), `SLUG_RE`, `parseSessionId` |
| `@browserhive/contracts/errors` | `ERROR_REGISTRY` (every code with status, category, retryability, title, exact public message, hint, details schema, docs prose), `ErrorCode`, `ErrorDetails<C>`, `ProblemDetails`, `McpErrorContent`, `httpAuditCode` |
| `@browserhive/contracts/config` | `serverConfigSchema` and `ServerConfig`, the parsers (`zDuration`, `zBytes`, …), `CONFIG_KEYS`, `namesFor`, `keyMeta`, `crossFieldIssues`, `configFileJsonSchema()`, provenance types |
| `@browserhive/contracts/tools` | MCP tool contracts (`TOOL_CONTRACTS`, `ALL_TOOL_NAMES`) |
| `@browserhive/contracts/http` | REST DTOs, `Page<T>`, `HealthResponse` |
| `@browserhive/contracts/ws` | WS envelope, commands, server messages, topics |

The root entry (`@browserhive/contracts`) re-exports every public symbol by name; `test/exports.snapshot.test.ts`
pins that list and fails when an exported declaration lacks a doc comment.

## Adding a config key

1. Pick the group file under `src/config/keys-*.ts` and add `name: key(parser, { default, group, describe, … })`.
   Use an existing parser from `src/config/parsers.ts` (string **or** canonical typed input, canonical output,
   with a `grammar` string) or add one there. Defaults are the canonical typed value; give `defaultText`
   for the human form (`'2h'`). Use `default: derived('hostMemory')` for resolver-computed defaults,
   `optional: true` for keys without a default, `restartRequired: false` for runtime-adjustable keys,
   `secret: true` for values that must render `<redacted>`.
2. Env, CLI and JSON names are derived by `namesFor(key)`; never hand-write them. `test/config.registry.test.ts`
   lists every spec 08 key — add the new key there.
3. Cross-field rules with exact message texts live in `src/config/rules.ts`.
4. Reserved names go in `RESERVED_CONFIG_KEYS` / `RESERVED_ENUM_MEMBERS` (`src/config/registry.ts`).

## Adding an error code

1. Add an entry with `defineError({...})` to the matching `src/errors/codes-*.ts` file (session, page,
   service, boot, auth-transport, audit-warning). The key must equal `code`. Provide `httpStatus`,
   `category`, `retryable`, `title`, the public `message` template (`{slot}` names are `details` keys),
   `hint`, a `z.object` `details` schema, `docs: true`, and `cause` / `resolution` prose (rendered into
   `docs/errors.md`). Boot codes also carry `exitCode`.
2. Add the code to the expected list in `test/errors.registry.test.ts`. Message texts of the core codes are frozen
   because MCP clients and agents may match on them: the test renders them and compares byte-for-byte.
3. `AppError` in core picks the entry up automatically; `ErrorDetails<'NEW_CODE'>` is inferred from `details`.

## Checks

```
node_modules/typescript7/bin/tsc -p packages/contracts
bun test packages/contracts
bunx biome ci --error-on-warnings packages/contracts
bunx depcruise --config .dependency-cruiser.cjs packages/contracts
```
