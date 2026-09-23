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

## Optional client metadata

A session's details in the dashboard show the client that launched it: the name and version the client sends in `initialize`, over either transport. Clients using HTTP may also send these headers on the `initialize` request (self-reported, display only, never used for access control):

| Header | Example | Shown as |
|---|---|---|
| `X-BH-Agent-Model` | `claude-opus-5` | the model, after the client name |
| `X-BH-Workspace` | `checkout-bot` | a label for this agent, after the client name |
| `X-BH-Agent-Harness` | `claude-code` | recorded, not shown yet |

A W3C `traceparent` in a tool call's `_meta` becomes the parent of the tool span when [telemetry](telemetry.md) is on.

## What differs under stdio

- `request_attention` and `get_attention_result` stay listed but return [`ATTENTION_REQUIRES_HTTP`](../reference/errors.md#ATTENTION_REQUIRES_HTTP).
- The vault works, except entries that require a dashboard confirmation, which are denied automatically.
- `--admin` and `--auth token` are rejected at startup.
- Every caller is the principal `local`.

## Tool errors

A failed tool call returns `isError: true` with the text `[CODE] message`, for example `[URL_BLOCKED] …`. The structured form (`code`, `retryable`, `hint`, `details`) is in the result's `_meta["browserhive.ai/error"]`. Every code is listed in the [error reference](../reference/errors.md).
