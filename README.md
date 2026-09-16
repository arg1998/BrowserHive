<div align="center">

# BrowserHive

**Local-first, Isolated, stealthy browser sessions for AI agents, with safe password logins!**

[![npm](https://img.shields.io/npm/v/browserhive.svg)](https://www.npmjs.com/package/browserhive)
[![license](https://img.shields.io/npm/l/browserhive.svg)](LICENSE)

[Quick start](docs/guide/quick-start.md) · [Documentation](docs/README.md) · [MCP clients](docs/guide/mcp-clients.md) · [Tools](docs/reference/tools.md) · [Security](docs/guide/security.md)

</div>

BrowserHive is a local [Model Context Protocol](https://modelcontextprotocol.io) server that gives any agent harness (Claude Code, Claude Desktop, Cursor, VS Code, your own) many parallel browser sessions. Each session is its own Chromium process with its own cookies, storage and service workers. Agents log in through your password manager without ever handling the password, hand the page to a human when they get stuck, and leave a replayable audit trail you can inspect on a built-in dashboard.

Everything runs on your machine. Nothing leaves it unless you turn telemetry on.

## Why

Agents that browse need more than a headless browser:

- **They run in parallel** and must not leak cookies or logins into each other.
- **Websites push back.** A bare automation browser announces itself.
- **They need to log in**, and a password in the prompt is a password in the transcript.
- **They get stuck** on CAPTCHAs, 2FA prompts and judgment calls.
- **You need to see what they did**, after the fact and live.

BrowserHive handles all of that behind 43 MCP tools and a best in class admin dashboard.

## Features

- **Isolated sessions.** One Chromium process and context per session: separate cookies, local storage, IndexedDB and service workers. In-memory by default, persistent profiles on request, saved logins you can restore.
- **Stealth, honestly scoped.** Full Chromium in new-headless mode, Patchright, automation flags removed, a coherent user agent and client hints derived from your real host, optional display fingerprint and human-like input. No invented OS, GPU or location, and [the limits are documented](docs/guide/stealth.md#ceilings).
- **Vault credential injection the model never sees.** The agent names a Bitwarden entry and the form fields. BrowserHive checks the origin, session and principal, optionally asks you to confirm, types the credential and returns only a status. Tool results are redacted and Playwright traces exclude the keystrokes.
- **Human takeover.** `request_attention` blocks the agent while you watch its browser live and drive it with your own mouse and keyboard, then resolve with a message back.
- **Audit trail and trace replay.** Every tool call, navigation, vault access and blocked URL goes to SQLite, and every session can record a Playwright trace you open in the built-in Trace Viewer.
- **Operator dashboard.** Overview, sessions with live view and timeline, attention queue, visited websites, blocklist, vault policies and log, server logs, system status and effective configuration with provenance.
- **OpenTelemetry.** Opt-in OTLP export of traces (one per tool call), metrics and logs to Grafana, Jaeger, Honeycomb, Datadog or any collector, with deep links from the dashboard.
- **One port.** MCP, REST API, WebSocket and dashboard share `127.0.0.1:9876`, with one bind rule and one authentication surface. Non-loopback binds require bearer tokens.
- **Guardrails.** URL blocklist with hot reload, launch-argument deny-list, per-session ownership, configurable result recording and retention.

## Quick start

Requires [Bun](https://bun.sh) 1.4 or newer.

```bash
bun add -g browserhive      # or: npm i -g browserhive / pnpm add -g browserhive
browserhive init            # downloads Chromium, creates the data directory, checks the host
browserhive --admin         # MCP at http://127.0.0.1:9876/mcp, dashboard at http://127.0.0.1:9876/
```

The first start prints a one-time dashboard password. Then connect your agent.

**Claude Code:**

```bash
claude mcp add --transport http browserhive http://127.0.0.1:9876/mcp
```

**Any MCP client** (Cursor, VS Code, …):

```json
{
  "mcpServers": {
    "browserhive": {
      "type": "http",
      "url": "http://127.0.0.1:9876/mcp"
    }
  }
}
```

Prefer a single client with no daemon? Use stdio:

```json
{
  "mcpServers": {
    "browserhive": { "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

Then ask your agent to launch a session and browse:

```jsonc
launch_session({ "slug": "research" })                                   // → { "session_id": "research-a1b2c3d4", ... }
navigate({ "session_id": "research-a1b2c3d4", "url": "https://example.com" })
snapshot({ "session_id": "research-a1b2c3d4" })
close_session({ "session_id": "research-a1b2c3d4" })
```

Exposing BrowserHive beyond localhost, bearer tokens and client-specific setup are covered in [Connecting MCP clients](docs/guide/mcp-clients.md) and [Security](docs/guide/security.md).

## Documentation

| | |
|---|---|
| **Start** | [Installation](docs/guide/installation.md) · [Quick start](docs/guide/quick-start.md) · [MCP clients](docs/guide/mcp-clients.md) |
| **Use** | [Dashboard](docs/guide/dashboard.md) · [Vault](docs/guide/vault.md) · [Human takeover](docs/guide/attention.md) · [Stealth](docs/guide/stealth.md) · [Telemetry](docs/guide/telemetry.md) |
| **Operate** | [Configuration](docs/guide/configuration.md) · [Security model](docs/guide/security.md) · [CLI](docs/guide/cli.md) · [Upgrading](docs/guide/upgrading.md) · [Troubleshooting](docs/guide/troubleshooting.md) · [FAQ](docs/guide/faq.md) |
| **Embed** | [Programmatic API](docs/guide/programmatic-api.md) |
| **Reference** | [Tools](docs/reference/tools.md) · [Configuration keys](docs/reference/configuration.md) · [Errors](docs/reference/errors.md) · [REST API](docs/reference/api.md) · [WebSocket](docs/reference/websocket.md) |

## Requirements

- **Bun ≥ 1.4.** Bun is the only supported runtime; installing with npm or pnpm is fine.
- **macOS, Linux or Windows.**
- **Chromium**, installed by `browserhive init` (never during package install).
- **Bitwarden CLI** (`bw`), only for the vault.

## Contributing

Contributions are welcome. BrowserHive is specified before it is coded: read [CONTRIBUTING.md](CONTRIBUTING.md), [the architecture overview](docs/contributing/architecture.md) and [the decision log](specs/00-decisions.md) first.

```bash
bun install
bun run init:browsers
bun run check
```

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
