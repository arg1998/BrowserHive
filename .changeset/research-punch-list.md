---
"browserhive": patch
---

Fixes found while researching the next features.

- **MCP works behind a port mapping or SSH tunnel.** `/mcp` rejected every request whose `Host` named a different port (`localhost:8080` for a server on 9876) while the dashboard kept working. Both now use the same check, which ignores the port.
- **New `--allowedHosts` setting** (`BROWSERHIVE_ALLOWED_HOSTS`) for the name a reverse proxy forwards, so the recommended TLS proxy setup works without rewriting `Host`.
- **Session details show the MCP client that launched the session** — its name and version, plus the model and workspace when it sends `X-BH-Agent-Model` / `X-BH-Workspace`. `X-BH-Agent-Harness` no longer overwrites the workspace. Stdio connections record their client too.
- **Saved storage states keep IndexedDB**, so sites that store their login there (Firebase Auth, among others) restore logged in.
- **A malformed secret setting is no longer printed in the error.** `BROWSERHIVE_AUTH_TOKENS` and `otelHeaders` values from env or the config file are also scrubbed from logs and telemetry now.
- **Takeover input is audited**: one audit row per session and second with counts only, never the keys typed.
- **`maxSessions` respects container and systemd memory limits** instead of deriving from the host's full RAM.
- **A data directory on a filesystem that refuses `chmod`** (network shares, some bind mounts) no longer stops the server from starting; it logs a warning.
- **Toggling fullscreen in the live view no longer restarts the stream.**
- Old MCP connection records are now pruned by retention.
- A helper process (such as the Bitwarden CLI) that exits before reading its input no longer raises a spurious `UNHANDLED` degradation.
