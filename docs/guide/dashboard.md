# Dashboard

The dashboard is the operator's view of every agent: what they are doing, what they visited, what they filled from the vault, and what they need from you. Turn it on with `--admin`. It is served on the same host and port as MCP, at `http://127.0.0.1:9876/`.

`--admin` requires `--transport http`.

## Signing in

On the first start with `--admin`, BrowserHive generates a 24-character password, prints it once in the startup banner, and writes it to `<data-dir>/admin/credentials.txt` (mode `0600`). Sign in with it; you must choose a new password (12 to 256 characters) before anything else is reachable. The seed file is then overwritten and deleted.

Lost the password? Stop the server and run `browserhive admin reset-password`.

A dashboard session expires after 15 minutes of inactivity or 8 hours in total. Watching a live view counts as activity. When it expires the dashboard sends you back to the login page.

## Layout and keyboard

A sidebar lists the pages (collapsed to icons on medium screens, a drawer on phones). The header shows connection health and notifications.

| Key | Action |
|---|---|
| ⌘K / Ctrl+K | Command palette: pages, sessions, actions |
| ⌘B / Ctrl+B | Toggle the sidebar |
| `/` | Focus the page's filter |
| `?` | Keyboard shortcuts |
| Esc | Close the topmost overlay |
| `j` / `k`, Enter | Move through and open table rows |

Theme follows the system, or pick light or dark. Filters, sorting and pagination live in the URL, so any view can be bookmarked or shared.

## Overview

Fleet health over 24 h, 3 d, 7 d, 14 d or 30 d: live sessions, sessions and tool calls in the window (with sparklines), open attention requests, errors with the error rate, active live views, and blocked URLs. The activity chart shows calls per bucket with errors stacked; click a bar to open the sessions of that time slice. Below it, a live feed of websites visited, the most frequent recent failures, and **Harnesses**: sessions and tool calls per agent in the window, with Unknown always listed; click one to see its sessions.

## Sessions

Every session, live and finished. Filter by state (live, closed, archived), owner, channel, persistence mode and harness (the agent that launched the session, see [Harness identity](mcp-clients.md#harness-identity)); search by slug or id; sort by any column. Columns show the last URL, calls and errors, blocked attempts, the agent (harness, with the workspace or model when declared), the lease countdown and the state (including "needs attention" and "being watched"). Select rows to archive, unarchive or delete in bulk. Deleting names exactly what is erased: events, trace, screenshots, profile and downloads, terminating live sessions first.

## Session detail

The header shows the session id, state and actions: terminate, open the trace viewer, download `trace.zip`, archive, delete. When the agent is waiting on you, a banner shows the attention request or pending vault confirmations. A side rail lists owner, channel, headless or headed, persistence, current URL, lease and identity. The **Client** panel shows the harness and how it was recognised, the declared model ("not reported" when none), the workspace, the client's name, version and protocol, and any extra labels it sent.

Tabs:

- **Live.** The screencast of the agent's browser. Controls: start/stop, stream size (fit, 720p, 1080p, native; per viewer), **Resize agent browser** (changes the agent's real viewport), fullscreen. While an attention request is open for this session you can take over: mouse, wheel, keyboard and touch input go to the page. Outside that window input is refused. See [Human takeover](attention.md).
- **Timeline.** Every tool call with parameters, result, duration, error code and screenshot, plus navigations, vault access, blocked URLs and attention requests. Filter by kind, follow live, expand rows. When [telemetry](telemetry.md) is on, each call shows its `trace_id` and, with `--otelTraceUrlTemplate`, a link into your tracing backend.
- **Vault.** This session's vault access log and pending confirmations.
- **Identity.** What the browser presents to websites: user agent, client-hint brands, platform, Chrome version, locale, timezone, screen and viewport, and whether fingerprinting and humanized input are on. See [Stealth](stealth.md).
- **Files.** Data directory path, `trace.zip` with size, download, and **Open trace viewer** (Playwright Trace Viewer with DOM snapshots, network and console, served by BrowserHive), screenshots, downloads, and the command to open the trace locally.

## Attention

The human-in-the-loop queue. Each pending request shows the agent's reason, the mode (takeover or notify), how long the agent has waited, any options it attached, and a message box. **Resolve** or **Reject** sends your message back to the agent; **Open live & take over** jumps to the live view. Below the queue, the history of settled requests with outcome, wait time and who resolved them.

## Websites

Every URL any agent visited, with the most visited domains, category tags for non-public destinations (IP addresses, local hosts, FTP), and filters by session, domain and time window.

## Blocklist

The loaded rules and how often each one fired, lines in the file that do nothing (duplicates, refused patterns), attempts by source (tool boundary or network), sessions affected and top domains. **Reload blocklist** re-reads the file without a restart. When no blocklist is configured the page explains how to add one.

## Vault

Available with `--vault bitwarden`.

- **Status and unlock:** lock state, unlock by pasting a session token from `bw unlock --raw` (the dashboard never asks for your master password), sync.
- **Confirmations:** fills waiting for your approval, with the requesting session, target URL and tool. Approve, or deny with a reason recorded in the audit log only.
- **Origin tester:** type a URL and see which entries would fill there.
- **Folders:** each vault folder has a policy (manual, allow all, reject all) and folder-wide flags.
- **Bindings:** per entry, the allowed origins, authorized sessions and flags.

Details in the [vault guide](vault.md).

## Vault log

The audit trail of every `vault_fill` and denied listing: time, entry, result, origin check, whether `evaluate` was enabled, session and page URL. Filterable. It never contains secrets.

## Logs

A live tail of the server log with level, module, session and trace filters, pause-on-scroll, and NDJSON export. Change the log level at runtime from the System page.

## System

Version, transport, uptime, bind address, sessions live versus the cap, open attention requests, live views, dashboard connections, default persistence, whether `evaluate` is allowed, vault backend, blocklist, retention, database size and schema version, telemetry endpoint and data directory. A stealth section shows the stealth level, driver, fingerprint and humanize defaults and CAPTCHA mode. **Browsers and sandbox** lists the browsers found on the machine (the bundled Chromium, an installed Google Chrome or Microsoft Edge) with version and path, marks the default one, and shows for each whether it runs inside Chromium's sandbox, with Chrome's own reason when it cannot. **MCP connections** lists the agents connected over MCP, live ones first, then recent ones; select one to see how its harness was recognised, its model and workspace, client and protocol, User-Agent, IP, any conflicting signals and extra labels. A session's Details tab shows its browser version and whether that session runs sandboxed. Banners warn when `evaluate` is enabled together with the vault, when disk space is low, or when a subsystem is degraded. The configuration table lists every effective setting with its source (`cli`, `file`, `env`, `default`, `derived`) and the values it shadowed; secrets are shown as redacted. A value the config file reads from an environment variable has a `$NAME` chip under its source (outlined when the variable was not set and the default is used); select it to see the value as written in the file, or, for a secret, just the variable. **Only values from references** narrows the table to those keys, and the filter also matches variable names. See [References](configuration.md#references).

## Notifications

Persisted notifications for attention requests, tool errors, crashed sessions and pending vault confirmations, grouped by day. Mark as read or dismiss, individually or all at once.
