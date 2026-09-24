# Connecting MCP clients

BrowserHive speaks MCP over two transports:

| Transport | Endpoint | Use it when |
|---|---|---|
| **Streamable HTTP** (default) | `http://127.0.0.1:9876/mcp` | You run one BrowserHive daemon and connect any number of agents to it. Required for the dashboard, human takeover and vault confirmations. |
| **stdio** | the client spawns `browserhive --transport stdio` | One client, no daemon to manage. No dashboard, no attention tools, no HTTP listener. |

Streamable HTTP is recommended. Start the server first (`browserhive`, or `browserhive --admin`), then point your client at it.

## Authentication tokens

With the default `--auth off`, no token is needed and every caller is the principal `local`. That is only allowed on a loopback bind.

With `--auth token`, every request to `/mcp` needs `Authorization: Bearer <token>`, and each agent only sees the browser sessions it created.

- **First start:** the server creates a token for the principal `agent-1` and prints it once in the startup banner.
- **More tokens:** create one per agent. The plaintext is shown only once:

  ```bash
  browserhive admin tokens create ci-runner
  browserhive admin tokens list
  browserhive admin tokens revoke ci-runner
  ```

  While a server is running, the same commands work against it over the REST API, or you can manage tokens on the dashboard's System page.
- **Ephemeral tokens:** `BROWSERHIVE_AUTH_TOKENS=ci-runner:<32+ characters>` adds tokens that are never stored.

In the snippets below, replace `<token>` with a real token, or remove the `Authorization` header when auth is off.

## Claude Code

HTTP:

```bash
claude mcp add --transport http browserhive http://127.0.0.1:9876/mcp --header "Authorization: Bearer <token>"
```

stdio:

```bash
claude mcp add browserhive -- browserhive --transport stdio
```

