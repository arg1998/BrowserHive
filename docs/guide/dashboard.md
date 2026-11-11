# Dashboard

The dashboard is the operator's view of every agent: what they are doing, what they visited, what they filled from the vault, and what they need from you. Turn it on with `--admin`. It is served on the same host and port as MCP, at `http://127.0.0.1:9876/`.

`--admin` requires `--transport http`.

## Signing in

On the first start with `--admin`, BrowserHive generates a 24-character password, prints it once in the startup banner, and writes it to `<data-dir>/admin/credentials.txt` (mode `0600`). Sign in with it; you must choose a new password (12 to 256 characters) before anything else is reachable. The seed file is then overwritten and deleted.

Lost the password? Stop the server and run `browserhive admin reset-password`.

A dashboard session expires after 15 minutes of inactivity or 8 hours in total. Watching a live view counts as activity. When it expires the dashboard sends you back to the login page.

## Layout and keyboard

A sidebar lists the pages (collapsed to icons on medium screens, a drawer on phones). The header shows connection health and notifications. The connection pill reads **Live** while the realtime connection is up, **Degraded** when a request could not reach a working BrowserHive (a network error, a timeout or a server error), and **Offline** when the realtime connection is down. A page left idle stays Live. Its popover shows the realtime state, REST, when BrowserHive last answered, and the version.

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

