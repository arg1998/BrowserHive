# browserhive

Isolated, stealthy Chromium sessions for AI agents over the Model Context Protocol, with vault-backed logins the model never sees, human takeover, an audit trail with trace replay, and an operator dashboard. Local-first: nothing leaves your machine unless you enable telemetry.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4 (the only supported runtime; installing with npm or pnpm is fine)
- macOS, Linux or Windows
- Bitwarden CLI (`bw`) only if you use the vault

## Quick start

```bash
bun add -g browserhive      # or: npm i -g browserhive / pnpm add -g browserhive
browserhive init            # downloads Chromium, creates the data directory, checks the host
browserhive --admin         # MCP at http://127.0.0.1:9876/mcp, dashboard at http://127.0.0.1:9876/
```

The first start prints a one-time dashboard password.

Connect an MCP client:

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

Or run it over stdio:

```json
{
  "mcpServers": {
    "browserhive": { "command": "browserhive", "args": ["--transport", "stdio"] }
  }
}
```

## Features

- One Chromium process and context per session; persistent profiles and saved logins
- Stealth: full Chromium, Patchright, host-coherent identity, optional fingerprint and human-like input
- `vault_fill`: Bitwarden credentials typed into the page after origin and policy checks, never returned to the model
- `request_attention`: block the agent and take over its browser from the dashboard
- SQLite audit trail and Playwright trace replay
- Dashboard, REST API and WebSocket on the same port as MCP
- Opt-in OpenTelemetry export of traces, metrics and logs

## Programmatic use

```ts
import { createServer } from 'browserhive';

const server = await createServer({ port: 9876, admin: true });
await server.listen();
console.log(server.url);
await server.stop();
```

## Documentation

- [Installation](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/installation.md)
- [Quick start](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/quick-start.md)
- [Connecting MCP clients](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/mcp-clients.md)
- [Security model](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/security.md)
- [Vault](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/vault.md)
- [Configuration](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/configuration.md)
- [CLI](https://github.com/arg1998/BrowserHive/blob/main/docs/guide/cli.md)
- [Tool reference](https://github.com/arg1998/BrowserHive/blob/main/docs/reference/tools.md)
- [All documentation](https://github.com/arg1998/BrowserHive/blob/main/docs/README.md)

Changelog: [CHANGELOG.md](https://github.com/arg1998/BrowserHive/blob/main/packages/browserhive/CHANGELOG.md)

## License

MIT
