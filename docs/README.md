# BrowserHive documentation

BrowserHive is a local MCP server that gives AI agents isolated, stealthy Chromium sessions, with vault-backed logins the model never sees, human takeover, a full audit trail and an operator dashboard.

## Get started

- [Installation](guide/installation.md): Bun, the package, `browserhive init`, `browserhive doctor`
- [Quick start](guide/quick-start.md): first run, the dashboard, common setups
- [Connecting MCP clients](guide/mcp-clients.md): Claude Code, Claude Desktop, Cursor, VS Code, any Streamable HTTP or stdio client

## Guides

- [Dashboard](guide/dashboard.md): a tour of every page
- [Configuration](guide/configuration.md): precedence, naming, the config file
- [Security model](guide/security.md): authentication, bind rules, the vault model, redaction, what is recorded
- [Vault](guide/vault.md): Bitwarden setup, folder policies, bindings, confirmations
- [Human takeover](guide/attention.md): `request_attention` and the live view
- [Stealth](guide/stealth.md): what it does, what it does not, ceilings, proxies
- [Telemetry](guide/telemetry.md): OpenTelemetry export and a local Grafana stack
- [Command line](guide/cli.md): every command and exit code
- [Programmatic API](guide/programmatic-api.md): `createServer`
- [Upgrading and downgrading](guide/upgrading.md): migrations, backups, `db restore`
- [Troubleshooting](guide/troubleshooting.md)
- [FAQ](guide/faq.md)

## Reference

Generated from the source by `scripts/gen-docs.ts`; always in sync with the code.

- [Configuration keys](reference/configuration.md): every key with CLI, environment and file names, type, default
- [MCP tools](reference/tools.md): the 43 tools with parameters, results and errors
- [Errors](reference/errors.md): every error code with cause and resolution
- [REST API](reference/api.md): every admin API endpoint with scope and authentication
- [WebSocket protocol](reference/websocket.md): envelope, topics, commands, screencast frames
- [Config file JSON Schema](reference/config.schema.json)

## Contributing

- [Architecture](contributing/architecture.md): how the code is organised
- [Contributing guide](../CONTRIBUTING.md)
