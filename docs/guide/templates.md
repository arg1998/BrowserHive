# Session templates

> **In this release:** you create a template and sign it in to its sites (or seed it from a storage state) from the command line or the REST API, BrowserHive keeps encrypted versions of its sign-ins that you can restore, agents list and launch it over MCP, and template sessions are sealed. The dashboard's Templates pages, health checks with re-login, and site packs arrive in later releases.

A session template is a browser identity you sign in to sites once. Agents then launch sessions from it with `launch_session` and its `template` parameter, and every such session starts signed in. Agents never see your passwords, and by default they never see the cookie values either.

## Concepts

| Term | Meaning |
|---|---|
| **Template** | A named browser identity (`job-hunt`), with an id (`tp-…`). It has sites, a pinned identity (seed, locale, timezone), an optional proxy, an access rule, a session cap and sealing settings. Agents address it by its name. |
| **Site** | One registrable domain the template is signed in to, such as `linkedin.com`. `www.linkedin.com` and `uk.linkedin.com` are the same site. A template has 1 to 16 sites. |
| **The template's browser** | One Chromium with a persistent profile under `<data-dir>/templates/<id>/userdata`. Every session of the template runs in it and shares its cookies, storage, fingerprint and IP address. |
| **Session and its windows** | Each session launched from a template gets its own window (or windows) in that browser and sees only its own pages. `list_tabs`, screenshots, the live view and every page tool reach only pages the session opened, or that a page of it opened. |
| **Other windows** ("parked") | Pages of the template's browser that belong to no session: a tab or window you open by hand, the browser's first window, pages BrowserHive opens for its own work. No agent can reach them. |
| **Recording session** | The session that holds the sign-in window while you sign in. It is BrowserHive's, owned by you, shown as "BrowserHive (system)", and never visible to agents. |

A template's status is `recording` ("setting up") until you finish signing in, then `ready`. Only `ready` templates can be launched.

## The template's browser

