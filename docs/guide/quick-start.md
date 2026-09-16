# Quick start

This page assumes you have [installed BrowserHive](installation.md) and run `browserhive init`.

## 1. Start the server

```bash
browserhive
```

That is the whole setup for a local agent:

- MCP is served at `http://127.0.0.1:9876/mcp` (Streamable HTTP).
- Sessions are in memory and headless by default.
- No dashboard, no vault, no authentication. The server binds to loopback only.

Connect your agent with the snippets in [MCP clients](mcp-clients.md).

## 2. Add the dashboard

```bash
browserhive --admin
```

The dashboard, REST API and WebSocket share the same port. On the first start the server prints a one-time password:

```
 BrowserHive 0.1.0  ·  bun 1.4.2  ·  patchright 1.63.0
 MCP        http://127.0.0.1:9876/mcp            (auth: off)
 Dashboard  http://127.0.0.1:9876/               (admin)
 ...
 admin:  first-run password: Kq7…  (also in ~/.local/share/browserhive/admin/credentials.txt)
 Press Ctrl-C to stop.
```

Open `http://127.0.0.1:9876/`, sign in with that password, and choose a new one (at least 12 characters). The seed file is then overwritten and deleted. With `--admin`, every session also records a Playwright trace that you can replay later.

## 3. Drive a browser from your agent

A minimal session, as tool calls:

```jsonc
launch_session({ "slug": "shop", "persistence_mode": "persistent" })   // → { "session_id": "shop-a1b2c3d4", ... }
navigate({ "session_id": "shop-a1b2c3d4", "url": "https://example.com" })
snapshot({ "session_id": "shop-a1b2c3d4" })
screenshot({ "session_id": "shop-a1b2c3d4" })
close_session({ "session_id": "shop-a1b2c3d4" })
```

Every session is its own Chromium process with its own cookies, storage, IndexedDB and service workers. The full catalog is in the [tool reference](../reference/tools.md).

## Common setups

| Goal | Command | What you get |
|---|---|---|
| Just run it | `browserhive` | MCP on `127.0.0.1:9876/mcp`, memory sessions, headless |
| One agent over stdio | `browserhive --transport stdio` | stdio MCP. No dashboard, no attention tools |
| Sessions that survive restarts | `browserhive --persistence persistent` | profiles under `<data-dir>/sessions/<id>/userdata` |
| Watch the agents | `browserhive --admin` | dashboard, live view, traces |
| Log in without the model seeing the password | `bw login`, then `browserhive --admin --vault bitwarden`; paste a token from `bw unlock --raw` on the Vault page | see [Vault](vault.md) |
| Replay a run | dashboard → Sessions → a session → Files → Open trace viewer | Playwright Trace Viewer with DOM snapshots, network and console |
| Keep agents off some sites | `browserhive --admin --blocklist ./blocklist.txt --blocklistWatch` | refused navigations, visible on the Blocklist page |
| Human in the loop | `browserhive --admin` and the agent calls `request_attention` | see [Human takeover](attention.md) |
| Expose on the LAN | `browserhive --host 0.0.0.0 --auth token --admin` | bearer tokens required; see [Security](security.md) |
| Export telemetry | `browserhive --admin --otel --otelEndpoint http://127.0.0.1:4318` | see [Telemetry](telemetry.md) |
| Start over | `browserhive purge` | deletes the database and sessions after you type `YES` |

Every flag also works as an environment variable and a config-file key. See [Configuration](configuration.md).

## Blocklist file format

One glob per line. Blank lines and `#` comments are ignored; matching is case-insensitive.

```text
# block a site and all its paths
example.com
# subdomains only
*.tracking.example
# one scheme and path
https://intranet.example.org/admin/*
# substring
*doubleclick*
```

Navigations to a blocked URL fail with [`URL_BLOCKED`](../reference/errors.md#URL_BLOCKED) before the browser is touched, and document requests are aborted at the network layer. Subresources are not blocked: the blocklist keeps agents off pages, it is not an egress firewall. With `--blocklistWatch` (or the Reload button on the Blocklist page) edits apply without a restart.
