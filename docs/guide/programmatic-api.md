# Programmatic API

Embed BrowserHive in your own Bun program, test harness or service with `createServer`. It uses the same configuration schema and startup sequence as the CLI.

```ts
import { createServer } from 'browserhive';

const server = await createServer({
  transport: 'http',
  host: '127.0.0.1',
  port: 9876,
  admin: true,
  auth: 'token',
  vault: 'bitwarden',
  sessionLease: '2h',
});

await server.listen(); // resolves when the server is ready (/health reports ready)
console.log(server.url); // http://127.0.0.1:9876

// ...

await server.stop(); // graceful and idempotent
```

The module must run under Bun.

## Options

`createServer(options)` accepts every [configuration key](../reference/configuration.md) in camelCase, **typed**: `port: 9876`, `admin: true`, `sessionLease: '2h'` or `sessionLease: 7_200_000`, `maxSessions: 4` or `'unbounded'`. Values are validated by the same schema as the CLI, and the options object takes the place of CLI flags in the precedence ladder.

Extra fields:

| Option | Default | Meaning |
|---|---|---|
| `env` | `process.env` | Environment to read `BROWSERHIVE_*` and `OTEL_*` from. Pass `{}` to ignore the real environment. |
| `configFile` | discovery | A path, or `false` to ignore config files. |
| `output` | process stdout/stderr | Where the banner and CLI-style output go. |
| `logger` | built-in | An external log sink. |
| `name` | `browserhive` | MCP `serverInfo.name`, for embedders. |

`port: 0` picks a free port (programmatic API only), which is convenient in tests; read the real URL from `server.url` after `listen()`.

## Errors

`createServer` resolves and validates the configuration eagerly and throws a configuration error with the same message the CLI would print (unknown key, invalid value, conflicting settings, insecure bind). `listen()` rejects with a typed error such as [`PORT_IN_USE`](../reference/errors.md#PORT_IN_USE) or [`DB_NEWER_THAN_BINARY`](../reference/errors.md#DB_NEWER_THAN_BINARY), after undoing whatever it had started.

## The server object

| Member | Meaning |
|---|---|
| `url` | Base URL of the listener. |
| `config` | The effective configuration, deeply frozen. |
| `provenance` | Where each value came from and what it shadowed. |
| `listen()` | Start. Idempotent. |
| `stop(deadline?)` | Stop gracefully within the optional deadline. Idempotent, and safe after a failed `listen()`. |

## Exported types

The package also exports `ServerOptions`, `BrowserHiveServer`, the tool names (`ALL_TOOL_NAMES`), `ERROR_CODES` with the `ErrorCode` union, and the wire types for tool arguments and results, so a TypeScript client can type its calls:

```ts
import type { ErrorCode } from 'browserhive';
```

## Testing example

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer } from 'browserhive';

const server = await createServer({ port: 0, env: {}, configFile: false, dataDir: './.tmp-browserhive' });

beforeAll(() => server.listen());
afterAll(() => server.stop());

test('health', async () => {
  const res = await fetch(`${server.url}/health`);
  expect(res.ok).toBe(true);
});
```