- **It starts on demand.** The first launch (or a recording) starts it; it stops after `templateHostIdleTimeout` (default `1h`) with no session, and is restarted after `templateRecycleAfter` (default `24h`) once its sessions have finished (at most `templateDrainTimeout`, default `15m`).
- **It counts as one browser.** `maxSessions` bounds browsers: a template's browser takes one slot however many sessions it serves. `server_status` reports that browser count; the System page's capacity shows both sessions and browsers.
- **It is headed by default.** It needs a display on the machine running BrowserHive; see [Displays](#displays).
- **Windows open in the background.** On a desktop a session's windows open without taking the focus, and agent windows are never raised or moved. The one exception is the browser's start: its first window appears as a normal window before BrowserHive minimizes it, so starting a template's browser (the first launch after it was stopped) can take the focus once.
- **If it crashes,** every session of the template ends at once (agents get `SESSION_DEAD`) and the browser restarts after 5 s, 15 s, 45 s, 135 s and 405 s; after five failures in 30 minutes it stays down until you restart it (`browserhive templates host <name> restart`) or BrowserHive. If you quit it yourself (close its windows), its sessions end and it starts again at the next launch.
- **It has a memory limit.** BrowserHive measures the memory of each template's browser (all its processes) every 60 s. Above `templateRecycleRss` (default `3GiB`), it closes the largest page of the session whose pages hold the most JavaScript memory, and that session gets a [`SESSION_RESOURCE_LIMIT`](../reference/errors.md#SESSION_RESOURCE_LIMIT) warning. If the browser is still above the limit 5 minutes later, it is restarted: sessions get up to `templateDrainTimeout` to finish, then close.
- **Its sign-ins are saved, encrypted.** While it runs, BrowserHive keeps an encrypted checkpoint of its cookies and storage, and writes numbered versions at milestones ([Versions](#versions-and-the-checkpoint)).
- **Leftovers of a killed BrowserHive** (a template browser still holding its profile) are terminated when BrowserHive starts again.
- **Saved passwords, autofill and browser sign-in are off** in it: Chromium never offers "Save password?", fills nothing in, and keeps its password store (`Login Data`) empty. Your password manager extensions and your saved passwords are not available in it either.

## Create a template and sign in

Creating and signing in needs a running server with the dashboard API (`--admin`). The sign-in window opens **on the machine running BrowserHive**, wherever you run the command or call the API from.

### From the command line

```bash
browserhive --admin            # in one terminal (or your service)
browserhive templates create job-hunt --sites linkedin.com,indeed.com --allPrincipals
```

1. BrowserHive creates the template (status "setting up") and opens one window titled `[BrowserHive] Sign in to linkedin.com, indeed.com`. Its first tab is a short instructions page; there is one more tab per site, at `https://<site>/`.
2. Sign in to each site in its tab, by hand. Type rather than paste, and check the address bar before you type a password. Passkeys and security keys on that machine work as in any browser.
3. The command prints one line per site. Press **Enter** when you have signed in to every site.
4. On Enter, BrowserHive treats every site you have not confirmed as "I'm signed in" ([below](#how-browserhive-knows-you-signed-in)), lists any [unlisted sign-ins](#unlisted-sign-ins) and removes them unless you answer no, closes the window and sets the template `ready`.

Agents can now launch it. `browserhive templates list` shows it with a mark per site.

Options worth knowing (all in [the CLI guide](cli.md#templates)):

- `--allPrincipals` or `--principal <subject>` (repeatable) decides who may launch the template. Under `--auth token` one of them is required. Under `--auth off` every agent is `local`, so leaving both out stores `local`; after a later switch to `--auth token` such a template is reachable by no agent until you recreate it with an explicit choice.
- `--channel`, `--stealth`, `--proxy`, `--locale` and `--timezone` set the template's browser and identity, which are fixed from then on ([Identity](#identity)). With `--proxy`, `--locale` and `--timezone` are required. Give the proxy password as the **name** of an environment variable (`--proxyPasswordEnv`), never the value.
- `--maxConcurrent` (1 to 20, default 5) caps the template's concurrent sessions.
- `--noLogin` creates the template and opens no window. `--timeout` (default `30m`) bounds the wait; at the timeout the template stays "setting up".
- `--headless` runs the template's browser without a window. Sites challenge headless browsers more often, and you cannot sign in by hand in a window nobody can see, so keep templates headed unless you have a reason.

### How BrowserHive knows you signed in

When the window opens, BrowserHive notes the names of the cookies already in the template's browser. When you confirm a site ("I'm signed in", or Enter on the command line), it looks at the cookies that appeared since then on that site's registrable domain, leaves out analytics cookies (`_ga*`, `_gid`, `_gat*`, `_fbp`, `_fbc`, `__cf_bm`, `_cfuvid`, `__utm*`, `_hj*`, `_uetsid`, `_uetvid`, `ajs_*`), and remembers up to 16 of their names as that site's sign-in cookies. It never stores a value.

If no new cookie appeared on the site, the confirmation is refused (`409 CONFLICT`) and the site stays signed out. That usually means the sign-in did not finish, or happened on another domain (a single sign-on provider); finish it in the site's own tab and confirm again.

### Unlisted sign-ins

The template's browser keeps every sign-in that happens in it, including ones on domains that are not its sites: if you open your webmail in the sign-in window to read a code, the template is now signed in to your webmail too, and **agents can use that sign-in**.

BrowserHive lists such domains as "Also signed in to: … — agents can use this": every registrable domain that holds a persistent `HttpOnly` and `Secure` cookie and is not a site of the template. The command line removes them at Finish unless you answer no. Removing a sign-in clears that domain's cookies and the site data (local and session storage, IndexedDB, service workers, Cache Storage) of every origin under it that the template's browser has visited or holds data for, subdomains included. The result lists the origins it cleared and any it could not clear (`uncleared_origins`, also logged as a warning); a sign-in may survive on an origin listed there. It does not sign you out at the site. The sign-in window closes before the removal, so none of its tabs writes the sign-in back.

### Finish, cancel and finish later

- **Finish** (Enter, `templates finish <name>`, or `POST …/recording/finish`) closes the window, sets the template `ready` and saves its sign-ins as version 1 ([Versions](#versions-and-the-checkpoint)). A site you never confirmed is kept and marked signed out; agents can still launch the template.
- **Cancel** (`DELETE …/recording`) closes the window. The template stays "setting up", and sign-ins you completed stay in its browser.
- **Finish later.** When `--timeout` runs out, or after a cancel, the template stays "setting up". Run `browserhive templates finish job-hunt` to complete it. To open the sign-in window again first, call `POST /api/v1/templates/{id}/recording`; a "Continue sign-in" action arrives with the dashboard pages in a later release.

Closing the sign-in window by hand cancels nothing: the template's browser keeps running, and the recording stays open until you finish or cancel.

While the sign-in window is open, every agent window of that template is minimized and new agent windows open minimized, so you are not typing into an agent's page by mistake. A window an agent's site opens by itself meanwhile (a popup, a new tab) is minimized as soon as it appears, or closed when Chromium placed it in your sign-in window, and the sign-in window is shown again; an agent's `set_viewport` does not restore a minimized window.

The residual risk: Chromium shows a site-opened popup as an active window before BrowserHive can minimize it, so for a moment it can take the keyboard focus, and a page can call `window.focus()`. Keystrokes typed in that instant can land in the agent's page. If agents may be using the template, check the window title (`[BrowserHive] Sign in to …`) before you type a password, or sign in while no agent session is open.

### Over the REST API

Every step is an operator API call under `/api/v1` (scopes in [Access](#access)). The routes take the template's id, which `POST /templates` and `GET /templates` return.

```bash
H='Authorization: Bearer <operator token>'
B=http://127.0.0.1:9876/api/v1

# 1. Create (status "recording"). Under auth=token, policy.authorized_principals is required; [] = every agent.
curl -sH "$H" -H 'Content-Type: application/json' -X POST $B/templates \
  -d '{"name":"job-hunt","sites":[{"site_id":"linkedin.com"},{"site_id":"indeed.com"}],"policy":{"authorized_principals":[]}}'

# 2. Open the sign-in window on the BrowserHive machine (optionally {"sites":[…]} to open only some).
curl -sH "$H" -H 'Content-Type: application/json' -X POST $B/templates/tp-…/recording -d '{}'

# 3. After signing in to a site: "I'm signed in".
curl -sH "$H" -H 'Content-Type: application/json' -X POST $B/templates/tp-…/recording/confirm -d '{"site_id":"linkedin.com"}'

# 4. Check for unlisted sign-ins, then finish and remove the ones you do not want agents to use.
curl -sH "$H" $B/templates/tp-… | jq .unlisted_domains
curl -sH "$H" -H 'Content-Type: application/json' -X POST $B/templates/tp-…/recording/finish -d '{"remove_sign_ins":["mail.example"]}'
```

| Call | Scope | Result |
|---|---|---|
| `POST /templates` | `templates:write` | `{template}`, status `recording`. `409 TEMPLATE_NAME_TAKEN` for a used name. |
| `POST /templates/{id}/recording` `{sites?}` | `templates:login` | `{session_id, host}`. An open recording is returned again and its window raised. |
| `POST /templates/{id}/recording/confirm` `{site_id}` | `templates:login` | `{site}` with its learned cookie names. `409 CONFLICT` when no recording is open or no new cookie appeared on the site. |
| `POST /templates/{id}/recording/finish` `{remove_sign_ins?}` | `templates:login` | `{template, version}`; the template is `ready`. `version` is the version written (1 for a new template), or `null` when the template's browser was not running or no [key](#backups-and-the-template-key) is available. |
| `DELETE /templates/{id}/recording` | `templates:login` | Closes the window; the template stays `recording`. |
| `GET /templates/{id}` | `templates:read` | The template, its browser (`host`, with `state`, `last_error` and `profile_secrets`), its sites, and `unlisted_domains` (computed while the browser runs). |
| `POST /templates/{id}/domains/{domain}/remove-sign-in` | `templates:write` | `{ok, cookies_removed, origins_cleared, uncleared_origins}`: clears that registrable domain's cookies and the site data of every origin under it. |
| `POST /templates/{id}/host/clear-profile-secrets` | `templates:write` | `{ok}`: empties saved passwords and autofill data ([below](#saved-passwords-and-autofill)). |
| `DELETE /templates/{id}` | `templates:write` | Stops the browser and deletes `templates/<id>/`. `409 TEMPLATE_IN_USE` while sessions run; `?force=true` closes them. |

The [REST reference](../reference/api.md#templates) lists every route with its fields.

### Google and other sites that refuse automated browsers

Google, and some other sites, may refuse a sign-in in a browser that is controlled through automation, and a template's browser is one whoever types in it. Whether a person can complete the Google sign-in in a template's browser is still being verified by hand. If a site refuses, sign in to it in a browser it accepts and [seed the template from that browser's storage state](#seeding-from-a-storage-state).

### Delete a template

```bash
browserhive templates rm job-hunt
```

It asks you to type the name again (or pass `--yes` in scripts), refuses while sessions run unless `--force`, stops the template's browser and deletes its directory. Deleting does not sign you out at the sites: the sign-ins stay valid there until they expire or you sign out elsewhere.

## How agents use a template

### `list_templates`

[`list_templates`](../reference/tools.md#list_templates) lists only the templates the calling agent may launch. A template it may not use is absent, never marked. Each entry has:

| Field | Meaning |
|---|---|
| `name` | What the agent passes as `template`. |
| `display_name`, `description` | Your text. Write the description for the agent: what the template is for. |
| `sites[]` | `site`, `title`, `status` (`signed_in`, `signed_out`, `challenged`, `inconclusive`, `unknown`) and `checked_at`. A site you confirmed while signing in is `signed_in`, one you did not is `signed_out`. BrowserHive does not check sites again until health checks arrive in a later release, so a status can be out of date. |
| `availability` | `available` (a launch would be admitted now; a stopped browser counts as available), `busy` (at its cap), `needs_login` (every site is signed out), `unavailable` (not ready, or cannot run until you act). |
| `sealed` | Whether sessions of this template are sealed for this agent. |

### `launch_session` with `template`

```jsonc
launch_session({ "slug": "jobs", "template": "job-hunt" })   // → { "session_id": "jobs-a1b2c3d4", "template": { "name": "job-hunt", "sites": [...] }, ... }
navigate({ "session_id": "jobs-a1b2c3d4", "url": "https://www.linkedin.com/jobs/" })
close_session({ "session_id": "jobs-a1b2c3d4" })
```

`slug` is still required and names the session as usual. The result, `list_sessions` and `session_info` carry a `template` key with the name and its sites' status; sessions without a template do not.

### Options a template fixes

The template decides its browser and identity, so some `launch_session` arguments are refused or ignored:

| Argument | On a template launch |
|---|---|
| `channel`, `headless`, `incognito`, `vault_enabled` | Ignored; the template's values apply. |
| `stealth`, `fingerprint` | Refused when present and different from the template's. |
| `persistence_mode` | `memory` accepted; `persistent` and `storage-state` refused. |
| `restore_profile` | Refused when present. |
| `launch_options` | Refused when it has any key (`{}` is accepted). |
| `context_options` | `viewport`, `extraHTTPHeaders` and `colorScheme` apply to that session only; any other key is refused. |
| `humanize`, `disable_evaluate` | Applied as sent; a sealed template forces `disable_evaluate`. |

A refusal is [`INVALID_ARGUMENTS`](../reference/errors.md#INVALID_ARGUMENTS) with one issue per option, such as `template 'job-hunt' fixes context_options.locale; omit it`. Options are refused by presence, not by comparing values, so an agent cannot learn your proxy or coordinates by guessing them.

### Launch errors

| Code | When |
|---|---|
| [`TEMPLATE_NOT_FOUND`](../reference/errors.md#TEMPLATE_NOT_FOUND) | No template has that name, the agent's principal or harness is not allowed, the template is still being set up, or `templates=false`. All answer identically. |
| [`TEMPLATE_BUSY`](../reference/errors.md#TEMPLATE_BUSY) | The template is at its cap, or a page cap is reached ([Capacity](#capacity)). |
| [`TEMPLATE_UNAVAILABLE`](../reference/errors.md#TEMPLATE_UNAVAILABLE) | The browser is starting, restarting (also during a restore or a seed) or recovering from a crash; retry after `retry_after_ms`. |
| [`TEMPLATE_DISABLED`](../reference/errors.md#TEMPLATE_DISABLED) | You disabled the template, or its browser cannot start until you act. The cause (`disabled`, `no_display`, `host_failed`, `proxy_unreachable`, `sandbox_unavailable`) is shown to you only: in `GET /templates/{id}` (`host.state`, `host.last_error`), the log, and `templates list`. See [Troubleshooting](troubleshooting.md#session-templates). |
| [`SESSION_LIMIT_REACHED`](../reference/errors.md#SESSION_LIMIT_REACHED) | The template's browser is not running and every browser slot is taken. |

What agents are told is limited to what they can and cannot do; no agent-visible text explains the shared browser or reveals that other sessions exist.

## Sealing

Template sessions are **sealed** unless you unseal the template. Sealing keeps the raw sign-in material (cookie values and storage exports) out of what agents receive.

| Unseal flag | Sealed (default) | Unsealed |
|---|---|---|
| `cookie_values` | `get_cookies` returns only cookies of the template's sites, each with an empty `value` (name, domain, path, expiry and flags kept), and `sealed: true`. Text results are redacted (below). | Full values of every cookie, and no redaction. |
| `evaluate` | `evaluate` answers [`EVALUATE_DISABLED`](../reference/errors.md#EVALUATE_DISABLED), as for a session launched with `disable_evaluate: true`. | The session's `disable_evaluate` and the server's `allowEvaluate` apply as usual. |
| `cookie_writes` | `set_cookies` answers [`SESSION_SEALED`](../reference/errors.md#SESSION_SEALED). | Allowed; it changes the sign-ins of every session of the template. |
| `state_export` | `save_storage_state` answers `SESSION_SEALED`. | Allowed; the snapshot is saved under the agent's own saved logins, with `source_template_id` in its manifest. |

**Redaction.** In a session without `cookie_values`, every text result (and the result text BrowserHive stores for the tool call) has every occurrence of a value of 12 or more characters replaced with `[sealed]`: of any cookie currently in the template's browser (and the template sites' cookies of the last 10 minutes), and of the local storage, session storage and IndexedDB of the session's open pages on the template's sites. The value is matched as is and in its JSON-escaped, URL-encoded and HTML-escaped forms. Results about several sessions (`list_sessions`) are redacted with the values of every sealed session of the caller. Screenshots and the live view are not redacted, nor are tokens a page shows that are neither a cookie nor a stored value, nor other encodings (base64, a value split by markup).

**Unsealing.** Set the flags in `policy.unseal` when you create the template over the REST API, optionally only for some principals:

```json
{ "policy": { "unseal": { "evaluate": true, "principals": ["research-bot"] } } }
```

Without `principals` (or with `[]`) the flags apply to every principal the template allows; with a list, every other principal's sessions stay sealed. The command line creates sealed templates. To change sealing later, send `policy.unseal` with `PATCH /api/v1/templates/{id}` ([Manage a template](#manage-a-template)): it replaces every flag and applies to live sessions at once.

Before you unseal, know what each flag gives away:

- `cookie_values` and `state_export` let agents copy the sign-ins out of BrowserHive. A session started from an exported state is a copy of the sign-in and can sign the template out.
- `evaluate` lets an agent read storage and non-HttpOnly cookies and run code that other sessions of the template will load (storage, caches, service workers). Treat it as unsealing everything for every agent it applies to.
- `cookie_writes` lets an agent change the sign-ins of every session of the template.

**What sealing does not do.** It does not stop an agent from acting as the account: with `click`, `fill` and `snapshot` an agent can do anything you could do in the site, including creating new credentials (an API token, an app password, a recovery address) and reading what pages display. The site's own scripts still read their cookies as usual. And it holds only against agents whose sole access is BrowserHive's MCP interface; see [Security](security.md#session-templates).

### Always on in template sessions

Sealed or not:

- `save_full_profile` answers [`INVALID_PERSISTENCE_CONFIG`](../reference/errors.md#INVALID_PERSISTENCE_CONFIG).
- The vault is not available: `vault_list_available` returns no entries with a note, and `vault_fill` returns `blocked` (`not_authorized`) and writes a `vault_access` audit row with the reason `template_session`. A fill would sign every session of the template in, past the binding's own rules; keeping the template signed in is your job.
- `navigate` and `new_tab` open `http:`, `https:` and `about:blank` only: `data:` is refused too (other sessions still allow it), with [`URL_SCHEME_NOT_ALLOWED`](../reference/errors.md#URL_SCHEME_NOT_ALLOWED). BrowserHive's own addresses answer [`URL_BLOCKED`](../reference/errors.md#URL_BLOCKED) with the pattern `#browserhive`.
- `press_key` refuses clipboard shortcuts (Ctrl/Cmd+C, V and X, Shift+Insert, Ctrl+Insert) with `INVALID_ARGUMENTS`: on a headed browser a paste would read your clipboard. `click` refuses the middle button for the same reason (on Linux a middle click pastes the primary selection, whatever you last highlighted).
- `switch_tab` brings the tab to the front only on a headless template, so a headed template's windows never steal your focus.
- `set_viewport` also resizes the session's window on a headed template (never moves it).
- A screenshot that does not finish in 10 s is retried once directly from the window surface, because minimized windows can stall rendering.
- Tracing is off: `GET /api/v1/sessions/{id}/trace.zip` answers [`TRACE_UNAVAILABLE`](../reference/errors.md#TRACE_UNAVAILABLE). A browser-wide trace would record every session's pages.
- Downloads are saved into the session's own downloads folder; a download no session claims within 60 s is deleted.
- `server_status.sessions.count` counts browsers, not template sessions.

## What agents can observe

These follow from the shared browser. No agent-facing text explains them, but an agent can notice them:

- **Shared state.** Cookies and storage change underneath a session when another session of the template acts; `storage` events, BroadcastChannel and SharedWorker messages arrive from other windows; service workers are shared.
- **Shared sign-out.** If one session (or the site) signs the account out, every session of the template is signed out.
- **Shared fate.** A browser crash ends every session of the template with `SESSION_DEAD`; while the browser restarts, launches answer `TEMPLATE_UNAVAILABLE`.
- **Focus.** Every agent page reports itself visible and focused at once. A background tab of a headed browser runs animation frames at about 15 per second.
- **Placement.** Chromium puts a tab a site opens into the last active window, so a tab opened from one session's popup can appear in another session's window. It still belongs to the session whose page opened it.
- **Sealing refusals** (`SESSION_SEALED`, `EVALUATE_DISABLED`, empty cookie values, `[sealed]`) and the vault refusal show that the session comes from a template.

## Access

Operators create, record and delete templates. Agents only list and launch them; no tool changes a template.

- **Who may launch.** The template's access rule lists principals (`policy.authorized_principals`; empty = any principal) and optionally harnesses (`policy.harnesses`, matched as in [vault harness lists](vault.md#harness-restrictions)). The harness list is a guard against mistakes, not a security boundary: real separation is one token per agent. A refused agent gets `TEMPLATE_NOT_FOUND`, and the log line `template launch refused` tells you why.
- **Sessions belong to whoever launched them**, as always: another agent cannot see or drive them. The recording session belongs to no agent.
- **Operator scopes.** `templates:read` lists and reads templates, their versions and running operations, and tests access; `templates:write` creates, edits, disables, enables and deletes templates, starts and stops their browsers, saves, pins and restores versions, seeds, removes sign-ins and clears profile secrets; `templates:login` opens, confirms, finishes and cancels a recording. Operator tokens issued without `scopes` hold all three.
- **Watching sessions.** Template sessions appear in the dashboard's session list and in `GET /api/v1/sessions` like any other, with `template` and `sealed`. Filter with `template=<id>`; the recording session is left out unless you pass `maintenance=include` (or `only`). Their live view and screenshots need `templates:read` in addition to the session scopes; those of a recording session need `templates:login`, because it shows you typing.

## Capacity

- **Per template.** At most `max_concurrent` sessions at once (default 5, range 1 to 20; `--maxConcurrent` or `policy.max_concurrent`). Beyond it: `TEMPLATE_BUSY`.
- **Pages.** At most `templateMaxPagesPerHost` agent pages per template browser (default 40), and per session `max(2, floor(templateMaxPagesPerHost / max_concurrent))`, whoever opens them. A launch or `new_tab` beyond the browser's limit answers `TEMPLATE_BUSY` (`limit_kind: capacity`); a `new_tab` beyond the session's share answers it with `limit_kind: tabs`. A page a site opens beyond the session's share is closed, with a `SESSION_PAGE_LIMIT` warning.
- **Browser slots.** A running template browser uses one `maxSessions` slot, whatever its number of sessions. Each extra session in it costs a window's memory (about 160 to 170 MB in measurements), not a whole browser's.

## Identity

A template is one person on one device. What a site can use to tell devices apart is fixed:

- **At creation:** the fingerprint seed, the locale and languages, the timezone (from this machine, or `--locale` and `--timezone`), and coordinates only if you give them. A later change of the machine's `TZ` does not change a template's timezone. These cannot be changed; a different identity is a different template.
- **At the first start:** the observed Chrome version, user agent, screen and window size are recorded, never faked.
- **Identity drift.** When a later start reports a different Chrome major version (Chrome updated), BrowserHive logs it and records it on the template; launches continue. Some sites ask you to sign in again after a browser update.

## Displays

A headed template needs a display on the machine running BrowserHive. A start without one fails with `no_display`, the template's browser stays down, and launches answer `TEMPLATE_DISABLED`.

### Desktops

- **Linux:** a desktop session (`DISPLAY` or `WAYLAND_DISPLAY` set in BrowserHive's environment).
- **macOS:** a logged-in user session. As a service, use a **LaunchAgent**, not a LaunchDaemon.
- **Windows:** an interactive session. A Windows service runs in Session 0 and has no display.

### Servers: Xvfb

Run BrowserHive under `xvfb-run`, which creates an X authority cookie for its display:

```bash
xvfb-run -a browserhive serve --admin
```

Or run a sidecar Xvfb with an authority file and point BrowserHive at it:

```bash
xauth -f /var/lib/browserhive/.Xauthority add :99 . "$(mcookie)"
Xvfb :99 -nolisten tcp -auth /var/lib/browserhive/.Xauthority &
DISPLAY=:99 XAUTHORITY=/var/lib/browserhive/.Xauthority browserhive serve --admin
```

Never run a bare `Xvfb :99`: without `-auth`, every local user can watch and drive the signed-in windows.

### Signing in on Xvfb: VNC

Nobody can see an Xvfb window, so to sign in, attach a VNC server to that display, bound to loopback, and reach it over an SSH tunnel:

```bash
# on the server
x11vnc -display :99 -auth /var/lib/browserhive/.Xauthority -localhost
# on your machine
ssh -L 5900:127.0.0.1:5900 server
# then open a VNC viewer on 127.0.0.1:5900 and run templates create on the server
```

`templates create` warns when `--url` points at another machine, because the window opens there, not on yours.

## Saved passwords and autofill

Saved passwords and autofill are off in a template's browser. If its profile still holds some (for example a profile created by an earlier build, or copied in), BrowserHive reports it at the browser's start (`host.profile_secrets` in `GET /templates/{id}`), because agents could trigger autofill. Clear them with `POST /templates/{id}/host/clear-profile-secrets`; this stops the browser, which starts again on the next use.

## Manage a template

Every change below is an operator call (scopes in [Access](#access)) and is recorded in the audit log. The dashboard's Templates pages arrive in a later release; until then use the command line or the REST API. REST paths are under `/api/v1/templates/{id}`.

| Task | Command line | REST |
|---|---|---|
| Show a template, its browser and its sites | `templates show <name>` | `GET` |
| Start, stop or restart its browser | `templates host <name> start\|stop\|restart` | `POST …/host/start`, `…/host/stop`, `…/host/restart` |
| Disable or enable it | `templates disable <name>`, `templates enable <name>` | `POST …/disable`, `…/enable` |
| Edit it | — | `PATCH` |
| Add, change or remove a site | — | `PUT …/sites/{site}`, `DELETE …/sites/{site}` |
| Close one of its other windows | — | `POST …/host/pages/{target_id}/close` |
| Test whether a principal and harness may launch it | — | `POST …/access/resolve` |
| Open its data directory in the file manager | — | `POST …/data-dir/reveal` |
| List, save, pin and restore versions; seed | [below](#versions-and-the-checkpoint) | [below](#versions-and-the-checkpoint) |

- **Stop** writes a final checkpoint, closes the browser and ends its sessions. **Restart** gives sessions up to `templateDrainTimeout` to finish, then closes them and starts the browser again. Restart also clears a browser that stopped trying after five failures (`host_failed`).
- **Disable** ends the template's live sessions and refuses new launches (agents get `TEMPLATE_DISABLED`). Its browser cannot be started, and seeding is refused, until you **enable** it again.
- **Edit** (`PATCH`) changes the name, display name, description, browser channel, headless mode, humanize, proxy, how agent windows open (`agent_windows`) and the policy (access, cap, sealing). Renaming changes the name agents pass as `template`. The identity stays fixed ([Identity](#identity)). Changing `proxy` or `channel` restarts the browser and needs `confirm_identity_change: true`, because a site may sign the account out when the IP address or browser changes. An access change ends the live sessions whose principal or harness lost access, and a sealing change applies to live sessions at once; the answer lists the sessions it closed (`closed_sessions`).
- **Removing a site** leaves its sign-in in the template's browser. [Remove the sign-in](#unlisted-sign-ins) too if agents should not use it. A template keeps at least one site.

## Versions and the checkpoint

BrowserHive keeps encrypted copies of a template's sign-ins, so you can roll the template back.

- **The checkpoint** (`latest`) is one rolling copy. It is rewritten every `templateCheckpointInterval` (default `15m`) while the template's browser runs, when the browser stops cleanly (an idle stop, `templates host <name> stop`) and when BrowserHive shuts down. It is not a version.
- **Versions** are numbered copies, written at milestones only:

| Reason | Written when |
|---|---|
| `recording` | You finish signing in (version 1). Only when the template's browser is running and a [key](#backups-and-the-template-key) is available; otherwise Finish answers `version: null`. |
| `manual` | You ask: `browserhive templates save <name>`, or `POST …/versions`. The browser must be running (otherwise `409`). When nothing changed since the newest version, nothing is written (`version: null`). |
| `restore` | A [restore](#restoring-a-version) finished. |
| `import` | The template was [seeded](#seeding-from-a-storage-state). |
| `signin_change` | At a checkpoint, the sign-in cookies present for a site differ from the newest version's: you signed in again, or the site signed the template out. |
| `daily` | At the first checkpoint of a day (this machine's local time), when the state's structure differs from the newest version's: which cookies (domain and name), local storage keys and IndexedDB databases exist, never their values. |

A site that refreshes its session cookie's value never causes a version. `signin_change` looks at the sign-in cookie names BrowserHive learned when you confirmed the site ([How BrowserHive knows you signed in](#how-browserhive-knows-you-signed-in)), so a site you never confirmed in a sign-in window (for example on a template you only seeded) does not trigger it. Versions after a re-login arrive with health checks in a later release.

**What a copy holds.** The cookies, local storage and IndexedDB of every origin the browser holds data for. Not session storage, service workers, Cache Storage, the HTTP cache, permissions, history or saved passwords; the live profile keeps those, but a restore does not bring them back. An origin the browser has not visited since it last started is carried forward from the previous checkpoint, so a sign-in kept in local storage survives a browser restart. A sign-in you remove is removed from the next checkpoint too. A copy is at most 64 MiB: above that, the IndexedDB data of the largest origins is left out, and [`TEMPLATE_CHECKPOINT_TOO_LARGE`](../reference/errors.md#TEMPLATE_CHECKPOINT_TOO_LARGE) names them. A failed write records [`TEMPLATE_CHECKPOINT_FAILED`](../reference/errors.md#TEMPLATE_CHECKPOINT_FAILED) and keeps the previous file.

**Retention.** Each template keeps its newest `templateVersionsKeep` versions (default 10, 1 to 100), every pinned version, and its **Last good** version: the newest one written while every enabled site was signed in. Older versions are deleted with their files. Pin or unpin a version with `PATCH /api/v1/templates/{id}/versions/{version}` and `{"pinned": true}` or `false`.

**The list.** `browserhive templates versions <name>` (or `GET …/versions`) shows each version, newest first, with its reason, time, size, how many enabled sites were signed in when it was written, whether it is pinned or Last good, and whether it can be read with the current key; the checkpoint is under the table. Each version also records per site its cookie count and the names of the sign-in cookies present, never a value.

## Restoring a version

```bash
browserhive templates versions job-hunt
browserhive templates restore job-hunt 3        # or: latest, the rolling checkpoint
```

A restore runs on the server as an operation. Over the REST API, `POST /api/v1/templates/{id}/versions/{version}/restore` (`version` may be `latest`) answers `202 {operation_id}`; `GET /api/v1/templates/operations/{operation_id}` reports `running`, `done` (with the version written) or `failed`.

1. **The template's sessions end.** By default they get up to `templateDrainTimeout` (default `15m`) to finish and are then closed; with `--forceClose` (`{"force_close": true}`) they close at once. Sessions BrowserHive closes end with the reason `operator`. Meanwhile launches answer `TEMPLATE_UNAVAILABLE` (`restarting`).
2. **The browser restarts.** It stops (writing a final checkpoint) and starts again.
3. **The version is applied** and saved as a new `restore` version. Old versions are never changed.

A restore brings back sign-ins, not a clean profile. It clears the cookies and storage of the origins in the version and of the origins the browser visited since it started, then sets the version's; other origins keep their data. BrowserHive does not check the sites after a restore yet (health checks arrive in a later release), so open a session and look.

`templates restore` asks you to type the template's name on a terminal and refuses without one unless `--yes`. It waits for the operation; Ctrl+C stops waiting, and the restore goes on. A version deleted by retention answers [`TEMPLATE_VERSION_NOT_FOUND`](../reference/errors.md#TEMPLATE_VERSION_NOT_FOUND). A version written with a key BrowserHive does not hold answers `409` [`TEMPLATE_VERSION_UNREADABLE`](../reference/errors.md#TEMPLATE_VERSION_UNREADABLE) ([Rotating the key](#rotating-the-key)).

## Seeding from a storage state

Instead of signing in in the template's browser, you can give BrowserHive a Playwright storage state: a JSON file with the cookies and per-origin storage of a browser that is already signed in. Use it when nobody can see the template's window (a server on Xvfb without VNC), or when a site refuses a sign-in in the template's browser because it is controlled through automation.

1. Sign in to the sites in a separate browser profile the site accepts, and save its storage state:
   - From a BrowserHive session that is not a template session: sign in in it (for example during a [takeover](attention.md)) and call `save_storage_state` with a name. The file is `<data-dir>/auth-states/<name>.storage.json` (under `auth-states/p/<id>/` for a token principal).
   - With Playwright: `npx playwright open --save-storage=state.json https://www.linkedin.com/`, sign in, and close the browser.
2. Seed a new template, or an existing one:

   ```bash
   browserhive templates create job-hunt --sites linkedin.com --allPrincipals --fromState state.json
   browserhive templates seed job-hunt state.json
   ```

3. Delete the file. It is a plaintext copy of your sign-ins.

Seeding follows the restore steps above, except that the template's live sessions close at once: the browser restarts, the state is applied, an `import` version is written and the template becomes `ready`. Over the REST API, `POST /api/v1/templates/{id}/state` takes the JSON as the body (at most 16 MiB) and answers `202 {operation_id}`; over a `ready` template it needs `?confirm=true`, otherwise `409 CONFLICT`.

- The command checks the file (at most 16 MiB, Playwright's `{"cookies": […], "origins": […]}` shape) before it sends or creates anything. `templates seed` asks you to type the template's name, or `--yes`. It prints each site's status and exits `2` when a site is signed out or needs a check.
- If seeding a template made with `create --fromState` fails, the template stays "setting up": seed it again, or delete it.
- BrowserHive reads the file in memory and never stores it in plain text; it keeps only the encrypted `import` version.
- The template keeps its own pinned identity (fingerprint, locale, timezone, proxy), not the source browser's. A site may treat the first visit as a new device and ask you to confirm it.
- A headed template's browser still needs a display to start, even if nobody looks at it ([Displays](#displays)).

## Backups and the template key

```
<data-dir>/
  admin/template.key              the template key, when templateKey is not set (0600)
  templates/<id>/                 0700
    userdata/                     the live browser profile (not encrypted)
    versions/latest.state.enc     the checkpoint (encrypted)
    versions/v<N>.state.enc       version N (encrypted)
    versions/v<N>.meta.json       version N's facts: reason, time, size, key id, and per site the cookie count and sign-in cookie names (never values)
    downloads/                    the browser's downloads
```

**Encryption.** Every checkpoint and version file is encrypted with AES-256-GCM under the template key, with a new random nonce for each file. The file's header names the key that wrote it (a key id: the first 8 bytes of the key's SHA-256), and the file is bound to its template and slot, so a file moved to another template or version, or with an altered header, does not open. Files are written to a `.tmp` file (`0600`), flushed to disk and renamed. Decrypted state exists only in memory. At startup BrowserHive deletes leftover `.tmp` files and version files the database has no row for; a version whose file is missing shows as unreadable. What encryption does and does not protect is in [Security](security.md#encryption-at-rest).

**The key** is `templateKey` when it is set: base64 of exactly 32 bytes, for example from `openssl rand -base64 32`. Set it with the environment variable `BROWSERHIVE_TEMPLATE_KEY` (or an `{env:…}` [reference](configuration.md#references) in the config file). `--templateKey` works but logs a warning, because other users of the machine can read process arguments. Without `templateKey`, BrowserHive uses `<data-dir>/admin/template.key` (`0600`), which it creates at startup when the file is absent and no encrypted file exists yet. With the key outside the data directory, a copy of the data directory alone cannot be decrypted.

BrowserHive never creates a key file while encrypted files exist. If the key is gone (the key file deleted, `templateKey` no longer set), it records [`TEMPLATE_KEY_MISSING`](../reference/errors.md#TEMPLATE_KEY_MISSING): checkpoints and versions are skipped and restores refused, while template browsers and their sessions keep running (the live profile needs no key). Files written with a key BrowserHive does not hold record [`TEMPLATE_KEY_MISMATCH`](../reference/errors.md#TEMPLATE_KEY_MISMATCH) and show as unreadable. Agents never see either.

**Backups.** `browserhive db backup` and the pre-migration backups contain the templates' settings and version rows, not their files. To back up a template, copy `<data-dir>/templates/<id>/` while its browser is stopped (`templates host <name> stop`), and back up the key: `admin/template.key`, or your `templateKey` value. Store the key apart from the files. A copy that travels with its key is as readable as plaintext, and the live profile in `userdata/` is not encrypted at all ([Security](security.md#encryption-at-rest)).

When you restore an older database backup, BrowserHive deletes at the next start the version files the restored database has no row for, and versions whose files are gone show as unreadable. Encrypted export and import of a template are not available yet.

## Rotating the key

1. Generate a new key (`openssl rand -base64 32`) and keep it where your service keeps secrets.
2. Set the new key as `templateKey` (`BROWSERHIVE_TEMPLATE_KEY`) and the current one as `templateKeyPrevious` (`BROWSERHIVE_TEMPLATE_KEY_PREVIOUS`). The current key is your old `templateKey` value, or the contents of `admin/template.key`. Restart BrowserHive. It now writes with the new key only, and can still read files written with the old one.
3. Stop BrowserHive and re-encrypt the files, in the same environment so the command resolves the same keys:

   ```bash
   browserhive templates rekey --oldKeyEnv BROWSERHIVE_TEMPLATE_KEY_PREVIOUS
   ```

   `--oldKeyEnv` takes the name of the variable that holds the old key, never the key. `rekey` refuses while a server uses the data directory (exit code `3`). It rewrites every file not yet on the current key and updates the version rows. It is safe to run again: a second run completes an interrupted one and skips the files already done.
4. Remove `templateKeyPrevious` and start BrowserHive. If the old key was `admin/template.key`, delete that file; it is not used while `templateKey` is set.

Rotation protects copies made from now on. Copies made before it can still be read by anyone who has the old key.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| [`templates`](../reference/configuration.md#templates) | `true` | `false` turns templates off: `list_templates` answers `TOOL_NOT_AVAILABLE`, `launch_session` with `template` answers `TEMPLATE_NOT_FOUND`, and no template browser starts. |
| [`templateHostIdleTimeout`](../reference/configuration.md#templateHostIdleTimeout) | `1h` | Stop a template's browser after this long with no session; `0` = never. |
| [`templateMaxPagesPerHost`](../reference/configuration.md#templateMaxPagesPerHost) | `40` | Agent pages per template browser (2 to 200). |
| [`templateRecycleAfter`](../reference/configuration.md#templateRecycleAfter) | `24h` | Restart a template's browser after this age (at least `1h`). |
| [`templateDrainTimeout`](../reference/configuration.md#templateDrainTimeout) | `15m` | How long a restart or a restore waits for sessions before closing them (`1m` to `2h`). |
| [`templateRecycleRss`](../reference/configuration.md#templateRecycleRss) | `3GiB` | A template browser's memory limit (at least `512MiB`); see [the template's browser](#the-templates-browser). |
| [`templateCheckpointInterval`](../reference/configuration.md#templateCheckpointInterval) | `15m` | How often the checkpoint is rewritten while the browser runs (at least `1m`). |
| [`templateVersionsKeep`](../reference/configuration.md#templateVersionsKeep) | `10` | Versions kept per template (1 to 100), besides pinned ones and Last good. |
| [`templateKey`](../reference/configuration.md#templateKey) | unset | The key that encrypts checkpoints and versions (base64 of 32 bytes). Secret: set `BROWSERHIVE_TEMPLATE_KEY`. Unset: `<data-dir>/admin/template.key`. |
| [`templateKeyPrevious`](../reference/configuration.md#templateKeyPrevious) | unset | The previous key, read only, while you [rotate the key](#rotating-the-key). Secret. |

## Known limits

A template's browser always routes its requests through BrowserHive (that is how BrowserHive knows which session a request belongs to and keeps the browser away from BrowserHive's own dashboard). Routing has side effects you should know about.

| Limit | What happens | What to do |
|---|---|---|
| **No HTTP cache** | Every page load fetches every script, style and image again: more traffic, slower pages, and a site can notice that nothing is ever served from cache. On the test site, reloading a page with five cacheable scripts fetched all five again. | Nothing to configure. A cache-preserving mode is planned. |
| **CORS preflights under the Playwright driver** | With the stock Playwright driver, Playwright answers a cross-origin request's preflight itself and allows it, so the site's own refusal is never consulted: a page an agent visits can send a cross-origin write (for example a JSON `POST` with a custom header) to another site the template is signed in to, with its cookies. With Patchright (the stealth driver) the write is not sent. | **Use Patchright for templates**: keep `stealth` on (the default) and `stealthDriver` at `auto` or `patchright`, and do not create templates with `stealth: off`, which run on the stock driver. |
| **SharedWorker requests** | Requests a page's SharedWorker makes are not seen by routing, so they have no owning session and site rules (once site packs exist) cannot stop them. Dedicated and service workers are routed. | Accepted; site packs express such writes as rules on the page actions instead. |
| **Requests sent while a page closes** | A beacon or `keepalive` fetch a page sends while it closes (`close_tab`, `close_session`) is not routed: no owning session and no site rule ever sees it, and whether it reaches the site depends on timing. | Accepted; site packs express such writes as rules on the page actions instead. |
| **Redirects into BrowserHive** | Routing sees only the first URL of a redirect chain. A page can therefore redirect the template's browser to BrowserHive's own address; the request carries the template's marker cookie and BrowserHive refuses it (403), so the dashboard never loads there. BrowserHive also answers only `localhost`, `127.0.0.1` and `::1` among loopback names (not `*.localhost`, other `127.x` addresses or IPv4-mapped forms), so the marker covers every address it answers. | Nothing to configure. |
| **Modifier clicks** | Chromium opens a Ctrl/Cmd/Shift- or middle-click tab with no link to the page that opened it. BrowserHive matches it to the clicking session by the page's own request; when two sessions request the same address at the same moment, the tab is left to no session (closed to agents). | Nothing to configure. |
| **Page caps** | A session holds at most `max(2, floor(templateMaxPagesPerHost / cap))` pages, whoever opens them. A page a site opens beyond that is closed, and the session gets a `SESSION_PAGE_LIMIT` warning, so one session's site cannot take every page of the shared browser. | Raise `templateMaxPagesPerHost` if sessions need more pages. |

A template's browser also carries one cookie of BrowserHive's own (`browserhive_template_host`) for BrowserHive's addresses, which every local service on `localhost` receives with requests from it.
