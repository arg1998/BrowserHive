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

### Reserved names

The names `local`, `browserhive` and `system`, and any name starting with `template:`, belong to BrowserHive: `local` owns everything created with `--auth off`, including saved logins without an owner. A token cannot be created under them, in any letter case or with extra spaces or punctuation (`Local`, `local `, `-system-`): the CLI and the dashboard answer `subject is reserved` (HTTP 400 [`VALIDATION_FAILED`](../reference/errors.md#VALIDATION_FAILED)). Names that only contain one of them, such as `local-runner`, are fine.

A token created under one of these names by an earlier version keeps working until you revoke it. `browserhive doctor` warns about each one, and the server logs `reserved subjects in use` once at startup, naming the token's credential id and prefix. Revoke it with `browserhive admin tokens revoke <credential id>` or on the dashboard's System page, then create a new token under another name. BrowserHive never revokes it for you. An entry in `BROWSERHIVE_AUTH_TOKENS` with a reserved name gets the same warning; rename it.

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

All of this is reported by the client or by your configuration. BrowserHive can't verify it, so it is shown for information. The one exception is optional: a [vault binding or folder can be limited to some harnesses](vault.md#harness-restrictions). That only ever takes access away and guards against mistakes, not against a client that lies about its name.

### With nothing configured

Many agents are recognised on their own. Anything BrowserHive can't place is shown as **Unknown**, which is counted and filterable like any other harness.

Each row says how the name was established: **verified live** means we watched the client connect to BrowserHive; **from source** cites the line in the client's code that sets the name; **capture** cites a published recording of what the client sends on the wire.

| Harness | Slug | stdio | Streamable HTTP | How we know |
|---|---|---|---|---|
| Claude Code | `claude-code` | sets `CLAUDECODE` for the servers it starts | `clientInfo.name` `claude-code`; User-Agent `claude-code/<version>` | verified live with Claude Code 2.1.282 |
| OpenCode | `opencode` | `clientInfo.name` `opencode` | the same, and User-Agent `opencode/<version>` | verified live with OpenCode 1.18.31 |
| Gemini CLI | `gemini-cli` | sets `GEMINI_CLI=1` for the servers it starts | `clientInfo.name` `gemini-cli-mcp-client` | from source: `google-gemini/gemini-cli`, `packages/core/src/tools/mcp-client.ts` |
| Codex | `codex` | `clientInfo.name` `codex-mcp-client` | the same, and User-Agent `codex-mcp-client/<version>`; the Codex app sends `openai-mcp (Codex)` | from source: `openai/codex`, `codex-rs/codex-mcp/src/rmcp_client.rs` and `codex-rs/rmcp-client/src/utils.rs`; app: capture ([MCPJam host templates](https://github.com/MCPJam/inspector)) |
| VS Code | `vscode` | `clientInfo.name` `Visual Studio Code` | the same | from source: `microsoft/vscode`, `src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts` |
| Cline | `cline` | `clientInfo.name` `Cline` (`@cline/…` from the Cline SDK) | the same | from source: `cline/cline`, `apps/vscode/src/services/mcp/McpHub.ts` |
| Continue | `continue` | `clientInfo.name` `continue-client` | the same | from source: `continuedev/continue`, `core/context/mcp/MCPConnection.ts` |
| Zed | `zed` | `clientInfo.name` `Zed` | the same | from source: `zed-industries/zed`, `crates/context_server/src/context_server.rs` |
| Cursor | `cursor` | `clientInfo.name` `cursor-vscode` | the same, and User-Agent `Cursor/<version>` | capture: [apify/mcp-client-capabilities](https://github.com/apify/mcp-client-capabilities) |
| Cursor CLI | `cursor-cli` | sends `Cursor`, so it shows as **Cursor** | the same | capture ([plur-ai/plur](https://github.com/plur-ai/plur) fixtures, 2026-10); declare `cursor-cli` to tell them apart |
| Claude Desktop | `claude-desktop` | `clientInfo.name` `claude-ai` (claude.ai connectors send the same) | the same | capture: apify/mcp-client-capabilities, MCPJam |
| GitHub Copilot CLI | `copilot-cli` | `clientInfo.name` `copilot-cli` (older: `github-copilot-developer`) | the same | capture: [railwayapp/cli#1294](https://github.com/railwayapp/cli/pull/1294) telemetry, apify |
| Roo Code | `roo-code` | `clientInfo.name` `Roo Code` | the same | from source: `RooCodeInc/Roo-Code`, `src/services/mcp/McpHub.ts` |
| Kilo Code | `kilo-code` | `clientInfo.name` `kilo` (older extension: `Kilo-Code`) | the same | from source: `Kilo-Org/kilocode`, `packages/opencode/src/mcp/index.ts` |
| Windsurf | `windsurf` | `clientInfo.name` `Windsurf` or `windsurf-client` | the same | capture: apify |
| Goose | `goose` | `clientInfo.name` `goose-cli` / `goose-desktop` | the same, and User-Agent `goose/<version>` | from source: `block/goose`, `crates/goose/src/agents/extension_manager/mod.rs` |
| LM Studio | `lm-studio` | `clientInfo.name` `lmstudio-mcp-server-session` | the same | capture: [gridctl](https://github.com/gridctl/gridctl) `pkg/mcp/clientid.go` |
| JetBrains | `jetbrains` | `clientInfo.name` `JetBrains-…` (seen from the GitHub Copilot plugin in JetBrains IDEs) | the same | capture: apify |
| Junie | `junie` | `clientInfo.name` `junie-client` | the same | capture: railwayapp/cli#1294 |
| n8n | `n8n` | `clientInfo.name` `@n8n/…` (the node type) | the same | from source: `n8n-io/n8n`, `packages/@n8n/nodes-langchain/nodes/mcp/shared/utils.ts` |
| Raycast | `raycast` | `clientInfo.name` `com.raycast.macos` | the same | capture: apify |
| Crush | `crush` | `clientInfo.name` `crush` | the same | from source: `charmbracelet/crush`, `internal/agent/tools/mcp/init.go` |
| Amp | `amp` | `clientInfo.name` `amp-mcp-client` | the same | capture: apify, railwayapp/cli#1294 |
| Kiro | `kiro` | `clientInfo.name` starting with `kiro` | the same | capture: railwayapp/cli#959 (prefix only) |
| Amazon Q Developer CLI | `amazon-q` | `clientInfo.name` `Q DEV CLI` | the same | from source: `aws/amazon-q-developer-cli`, `crates/chat-cli/src/mcp_client/client.rs` |
| Warp | `warp` | `clientInfo.name` `dev.warp.Warp-Stable` (and other `dev.warp.` builds) | the same | from source: `warpdotdev/warp`, `crates/mcp/src/runtime.rs` |
| Qwen Code | `qwen-code` | `clientInfo.name` `qwen-cli-mcp-client-<server>` | the same | from source: `QwenLM/qwen-code`, `packages/core/src/tools/mcp-client.ts` |
| Factory Droid | `factory-droid` | `clientInfo.name` `factory-cli` | the same | capture: apify, railwayapp/cli#1294 |
| Augment | `augment` | `clientInfo.name` `augment-mcp-client` | the same | capture: railwayapp/cli#1294 |
| Antigravity | `antigravity` | `clientInfo.name` `antigravity-client` | the same | capture: apify, railwayapp/cli#959 |
| Grok CLI | `grok-cli` | `clientInfo.name` `grok-shell-<server>` | the same | capture: railwayapp/cli#1294 |
| Kimi Code | `kimi-code` | `clientInfo.name` `kimi-code` | the same | capture: railwayapp/cli#1294 |
| ChatGPT | `chatgpt` | — (connects from OpenAI's cloud) | `clientInfo.name` `openai-mcp` | capture: MCPJam host templates |
| Letta Code | `letta-code` | `clientInfo.name` `letta-code` | the same | from source: `letta-ai/letta-code`, `src/mcp-client.ts` |
| Cherry Studio | `cherry-studio` | `clientInfo.name` `Cherry Studio` | the same | from source: `CherryHQ/cherry-studio`, `src/main/ai/mcp/servers/factory.ts` |
| LibreChat | `librechat` | `clientInfo.name` `@librechat/api-client` | the same | from source: `danny-avila/LibreChat`, `packages/api/src/mcp/connection.ts` |
| Jan | `jan` | `clientInfo.name` `Jan` | the same | from source: `janhq/jan`, `src-tauri/src/core/mcp/helpers.rs` |
| MCP Inspector | `mcp-inspector` | `clientInfo.name` `inspector-cli` | `mcp-inspector` | from source: `modelcontextprotocol/inspector`, `clients/web/src/hooks/useConnectionLifecycle.ts` |

Checked on 2026-11-02; harnesses change their names now and then, so a new release may show up as its own name or as Unknown until this table catches up. A client that sends an SDK's default name (`mcp`, `mcp-client`, `example-client`, `cli`, `rmcp`, `acp`) is Unknown: today that includes Mistral Vibe, OpenHands and Kimi CLI, which you can name yourself as below. Version numbers are shown as sent; some clients always send `1.0.0`.

### Naming your agent

One setting names any agent, and wins over everything detected. Use a known name (`claude-code`, `codex`, `cursor`, `opencode`, `gemini-cli`, `vscode`, …) or any label of your own; labels are lower-cased to letters, digits and dashes. The name exactly as you sent it is kept too, as the session's *declared* name, which is what a [custom name in a vault harness list](vault.md#harness-restrictions) is matched against.

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

Each connection's harness, model, workspace, client name and version, protocol version, User-Agent, IP address and labels are stored in the local database with the connection. A closed connection is deleted with the rest of the telemetry after `--retentionDays`, unless a stored session still refers to it. A session keeps its harness for as long as the session is kept. Nothing leaves the machine unless you turn on [telemetry](telemetry.md) (exported spans carry the harness and model, metrics only the harness name) or a [notification channel](notifications.md#what-leaves-your-machine), whose notifications and digests name the harness at the `titles` and `full` content levels.

A W3C `traceparent` in a tool call's `_meta` becomes the parent of the tool span when [telemetry](telemetry.md) is on.

## Session templates

A [session template](templates.md) is a browser the operator signed in to sites once. An agent finds the templates it may use with `list_templates` and launches a signed-in session with `launch_session` and `template`:

```jsonc
list_templates({})
// → { "templates": [{ "name": "job-hunt", "display_name": "Job hunt", "description": "…",
//      "sites": [{ "site": "linkedin.com", "title": "linkedin.com", "status": "signed_in", "checked_at": 1762770000000 }],
//      "availability": "available", "sealed": true }] }
launch_session({ "slug": "jobs", "template": "job-hunt" })
// → { "session_id": "jobs-a1b2c3d4", "template": { "name": "job-hunt", "sites": [...] }, ... }
```

- [`list_templates`](../reference/tools.md#list_templates) lists only the templates the calling principal and harness may launch, with each site's status and an `availability` of `available`, `busy`, `needs_login` or `unavailable`.
- [`launch_session`](../reference/tools.md#launch_session) takes the template's `name` as `template`; `slug` is still required. Arguments that would change the browser or identity (`launch_options`, most `context_options`, `restore_profile`, a `persistence_mode` other than `memory`, a different `stealth` or `fingerprint`) are refused with `INVALID_ARGUMENTS`; `channel`, `headless`, `incognito` and `vault_enabled` are ignored. See [options a template fixes](templates.md#options-a-template-fixes).
- An unknown name, a template the agent may not use and one still being set up all answer [`TEMPLATE_NOT_FOUND`](../reference/errors.md#TEMPLATE_NOT_FOUND).
- Sessions are sealed by default: no cookie values, no `evaluate`, no `set_cookies`, no `save_storage_state`, no vault fills. See [sealing](templates.md#sealing).

Agents are told what a template session can and cannot do, never how it works. To let several agents use a template with separate rights, give each its own token and list the principals in the template's access rule.

## What differs under stdio

- `request_attention` and `get_attention_result` stay listed but return [`ATTENTION_REQUIRES_HTTP`](../reference/errors.md#ATTENTION_REQUIRES_HTTP).
- Templates can be launched, but not created: creating and signing in needs `--admin`, which needs HTTP. A stdio agent usually runs commands as your user, which sealing does not protect against; see [Security](security.md#session-templates).
- The vault works, except entries that require a dashboard confirmation, which are denied automatically.
- `--admin` and `--auth token` are rejected at startup.
- Every caller is the principal `local`.

## Tool errors

A failed tool call returns `isError: true` with the text `[CODE] message`, for example `[URL_BLOCKED] …`. The structured form (`code`, `retryable`, `hint`, `details`) is in the result's `_meta["browserhive.ai/error"]`. Every code is listed in the [error reference](../reference/errors.md).
