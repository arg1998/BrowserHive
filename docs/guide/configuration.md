# Configuration

Every setting of BrowserHive is a **key** that you can set in three places: an environment variable, the config file, or a CLI flag. This page explains how they combine. The [configuration reference](../reference/configuration.md) lists every key with its type, default and constraints.

## Precedence

Lowest to highest. **Rightmost wins.**

```
defaults  <  environment variables  <  browserhive.config.json  <  CLI flags
```

When a key comes from more than one source, the startup log says which value won:

```
config: maxSessions=8 (cli) shadows config-file=4, env=2
```

`browserhive config show` prints the effective value and source of every key, and the dashboard's System page shows the same table. Secrets such as `authTokens` and `otelHeaders` are always shown as `<redacted>`.

## Naming

Each key has one camelCase name; the other spellings are derived from it:

| Key | CLI flag | Environment variable | Config file |
|---|---|---|---|
| `maxSessions` | `--maxSessions 8` | `BROWSERHIVE_MAX_SESSIONS=8` | `"maxSessions": 8` |
| `sessionLease` | `--sessionLease 2h` | `BROWSERHIVE_SESSION_LEASE=2h` | `"sessionLease": "2h"` |
| `allowInsecureBind` | `--allowInsecureBind` | `BROWSERHIVE_ALLOW_INSECURE_BIND=true` | `"allowInsecureBind": true` |

Rules:

- CLI flags are case-sensitive camelCase. `--maxsessions` or any kebab-case spelling is an unknown flag; the error suggests the camelCase spelling.
- Booleans: `--admin` sets true; `--admin=false` or `--noAdmin` sets false. `--admin false` (with a space) is not accepted, so a boolean never swallows the next argument.
- Durations take `ms`, `s`, `m`, `h` or `d` (`30m`, `2h`). A bare number is milliseconds.
- Sizes take `B`, `KiB`, `MiB`, `GiB`, `KB`, `MB` or `GB`. A bare number is bytes.
- Lists are comma-separated on the CLI and in env (`--otelSignals traces,logs`), and JSON arrays in the file.
- Maps are `k=v,k2=v2` on the CLI and in env, and JSON objects in the file.

## Fail fast

Configuration problems stop the process before it binds a port or opens the database, with exit code `64` and a message that names the source:

```
browserhive: unknown flag '--maxSession'. Did you mean '--maxSessions'? Run 'browserhive --help'.
browserhive: invalid value for --sessionLease: '2 hours'. Expected a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds.
browserhive: BROWSERHIVE_PORT is set but empty. Unset it or provide a value.
```

Unknown `BROWSERHIVE_*` environment variables and unknown keys in the config file fail the same way. An empty value is an error, not "unset". Some combinations are rejected too, for example `humanize=true` with `stealth=off`, or `admin=true` with `transport=stdio`. The full list is under [cross-field rules](../reference/configuration.md#cross-field-rules).

Check a configuration without starting the server:

```bash
browserhive config validate
```

## The config file

`browserhive.config.json` is plain JSON (no comments). BrowserHive uses the first file it finds:

1. `--config <path>` (or `BROWSERHIVE_CONFIG`). A missing file here is an error.
2. `./browserhive.config.json` in the current directory.
3. `<data-dir>/browserhive.config.json`.

Relative paths inside the file resolve against the file's directory. A config file found in the data directory may not change `dataDir`.

For editor completion, write the JSON Schema next to your file and reference it:

```bash
browserhive config schema > browserhive.schema.json
```

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

The same schema is published in this repository as [config.schema.json](../reference/config.schema.json).

If the file contains `authTokens`, keep it readable only by you (`chmod 600`); `doctor` warns otherwise. Prefer the environment for secrets.

## Most used keys

| Key | Default | Purpose |
|---|---|---|
| [`transport`](../reference/configuration.md#transport) | `http` | `http` or `stdio` |
| [`host`](../reference/configuration.md#host), [`port`](../reference/configuration.md#port) | `127.0.0.1`, `9876` | bind address, shared by MCP, API, WebSocket and dashboard |
| [`admin`](../reference/configuration.md#admin) | `false` | dashboard, REST API, live view, traces |
| [`auth`](../reference/configuration.md#auth) | `off` | `token` requires bearer tokens on `/mcp` and scopes sessions to their owner |
| [`persistence`](../reference/configuration.md#persistence) | `memory` | default for `launch_session`: `memory`, `persistent`, `storage-state` |
| [`vault`](../reference/configuration.md#vault) | `off` | `bitwarden` enables credential injection |
| [`stealth`](../reference/configuration.md#stealth) | `standard` | `off`, `standard` or `max`; see also `fingerprint` and `humanize` |
| [`maxSessions`](../reference/configuration.md#maxSessions) | derived from RAM | concurrent session cap, or `unbounded` |
| [`sessionLease`](../reference/configuration.md#sessionLease) | `2h` | idle sessions are closed after this long |
| [`blocklist`](../reference/configuration.md#blocklist) | unset | URL blocklist file |
| [`dataDir`](../reference/configuration.md#dataDir) | OS default | where state lives |
| [`logLevel`](../reference/configuration.md#logLevel), [`logFormat`](../reference/configuration.md#logFormat) | `info`, `auto` | logging; `logLevel` accepts per-module levels like `info,sessions=debug` |
| [`recordToolResults`](../reference/configuration.md#recordToolResults) | `full` | how much of each tool result is stored |
| [`otel`](../reference/configuration.md#otel), [`otelEndpoint`](../reference/configuration.md#otelEndpoint) | `false` | OpenTelemetry export |

`maxSessions` defaults to `min(floor(RAM in GiB / 1.5), 20)`. `trace` defaults to the value of `admin`, and `fingerprint` defaults to true only when `stealth=max`.

## Environment-only deployments

For a service manager (systemd `EnvironmentFile`, `docker --env-file`):

```sh
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

Standard `OTEL_*` variables are honoured below `BROWSERHIVE_*` ones; see [the reference](../reference/configuration.md#opentelemetry-environment-variables).

## Per-session settings are tool arguments

An agent can override some defaults for one session through `launch_session` arguments: `persistence_mode`, `headless`, `channel`, `stealth`, `fingerprint`, `humanize`, `disable_evaluate`, `vault_enabled`, `context_options` and `launch_options`. These are not configuration and never appear in `config show`. See [`launch_session`](../reference/tools.md#launch_session).

## Runtime changes

Most keys need a restart. `logLevel`, `logFormat` and `otelTraceUrlTemplate` can be changed while the server runs (the log level from the dashboard's System page or `PATCH /api/v1/system/log-level`).