Every session, live and finished. Filter by state (live, closed, archived), owner, channel, persistence mode and harness (the agent that launched the session, see [Harness identity](mcp-clients.md#harness-identity)); search by slug or id; sort by any column. Columns show the last URL, calls and errors, blocked attempts, the agent (harness, with the workspace or model when declared), the lease countdown and the state (including "needs attention" and "being watched"). Sessions launched from a [template](#templates) show the template's name on their line, and a **Template** chip filters by template. Select rows to archive, unarchive or delete in bulk. Deleting names exactly what is erased: events, trace, screenshots, profile and downloads, terminating live sessions first.

## Session detail

The header shows the session id, state and actions: terminate, open the trace viewer, download `trace.zip`, archive, delete. When the agent is waiting on you, a banner shows the attention request or pending vault confirmations. A side rail lists owner, channel, headless or headed, persistence, current URL, lease and identity. The **Client** panel shows the harness and how it was recognised, the declared model ("not reported" when none), the workspace, the client's name, version and protocol, and any extra labels it sent. The **Session** panel shows the browser with its real version and whether it ran inside Chromium's sandbox. Both are recorded when the browser launches, so a closed session still shows them. A session from before this was recorded (BrowserHive 0.1.x) shows **not recorded**, which does not mean the sandbox was off; a session whose browser never started shows **not launched**.

Tabs:

A session launched from a template carries a **Template** badge that opens the template, and **Sign-ins protected** while agents cannot read its cookie values, run page scripts or save the sign-in ([Sealing](templates.md#sealing)); BrowserHive's own sign-in and upkeep sessions read **BrowserHive (system)**. Template sessions are never traced, which the Files tab says, and their identity is the template's.

- **Live.** The screencast of the agent's browser. Controls: start/stop, stream size (fit, 720p, 1080p, native; per viewer), **Resize agent browser** (changes the agent's real viewport), fullscreen. While an attention request is open for this session you can take over: mouse, wheel, keyboard and touch input go to the page. Outside that window input is refused. See [Human takeover](attention.md).
- **Timeline.** Every tool call with parameters, result, duration, error code and screenshot, plus navigations, vault access, blocked URLs and attention requests. Filter by kind, follow live, expand rows. Arguments larger than 64 KiB were shortened when recorded: the row gives their full size and shows their start as text. When [telemetry](telemetry.md) is on, each call shows its `trace_id` and, with `--otelTraceUrlTemplate`, a link into your tracing backend.
- **Vault.** This session's vault access log and pending confirmations.
- **Identity.** What the browser presents to websites: user agent, client-hint brands, platform, Chrome version, locale, timezone, screen and viewport, and whether fingerprinting and humanized input are on. See [Stealth](stealth.md).
- **Files.** Data directory path, `trace.zip` with size, download, and **Open trace viewer** (Playwright Trace Viewer with DOM snapshots, network and console, served by BrowserHive), screenshots, downloads, and the command to open the trace locally.

## Templates

A [session template](templates.md) is a browser you sign in to once; agents then launch sessions from it already signed in. The page lists every template: its display name and the name agents use, its sites with a mark per site (**Signed in**, **Signed out**, **Check needed**, **Couldn't tell**, **Not checked**), its **Browser** (stopped, starting, running, restarting, crashed, failed) with the pages agents have open, live sessions against its cap, and when an agent last used it. Filter by status and browser state, or search by name. A template you have not finished signing in to reads **Setting up** and offers **Continue sign-in**. Each row's menu opens it, restarts its browser, disables or enables it, and deletes it. The sidebar badge on **Templates** counts the sites that need a sign-in.

**New template** opens a five-step wizard. The step is in the URL, so a reload keeps your place.

1. **Name.** A display name, the name agents pass to `launch_session` (2 to 32 characters: lowercase letters, digits and dashes, starting with a letter) and a description agents see in `list_templates`.
2. **Sites.** The domains to sign in to, up to 16. Type any domain; BrowserHive keeps its registrable domain (`www.linkedin.com` becomes `linkedin.com`).
3. **Identity and network.** Browser channel, stealth level, fingerprint, headless (with a warning: sites challenge headless browsers more often), a proxy (server, user name and the **name** of the environment variable holding the password), locale and time zone. They are fixed once the template exists; see [Identity](templates.md#identity). With a proxy, locale and time zone are required.
4. **Access.** Who may launch it (every agent, or listed principals), which harnesses (the same picker as vault bindings), the concurrent session cap, and the protections: sign-ins are protected by default, and each **Allow …** switch asks for confirmation. See [Sealing](templates.md#sealing). **Create and sign in** creates the template; on step 3, **Skip to sign-in** keeps the defaults of steps 3 and 4.
5. **Sign in.** **Open the sign-in window** opens the sign-in window **on the machine running BrowserHive**, one tab per site. When the dashboard reaches BrowserHive at an address that is not this device, a notice says where the window opens and how to reach a server without a screen ([Signing in on Xvfb](templates.md#signing-in-on-xvfb-vnc)); **Watch the window** shows its live view beside the sites, read only, so you can follow progress from here. Sign in to each site in its tab, then press **I'm signed in** beside the site ([how BrowserHive knows](templates.md#how-browserhive-knows-you-signed-in)). **Finish** lists any [unlisted sign-ins](templates.md#unlisted-sign-ins) ("Also signed in to: … — agents can use this") with **Remove sign-in** preselected, then sets the template ready. When a site is not signed in, Finish warns that agents will get signed-out pages there and offers to keep signing in; a site you did not confirm is kept and marked signed out, and the ready screen and the template page offer **Sign in again**, which reopens the window for it. **Cancel and close the window** (or **Finish later** before it opens) leaves the template setting up. When the window cannot open, the step says why and what to do: no display on the BrowserHive machine (the command to run there, or Xvfb), an unreachable proxy (change it on the template's Settings tab), too many browsers open (close a session or raise `maxSessions`), the browser not installed (the install command), or the browser closed during sign-in (open it again).

The template page shows the status, the **Browser** with **Start**, **Stop** and **Restart**, **Disable**/**Enable** and **Delete**. Banners warn about a changed browser version (identity drift), a browser running without Chromium's sandbox, saved passwords or autofill data found in its profile (**Clear saved passwords and autofill**), unlisted sign-ins (**Remove sign-in**) Tabs:

- **Sites.** One card per site: its sign-in state with the reason and when it was last checked, the sign-in cookie names BrowserHive learned, whether the site is offered to agents, the site's rule for requests that change the account (it takes effect with site packs), **Sign in again** for a site that is not signed in, and **Remove site…**.
- **Sessions.** Live and recent sessions launched from the template, BrowserHive's own sessions marked **BrowserHive (system)**, **Other windows** (tabs and windows nobody's session owns, such as one you opened by hand) with **Close**, and windows that show pages of several sessions.
- **Versions.** The rolling checkpoint and the saved versions with their reason, size, sign-ins per domain and health, **Last good**, **Pin**, **Restore…** (close the live sessions now or wait for them), **Save version now** and **Seed from file…** (a Playwright storage-state JSON, at most 16 MiB). A running restore or seed shows its progress; agents wait meanwhile. When one is refused (another operation running, a version saved with a key this server does not hold) the dialog says why.
- **Access.** Who may launch it, the harnesses, the cap, the **Allow …** switches with whom they apply to, and a tester that answers whether a principal and harness may use the template.
- **Settings.** The pinned identity (read only), what the browser reported at its first start, the proxy and channel (changing either restarts the browser and may sign you out, so it asks first), headless, agent windows and the data directory.
- **Activity.** Where sign-in checks and site-rule hits will be listed.

Deleting asks you to type the template's name and lists the live sessions it closes; it does not sign you out at the sites. Stopping or restarting the browser and clearing saved passwords list the sessions they close too. Disabling, restoring a version, seeding over a ready template, removing a site, each **Allow …** switch, and access changes that close sessions all ask first and name the sessions they close.

## Site packs

Listed under Templates. Site packs (per-site knowledge such as the sign-in page and how to tell a sign-in is still valid) are not available in this version, so the page explains what they will add. Until then every site of a template is a generic site: BrowserHive learns its sign-in cookies when you press **I'm signed in**.

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
- **Origin tester:** type a URL, and optionally the harness to test as, and see which entries would fill there and why.
- **Folders:** each vault folder has a policy (manual, allow all, reject all), folder-wide flags and the harnesses that may use it.
- **Bindings:** per entry, the allowed origins, authorized sessions, flags and harnesses. See [Harness restrictions](vault.md#harness-restrictions).

Details in the [vault guide](vault.md).

## Vault log

The audit trail of every `vault_fill` and denied listing: time, entry, result, origin check, whether `evaluate` was enabled, session and page URL. Filterable. It never contains secrets.

## Logs

A live tail of the server log with level, module, session and trace filters, pause-on-scroll, and NDJSON export. Change the log level at runtime from the System page.

## System

Version, transport, uptime, bind address, live sessions and the browsers open against the cap (a template's browser counts once however many sessions use it), open attention requests, live views, dashboard connections, default persistence, whether `evaluate` is allowed, vault backend, blocklist, retention, database size and schema version, telemetry endpoint and data directory. A stealth section shows the stealth level, driver, fingerprint and humanize defaults and CAPTCHA mode. **Browsers and sandbox** lists the browsers found on the machine (the bundled Chromium, an installed Google Chrome or Microsoft Edge) with version and path, marks the default one, and shows for each whether it runs inside Chromium's sandbox, with Chrome's own reason when it cannot. **Template browsers** lists the templates whose browser is running, with its state, pages, memory and sessions; select one to open the template. **MCP connections** lists the agents connected over MCP, live ones first, then recent ones; select one to see how its harness was recognised, its model and workspace, client and protocol, User-Agent, IP, any conflicting signals and extra labels. **Public address** shows `publicUrl` and whether it reaches this BrowserHive (see [public address](notifications.md#public-address)), with **Check again**. A session's Details tab shows its browser version and whether that session ran sandboxed, for live and closed sessions alike. Banners warn when `evaluate` is enabled together with the vault, when disk space is low, or when a subsystem is degraded. The configuration table lists every effective setting with its source (`cli`, `file`, `env`, `default`, `derived`) and the values it shadowed; secrets are shown as redacted. A value the config file reads from an environment variable has a `$NAME` chip under its source (outlined when the variable was not set and the default is used); select it to see the value as written in the file, or, for a secret, just the variable. **Only values from references** narrows the table to those keys, and the filter also matches variable names. See [References](configuration.md#references).

## Notifications

Persisted notifications for attention requests, tool errors, crashed sessions and pending vault confirmations, grouped by day. Mark as read or dismiss, individually or all at once. Once an attention request or vault confirmation is settled (in the dashboard, by a timeout, or elsewhere), its row keeps its place and shows the outcome as a small pill (**resolved**, **expired**, or **closed** when the agent stopped waiting), and a toast still on screen for it closes. See [Notifications](notifications.md).

**Channels** (Notifications → Channels) sends notifications to your phone through Telegram, Discord (webhook or bot), ntfy or a webhook: one card per channel with its status, last delivery, 24-hour counts and, when act buttons are on, whether answers from the chat reach BrowserHive; and an **Add channel** wizard with a live preview and a test message. Its **What to send** step switches **Answer from the chat** on and edits who may answer, and its **Reports** section sets a daily or weekly digest, the channel's time zone and the anomaly alerts; a card shows the next digest and **Send now** (a preview of the real digest, then a send on demand). The delivery log marks a digest sent after downtime as **late**. **Delivery log** lists every send, edit and delete, and says why anything was not sent. **Actions** lists every press of an act button: who, which button, from which chat, and what happened. **Reports** keeps every digest and anomaly alert once per period (the inbox's **Reports** chip shows the same), opens each as a page with its facts, chart and tables, and has **Reports in BrowserHive**: a digest and anomaly alerts for the dashboard itself, with no channel needed. See [Channels](notifications.md#channels), [Answer from your phone](notifications.md#answer-from-your-phone) and [Reports in BrowserHive](notifications.md#reports-in-browserhive).