Or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "browserhive": {
      "type": "http",
      "url": "http://127.0.0.1:9876/mcp",
      "headers": { "Authorization": "Bearer ${BROWSERHIVE_TOKEN}" }
    }
  }
}
```

## Claude Desktop

Claude Desktop starts local servers from `claude_desktop_config.json` (Settings → Developer → Edit Config). Use stdio:

```json
{
  "mcpServers": {
    "browserhive": {
      "command": "browserhive",
      "args": ["--transport", "stdio"]
    }
  }
}
```

Claude Desktop does not inherit your shell's `PATH` on every platform. If the server fails to start, use absolute paths: `"command": "/Users/you/.bun/bin/bun"` with `"args": ["/Users/you/.bun/bin/browserhive", "--transport", "stdio"]`.

To share one HTTP daemon with Claude Desktop, bridge it with `mcp-remote`:

```json
{
  "mcpServers": {
    "browserhive": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:9876/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "browserhive": {
      "url": "http://127.0.0.1:9876/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

stdio:

```json
{
  "mcpServers": {
    "browserhive": { "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

## VS Code

`.vscode/mcp.json`. VS Code prompts for the token once and stores it securely:

```json
{
  "inputs": [
    { "id": "browserhive-token", "type": "promptString", "description": "BrowserHive bearer token", "password": true }
  ],
  "servers": {
    "browserhive": {
      "type": "http",
      "url": "http://127.0.0.1:9876/mcp",
      "headers": { "Authorization": "Bearer ${input:browserhive-token}" }
    }
  }
}
```

stdio:

```json
{
  "servers": {
    "browserhive": { "type": "stdio", "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

## Any other client

**Streamable HTTP:** `POST`, `GET` and `DELETE` on `http://<host>:<port>/mcp`, with `Authorization: Bearer <token>` when `--auth token` is on. The server issues an `Mcp-Session-Id` on `initialize`. Responses are streamed as server-sent events so `request_attention` can send progress heartbeats every 25 seconds, and a client that reconnects with `Last-Event-ID` resumes the stream.

```json
{
  "mcpServers": {
    "browserhive": {
      "type": "http",
      "url": "http://127.0.0.1:9876/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**stdio:** spawn `browserhive --transport stdio`. stdout carries only JSON-RPC frames; banners and logs go to stderr.

```json
{
  "mcpServers": {
    "browserhive": { "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

Requests whose `Host` header names something other than the bind address, `localhost`, `127.0.0.1`, `[::1]` or an entry of [`--allowedHosts`](../reference/configuration.md#allowedHosts) are rejected (DNS-rebinding protection). The port is not compared, so a port mapping or an SSH tunnel to another local port works.

## Harness identity

BrowserHive notes which agent is on the other end of each MCP connection (Claude Code, Codex, Cursor, OpenCode, Gemini CLI and others), plus a model and a workspace label when the client declares them. The dashboard shows it on each session, counts sessions and tool calls per harness on the Overview, lets you filter the sessions list by harness, and lists live and recent connections on the System page.

All of this is reported by the client or by your configuration. BrowserHive can't verify it, so it is shown for information and never used to allow or refuse anything.

### With nothing configured

Many agents are recognised on their own. Anything BrowserHive can't place is shown as **Unknown**, which is counted and filterable like any other harness.

| Harness | stdio | Streamable HTTP | How we know |
|---|---|---|---|
| Claude Code | sets `CLAUDECODE` for the servers it starts | `clientInfo.name` `claude-code`; User-Agent `claude-code/<version>` | seen against BrowserHive with Claude Code 2.1.282 |
| OpenCode | `clientInfo.name` `opencode` | the same, and User-Agent `opencode/<version>` | seen against BrowserHive with OpenCode 1.18.31 |
| Gemini CLI | sets `GEMINI_CLI=1` for the servers it starts | `clientInfo.name` `gemini-cli-mcp-client` | source: `google-gemini/gemini-cli`, `packages/core/src/tools/mcp-client.ts` |
| Codex | `clientInfo.name` `codex-mcp-client` | the same, and User-Agent `codex-mcp-client/<version>` | source: `openai/codex`, `codex-rs/codex-mcp/src/rmcp_client.rs` and `codex-rs/rmcp-client/src/utils.rs` |
| VS Code | `clientInfo.name` `Visual Studio Code` | the same | source: `microsoft/vscode`, `src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts` |
| Cline | `clientInfo.name` `Cline` | the same | source: `cline/cline`, `apps/vscode/src/services/mcp/McpHub.ts` |
| Continue | `clientInfo.name` `continue-client` | the same | source: `continuedev/continue`, `core/context/mcp/MCPConnection.ts` |
| Zed | `clientInfo.name` `Zed` | the same | source: `zed-industries/zed`, `crates/context_server/src/context_server.rs` |
| Cursor | `clientInfo.name` `cursor-vscode` | the same, and User-Agent `Cursor/<version>` | captured by [apify/mcp-client-capabilities](https://github.com/apify/mcp-client-capabilities) |

Checked on 2026-09-24; harnesses change their names now and then, so a new release may show up as its own name or as Unknown until this table catches up. A client that sends the SDK's default name (`mcp`, `mcp-client`, `example-client`) is Unknown. Version numbers are shown as sent; some clients always send `1.0.0`.

### Naming your agent

One setting names any agent, and wins over everything detected. Use a known name (`claude-code`, `codex`, `cursor`, `opencode`, `gemini-cli`, `vscode`, …) or any label of your own; labels are lower-cased to letters, digits and dashes.

| Where | Harness | Model | Workspace |
|---|---|---|---|
| HTTP headers | `X-BH-Agent-Harness` (or `X-BH-Harness`) | `X-BH-Agent-Model` (or `X-BH-Model`) | `X-BH-Workspace` |
| stdio `env` | `BROWSERHIVE_HARNESS` | `BROWSERHIVE_MODEL` | `BROWSERHIVE_WORKSPACE` |
| URL, when a client only has a URL field | `http://127.0.0.1:9876/mcp?harness=<name>` | — | — |
| `_meta` of a tool call or of `initialize` | `ai.browserhive/harness` | `ai.browserhive/model` | `ai.browserhive/workspace` |

HTTP, for example Claude Code:

```bash
claude mcp add --transport http browserhive http://127.0.0.1:9876/mcp \
  --header "X-BH-Workspace: checkout" --header "X-BH-Agent-Model: claude-opus-5"
```

stdio, any client that takes an `env` block:

```json
{
  "mcpServers": {
    "browserhive": {
      "command": "browserhive",
      "args": ["--transport", "stdio"],
      "env": { "BROWSERHIVE_HARNESS": "nightly-scraper", "BROWSERHIVE_WORKSPACE": "shop" }
    }
  }
}
```

The three `BROWSERHIVE_` identity variables describe the one client of a stdio process. They are not configuration: they don't appear in `config show` or `--help`, and an HTTP server ignores them (it logs one line saying so). A misspelled one still stops startup with a suggestion, like any unknown `BROWSERHIVE_` variable.

When several signals disagree, the highest one wins, in this order: the variable or header you set, the variable a harness sets itself, `?harness=`, `_meta`, `clientInfo`, the User-Agent. The others are kept as "conflicting signals" on the connection in the System page. Identity is read on every tool call, so a header or `_meta` value that changes mid-session is picked up.

### The model

MCP gives a server no way to learn which model drives an agent. BrowserHive shows a model only when the client or your configuration declares one, and shows "not reported" otherwise. A declared model can go stale when you switch models in the agent.

### Extra labels

Any other `X-BH-Meta-<Name>` header or `ai.browserhive/<name>` `_meta` key is kept as a small key/value list on the connection and the session: at most 16 keys, 256 bytes per value and 4 KiB in all. Anything past that is dropped and logged once. These labels are only displayed, never counted or filtered.

### What is stored

Each connection's harness, model, workspace, client name and version, protocol version, User-Agent, IP address and labels are stored in the local database with the connection. A closed connection is deleted with the rest of the telemetry after `--retentionDays`, unless a stored session still refers to it. A session keeps its harness for as long as the session is kept. Nothing leaves the machine unless you turn [telemetry](telemetry.md) on; exported spans carry the harness and model, and metrics carry only the harness name.

A W3C `traceparent` in a tool call's `_meta` becomes the parent of the tool span when [telemetry](telemetry.md) is on.

## What differs under stdio

- `request_attention` and `get_attention_result` stay listed but return [`ATTENTION_REQUIRES_HTTP`](../reference/errors.md#ATTENTION_REQUIRES_HTTP).
- The vault works, except entries that require a dashboard confirmation, which are denied automatically.
- `--admin` and `--auth token` are rejected at startup.
- Every caller is the principal `local`.

## Tool errors

A failed tool call returns `isError: true` with the text `[CODE] message`, for example `[URL_BLOCKED] …`. The structured form (`code`, `retryable`, `hint`, `details`) is in the result's `_meta["browserhive.ai/error"]`. Every code is listed in the [error reference](../reference/errors.md).
