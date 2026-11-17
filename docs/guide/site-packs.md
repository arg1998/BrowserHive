# Site packs

> **In this release:** BrowserHive ships site packs for a set of popular sites and reads your own pack files from a local folder. No pack applies until you approve it. Packs from BrowserHive's online registry, signed packs you import by hand, the pack strategies (pacing, warm-up, keep-alive and the others) and the classification of changes (tightening, loosening) arrive in later releases.

A site pack tells BrowserHive how one site works, so a [session template](templates.md) behaves there the way the site expects a person to, and stays signed in. It says how to tell whether the template is signed in, which requests and buttons sign the account out or create new credentials, which pages are security checks that need a person, and what the site's terms say about automation.

A pack is **data only**. It never carries code, scripts, launch arguments, proxy settings or vault rules, and nothing in it is ever sent anywhere. Packs apply to template sessions only; other sessions are not affected.

## What a pack contains

A pack is one JSON file (at most 64 KiB) for one site, named by the site's registrable domain: `linkedin.com`. Every section is checked against a strict schema; an unknown key makes the whole version invalid.

| Section | What it says |
|---|---|
| `id`, `version`, `title`, `domains` | The pack's identity (`linkedin.com`), its version number (higher is newer), its name, and the registrable domains it covers (up to 8, the first is the id). A domain belongs to at most one pack. |
| `min_client`, `max_client` | The BrowserHive versions that can use this version. |
| `identity_provider`, `shares_login_with` | The site whose sign-in this one uses (`youtube.com` signs in through `google.com`), and sites that share its sign-in. |
| `sign_in` | The sign-in page (an `https` address inside the pack's domains, path only) and `human_only`: when `true`, BrowserHive never fills a vault login there. |
| `signed_in` | How to tell that the template is signed in without reading a cookie value: a page to load (`probe`), the redirects that mean "signed out", a selector that is only there when signed in (`landmark`) or only when signed out (`signed_out_marker`), and cookie **names** whose absence means signed out. |
| `guards` | Requests that sign the account out, change account or security settings, create credentials (tokens, keys, app passwords, OAuth consent), destroy data, or write; each with what to do: `block`, `confirm`, `warn` or follow the write policy. |
| `element_guards` | Buttons and links an agent must not use (by CSS selector, or by role and name), with the same actions. |
| `write_policy` | The site's terms on automation (`stance`), the clause quoted from them with its address and the date it was checked, and the default for writes (`allow`, `warn` or `confirm`). |
| `challenges` | Pages that are security checks, CAPTCHAs, locked accounts or rejected sign-ins, and whether they need a person (`attention`) or must stop all use of the site (`stop`). |
| `concurrency`, `pacing` | How many sessions at once and how many writes per period the site tolerates, each with its source (official or vendor guidance). |
| `browser`, `device_binding`, `consistency` | The browser and headedness the site expects, how it binds a sign-in to a device, and whether the location, time zone and language must stay fixed. |
| `strategies` | Behaviour selected from a fixed list built into BrowserHive: pacing, launch spacing, active hours, warm-up, keep-alive, a stealth floor and others ([Strategies](#strategies)). |
| `verified`, `sources` | The date each section was last checked against the live site, and where the facts come from (shown, never fetched). |

## Where packs come from

| Source | What it is | Trust |
|---|---|---|
| **Bundled** | Packs shipped inside BrowserHive. A new release can ship new versions of them. | Publisher: they come with the release. |
| **Local** | Single pack files (`<pack id>.json`) in the local folder, `sitePacksDir` (default `<data-dir>/site-packs/local`). Written by you. | Operator: you approve each file's content. |
| Registry (later release) | Signed packs downloaded from browserhive.ai. | Publisher: checked against keys built into BrowserHive. |
| Signed import (later release) | A signed folder you copy to a machine without internet access. | Publisher. |

BrowserHive reads the bundled packs and the local folder at startup and again on **Reload** (`browserhive sitepacks reload`). A file that fails validation is skipped, with its reason on the Site packs page, in `browserhive sitepacks list` and in `browserhive doctor`. A signed layout placed in the local folder (`keys.json`, `index.json`, `packs/`) is counted and skipped until the release that reads signed layouts.

With [`sitePacks`](../reference/configuration.md#sitePacks) set to `false`, BrowserHive uses no pack data at all: every template site is a generic site (sign-in checks by learned cookie names, no guards, no challenges).

## Approval and provenance

**No pack version applies until you have approved it**, whatever its source. Until then the site is a generic site.

**First use.** When you add a site to a template (the dashboard's new-template wizard, adding a site on the template page, `browserhive templates create --sites`, or the REST API), BrowserHive shows the pack that would apply: its version, its SHA-256 and where it comes from ("bundled with BrowserHive 0.3.1", or a local file's path). Adding the site **approves that version**, in your name, with that provenance. Every way of adding a site sends the SHA-256 of the version you were shown, and BrowserHive approves exactly that one:

- **The dashboard** waits until the catalog of packs has loaded before it lets you create the template, and sends the hash of each pack it showed you.
- **`browserhive templates create --sites`** prints each site's pack (version, provenance, SHA-256, the site's terms, whether writes need confirmation) before it creates anything, asks you to type `yes` on a terminal, and refuses without one unless `--yes`. A pack that is already approved is listed and needs no answer.
- **The REST API** takes the hash as `pack_sha256` on each site (`POST /templates`, `PUT /templates/{id}/sites/{site}`). A site whose pack still needs approval is refused without it ([`SITE_PACK_APPROVAL_REQUIRED`](../reference/errors.md#SITE_PACK_APPROVAL_REQUIRED), 409, with the offer's version, SHA-256 and provenance in its details), so nothing is approved that you were not shown.

If another version is on offer by the time you confirm, adding the site fails with `409 CONFLICT`, and you review the pack again.

**Packs are global.** One approval covers every template. A pack another template already uses keeps its approved version when you add its site to a second template. An approved, enabled pack applies to every template browser's pages on its domains, whether or not the template lists the site. What is per template is the site's [write policy](#write-policies-and-the-stance-rule).

**Later versions wait for you.** When a newer BrowserHive release ships a newer bundled version, it appears as a **pending update** with the exact field-by-field difference from the version you approved. Templates keep the approved version until you act. No release, and no automatic update, ever applies one.

| Action | Dashboard | Command line | What it does |
|---|---|---|---|
| Review | the pack page | `sitepacks diff <pack> [--to <version>]` | Shows each changed field, its old and new value, and any new domain. |
| **Apply** | **Apply** | `sitepacks apply <pack> [version]` | The version becomes the approved one. Every template that uses the pack follows it at once. The version it replaces is kept for Revert. |
| **Reject** | **Reject** | `sitepacks reject <pack> [version]` | Dismisses the version. A newer one is offered again. |
| **Revert** | **Revert** | `sitepacks revert <pack>` | Goes back to the previous approved version in one step. |
| **Pin** | **Pin** | `sitepacks pin <pack> <version>`, `sitepacks unpin <pack>` | Keeps the approved version. Newer versions are listed as "pinned at v7, v9 available". |
| **Follow updates** | **Follow updates** | `sitepacks follow <pack> on\|off\|auto` | Whether the pack lists pending updates, counts in the badge and sends [`site_pack.update_pending`](notifications.md#site-packs). `auto` (the default) follows a pack while a template uses it. |
| Turn off | the **Enabled** switch | `sitepacks disable <pack>`, `sitepacks enable <pack>` | A disabled pack applies nowhere: its guards (sign-out, account and credential ones included) stop applying for every template, and its sites are generic sites until you enable it again. Turning a pack off asks for confirmation (the command line asks you to type the pack id, or takes `--yes`). |

Every decision is recorded with who made it and when (`GET /api/v1/site-packs/changes`, and the audit log).

**BrowserHive keeps a copy of what you approved.** At every approval it copies the version's exact bytes to `<data-dir>/site-packs/cache/<source>/<pack id>/<sha256>.json`. When a later release drops or changes a bundled version, or a local file is edited or deleted, the approved copy keeps applying. If that copy is missing or unreadable, the pack is not applied (its sites are generic) and the pack is listed as skipped (`not_found`).

**Precedence.** For one pack id, approved local content wins over every other source; otherwise the approved version applies. A pack whose content comes from a local file says "Local file overrides v9" wherever it is shown.

**A domain belongs to one pack.** Content that claims a domain another pack already covers is refused: approving or importing a local file that lists `github.com` while the GitHub pack covers it answers 409 [`SITE_PACK_DOMAIN_TAKEN`](../reference/errors.md#SITE_PACK_DOMAIN_TAKEN) naming that pack, and nothing of the other pack changes. A version skipped for this reason names the pack that owns the domain.

**One broken pack stays alone.** If BrowserHive cannot read one pack's stored approval, only that pack is left out (its sites are generic), and the Site packs page and `browserhive doctor` say so; every other pack keeps applying.

## Local packs

Put one file per pack in the local folder, named after the pack: `<sitePacksDir>/example.com.json`. Then run `browserhive sitepacks reload` (or restart BrowserHive). Or send a file to a running server, which stores it in the folder for you:

```bash
browserhive sitepacks import ./example.com.json
```

The command sends the file's text byte for byte, so the SHA-256 you approve is the file's own: the one `browserhive sitepacks verify` prints. It prints that SHA-256 after the import.

A local file needs no signature, but it applies only once you have approved its content, **once per SHA-256**:

| State | Meaning | What applies |
|---|---|---|
| **Approved** | You approved this exact content. | The file's content. |
| **Changed since approval — review** | The file's SHA-256 differs from the one you approved. The pack page shows the difference. | The content you approved, from BrowserHive's copy in `site-packs/cache/local/`. |
| **Not yet approved** | You never approved any content of this file. | Nothing of it. |

Approve on the pack page, or:

```bash
browserhive sitepacks approve-local example.com
```

The command prints the difference between what applies now and the file, then the SHA-256 it approves (the one of the content whose difference it printed), and asks you to type the pack id (`--yes` skips the question; without a terminal it refuses unless `--yes`). BrowserHive then copies that content to `site-packs/cache/local/example.com/<sha256>.json`, so later edits to the file change nothing until you approve them again. If the file changed between the review and the approval, the approval is refused (`409 CONFLICT`, or the command stops before sending anything): run it again to review the new content. The dashboard's **Approve** likewise approves the hash of the difference it shows, and waits while that difference reloads.

## Write policies and the stance rule

A pack records the site's terms on automation as a **stance**, quotes the clause with its address and the date it was checked, and sets a **default write policy** for its `write` guards. The default follows the stance rule:

| Stance | Shown as | Default write policy |
|---|---|---|
| `prohibited` | The site's terms prohibit automated access | `confirm`: each write waits for your approval |
| `writes_restricted` | The site's terms restrict automated posting or submitting | `confirm` |
| `restricted` | The site's terms restrict automated access | `warn`: writes go through and are recorded with a warning |
| `allowed` | The site's terms allow automated access | `allow` |

A pack that departs from the rule says why (`exception`), and the reason is shown to you. The clause is shown as text, with its address as plain text; it has no other effect. **You choose** a template's write policy per site: in the wizard, on the template's Sites tab, or with `PUT /api/v1/templates/{id}/sites/{site}` and `{"write_policy": "allow" | "warn" | "confirm" | null}` (`null` uses the pack's default). **A pack with no `write` guards has nothing for the write policy to act on**: whatever you choose, no write waits for confirmation on that site. The wizard, the template's Sites tab, the pack page and `browserhive templates create` say so for such a pack.

## Guards

Guards are checked in two places, both pure matching over the pack's data:

- **In the browser, on every request** of a template's browser: by method, address and type. This is the enforcement point. Sign-out, account, credential and destructive guards match **every** type of request (page loads, `fetch`, XHR, beacons, images, scripts, stylesheets, prefetches, event streams and the rest; WebSockets are never routed, see below), so an `<img src="/logout">` is stopped too, unless the guard names the types it covers (`resource_types`). Write guards match page loads, `fetch`, XHR and beacons unless they name others.
- **In the tools, before the browser is touched**: `navigate` and `new_tab` check page-load guards, and `click`, `hover`, `select_option`, `drag_and_drop`, `fill`, `type_text` and `press_key` check element guards. An action is refused when its target **is** the guarded element **or is inside it** (a `<span>` in a guarded button). This is an earlier, friendlier refusal, not the boundary.

A request belongs to the pack of its own address's registrable domain, not of the page that sent it. The first matching guard of that pack decides. A guard address without a trailing `*` also matches the same path with any query string and the paths beneath it: `www.example.com/logout` matches `/logout`, `/logout/x` and `/logout?next=/`, but not `/logout-help`. Before matching, the address is read the way a server reads it: percent-encoded letters and digits are decoded (`/log%6Fut` is `/logout`), encoded slashes and dots are decoded, repeated slashes collapse (`//logout` is `/logout`), `;parameters` in a path segment are dropped (`/logout;x=1` is `/logout`), and host names are compared without case or a trailing dot. Pattern matching takes time proportional to the address, whatever the pattern, and a pattern may hold only a few `*`.

BrowserHive also applies built-in guards on every template page, with or without a pack: they block the OAuth consent approval of `accounts.google.com`, `github.com`, `login.microsoftonline.com` and `login.live.com`, so an agent cannot grant a third-party app access to the account.

| Action | In the browser | In the tools |
|---|---|---|
| `block` | The request is aborted. | `navigate` and `new_tab` answer [`URL_BLOCKED`](../reference/errors.md#URL_BLOCKED) with `pattern: '<pack id>#<guard id>'`; element actions answer [`SITE_ACTION_BLOCKED`](../reference/errors.md#SITE_ACTION_BLOCKED). Agents are told not to retry. |
| `confirm` | The request is **held** while a write confirmation waits on `/attention`. Approve: it goes on. Deny, the deadline, the session closing or the page going away: it is aborted. | The tool answers [`SITE_OPERATOR_PENDING`](../reference/errors.md#SITE_OPERATOR_PENDING) with the request id. After an approval, the agent retries the action: the same guard and address pass once for that session, within 10 minutes. |
| `warn` | The request goes on, with a [`SITE_GUARD_WARNED`](../reference/errors.md#SITE_GUARD_WARNED) warning on the session. | The action goes on. |
| `write_policy` | The site's write policy decides: `allow`, `warn` or `confirm` as above. | The same. |

**Write confirmations.** A held write shows on `/attention` with the method, the address (sanitized), the guard and its kind, the site and the tool call that triggered it. Its deadline is `attentionTimeout`, at least `minAttentionWait`. While it waits, the session gets a [`SITE_WRITE_HELD`](../reference/errors.md#SITE_WRITE_HELD) warning and its next tool call answers `SITE_OPERATOR_PENDING`; the agent can wait with `get_attention_result`. Bounds: one open write confirmation per session (a further matching write of that session is aborted), and at most 10 open site checks and write confirmations per template (beyond that, matching writes are aborted); the limits are checked before anything is opened, so requests arriving together cannot pass them, and one session cannot fill the template's limit alone. **Resolve all** on `/attention` never decides site checks or write confirmations: decide each one. Writes of kind `write` can also be approved from a [notification](notifications.md#site-packs); sign-out, account, credential and destructive guards only on `/attention`.

**Requests with no session.** A request of the template's browser that belongs to no agent session (a service worker, a page you opened by hand, a page BrowserHive opened for a health check) under a `confirm` guard is aborted, as under `block`.

**Without the dashboard** (`transport=stdio`), nobody can answer: `confirm` acts as `block`, and challenges only mark the site's health.

Every guard decision is recorded (`GET /api/v1/site-packs/guard-hits`, and as `guard` rows in the session's timeline) with the guard, the action, the session, the method, the sanitized address and, for confirmations, who decided.

## Challenges

A **challenge** is a page that needs a person: a security check, a CAPTCHA, a re-authentication prompt, a locked account. BrowserHive watches a template's pages for:

- a page load whose address matches a pack challenge;
- after the page loads, its title containing a pack's text, a pack's selector on the page, or a pack's text on the page;
- a CAPTCHA provider's challenge (Cloudflare, reCAPTCHA, hCaptcha, Arkose, DataDome), but **only a visible one**: a provider's challenge frame, or a provider frame at least 100 × 60 pixels inside the viewport. Invisible checks and badges (reCAPTCHA v3, Turnstile in invisible mode) are ignored.

Site checks are raised only on a template's own sites and on the domains of approved packs; a challenge on any other site changes nothing. Built-in challenges apply on those pages: the Cloudflare interstitial ("Just a moment", "Verify you are human") needs a person; any other visible provider challenge only marks the site's health.

What happens:

- **In an agent's session**, BrowserHive opens a **Site check** on `/attention` ("LinkedIn security check") in takeover mode, with a deadline of `attentionTimeout` (at least `minAttentionWait`). The site's health becomes `challenged` ("! check needed") and you get a [`template.challenged`](notifications.md#template-sign-ins) notification. Until the check is resolved, the session's tools answer `SITE_OPERATOR_PENDING`, except `close_session`, `list_sessions`, `server_status`, `session_info`, `list_tabs`, `screenshot`, `list_templates`, `get_attention_result`, `list_saved_auths` and `vault_list_available`. Take over in the live view (your input is allowed while the check is open), or solve it in the template's window, then **Resolve** or **Reject** it on `/attention`. Resolving checks the site again. At the deadline the session's tools are released and the site stays `challenged`.
- **`stop`** is for pages where retrying makes things worse ("Couldn't sign you in", a suspended account). It does the same, and also stops the site: every agent navigation to it and every tool on its pages answers `SITE_OPERATOR_PENDING` (`reason: stopped`) until you press **Clear stop** on the template's Sites tab (`POST /api/v1/templates/{id}/sites/{site}/clear-stop`).
- **An agent's own navigation never triggers one.** When the address an agent passed to `navigate` or `new_tab` matches a challenge, the page loads and nothing else happens: no Site check, no health change, no stop. A redirect into a challenge page does count.
- **In a health check**, a challenge only sets the result to `challenged`.

Bounds: one open Site check per session (further matches join it), at most one new one per session every 5 minutes, and the template's limit of 10 open site checks and write confirmations. Neither `challenged` nor "couldn't tell" ever starts a re-login: signing in again into a security check is how accounts get locked.

## Strategies

A pack selects **strategies** from a fixed list built into BrowserHive; it never carries their code. Each strategy's parameters are checked and kept within bounds built into BrowserHive, so a pack can tune a strategy but not push it to a harmful extreme. `GET /api/v1/site-packs/strategies` lists every strategy with its parameters, defaults and bounds, and each pack page in the dashboard shows the strategies it selects.

Strategies change how a template's sessions behave on the site, never what an agent can ask for. An agent sees a wait as an ordinary slower call, and a refusal only as `TEMPLATE_BUSY` with a retry time, the same answer as a full template. Strategies that concern the whole template (session cap, launch spacing, active hours, ramp-up, keep-alive, the stealth floor and WebRTC) come from the template's **enabled** sites; when several sites select one, the strictest wins. Strategies that concern a page (pacing, dwell, one action at a time, warm-up, humanized input, one focused tab, device binding) apply on the pages of the pack's domains. Their state (budgets, queues, last actions) is kept in memory: restarting BrowserHive resets it. With [`sitePacks`](../reference/configuration.md#sitePacks) set to `false` no strategy runs.

### Sessions and launches

- **Session cap (`concurrency.max_sessions`).** Not a strategy: whenever an enabled site's approved pack sets `concurrency.max_sessions`, the template runs at most that many agent sessions at once (the smallest of its sites wins, and never more than the template's own **Max sessions**). The Templates list shows the lowered cap. An agent launching beyond it gets `TEMPLATE_BUSY` ("Template 'name' is at capacity. Retry in 5 s."), the same answer as the template's own cap.
- **Ramp up a new template (`ramp-up`).** For a template younger than `days` (14), its session cap and every write budget of `pace-writes` are scaled by `start_fraction + (1 − start_fraction) × age_days / days` (`start_fraction` 0.3), rounded up and never below one; the smallest factor of the template's sites wins. The Templates list shows the current cap.
- **Active hours (`active-hours`).** New sessions start only inside the window (`start_hour`–`end_hour`, end exclusive, may wrap past midnight; `weekdays_only` counts the day the window opened) in the template's pinned time zone. With several sites a launch must be inside every window. Outside, `launch_session` answers `TEMPLATE_BUSY` with a retry time up to the window's start; sessions already running continue. If the sites' windows never overlap, launches are refused with a one-day retry and BrowserHive logs a warning.
- **Space launches (`launch-spacing`).** Consecutive sessions of the template start at least `min_gap_s` apart (default: the pack's `pacing.min_launch_gap_s`; the largest of its sites), plus a random 0–`jitter_pct` % (20 %). A launch waits for its turn, up to 20 s and never beyond its launch budget, and to the agent this is a slower launch; a turn further away answers `TEMPLATE_BUSY` with the time until it. Launches queue in order; a refused launch takes no turn.

### Actions on the site's pages

- **One action at a time (`serialize-site`).** At most `max_parallel` (1) sessions of the template click, type, scroll, upload, download or navigate on the site at once, like one person with many tabs. The others queue in arrival order for up to 30 s; past that the action answers `TEMPLATE_BUSY` ("Actions on <site> are being paced. Retry in 5 s.") and the log records `site action paced`. Reading tools (snapshot, content, screenshots, waits) are never held, and a session's own concurrent calls share its turn.
- **Human dwell time (`human-dwell`).** Before each action on the site, a session waits until a random time between `min_ms` (600) and `max_ms` (2500) has passed since its previous action there. Its first action does not wait. To the agent, some actions take a little longer.
- **Warm-up entry (`entry-warmup`).** The first time a session goes straight to a deep page of the site, BrowserHive first opens the pack's entry `path` (`/`, on the `www.` host or the sign-in check host) with no referrer (`none`), the site's home page (`same-site`) or a search engine (`search`) as referrer, waits `dwell_ms` (2000) there, then opens the page the agent asked for. The warm-up uses at most half of the tool's timeout; a failed warm-up is logged (`entry warm-up failed`) and never fails the navigation. Script navigations away from the pack's domains during the warm-up are aborted; a server redirect from the entry path is followed like any redirect ([What guards cannot see](#what-guards-cannot-see)).
- **Humanized input (`humanize-input`, and `stealth-profile` with `humanize: true`).** Clicks, hovers, typing and scrolling on the site's pages move and type like a person, even in sessions launched without `humanize`. A template with stealth `off` cannot humanize: the strategy is ignored and BrowserHive logs it once (`humanize not forced`).

### Writes, responses and keeping the sign-in fresh

STRATEGIES_N

### Stealth

`stealth-profile`, `single-focus` and `webrtc-policy` change what the site sees of the whole template: see [Site pack stealth strategies](stealth.md#site-pack-stealth-strategies).

## Navigation checks

For a site with an approved pack, a [health check](templates.md#health-checks) loads the pack's `probe` page in a background window of the template's browser, with `GET` only. During the check, any page load that leaves the pack's domains is aborted. First, when the pack lists sign-in cookie names and none of them is present, the site is signed out without loading anything. Otherwise the page is loaded (at most 20 seconds), and the first of these that holds decides:

| Result | Reason | When |
|---|---|---|
| ! check needed (`challenged`) | `challenge:<kind>` | A challenge matched. Never reported as signed out. |
| ✗ signed out (`signed_out`) | `redirect`, `marker`, `cookies_absent` | The page redirected to a signed-out address, shows the signed-out marker, or no sign-in cookie is left. |
| ✓ signed in (`signed_in`) | `landmark`, `no_redirect` | The signed-in landmark is on the page, or the page stayed where it was asked to load. |
| ? couldn't tell (`inconclusive`) | `timeout`, `network`, `http_<status>`, `no_signal` | The page did not load in time, the network failed, the server answered an error, or nothing matched. |

Selectors are only counted and texts only looked for; nothing from a pack is ever run in the page. A site without an approved pack keeps the cookie check of a generic site.

## What guards cannot see

The request guard sees what the browser driver routes. Some traffic is not routed, so no guard can stop it:

| Not seen | What packs do about it |
|---|---|
| **Redirect hops.** Only the first address of a redirect chain is routed. A redirect into a guarded address (`/go?to=/logout` answering `302 /logout`) is not stopped, and because `307` and `308` keep the method, that covers `POST` too. | Packs block the site's known open redirectors. The same limit applies to the pages BrowserHive loads by itself (health checks, keep-alive visits, warm-ups): a page leaving the pack's domains by script is aborted, but a server redirect's next hop is not, so pack paths must not redirect off the pack's domains. |
| **WebSockets.** Neither the connection nor its messages pass through BrowserHive's routing, so no guard sees them. | Element guards on the controls that send them. |
| **`javascript:` URLs.** Requests a page makes from one. Agents cannot open them: every non-web scheme is refused at the tools ([Security](security.md#agents-open-web-urls-only)). | — |
| **SharedWorker requests.** Dedicated workers and service workers are routed; shared workers are not. | Packs express such writes as element guards. |
| **Requests sent while a page closes.** A beacon or `keepalive` fetch sent from `pagehide` or `unload` while `close_tab` or `close_session` closes the page. Whether it reaches the site depends on timing. | Packs express writes a site sends on unload as element guards (the tool path). |
| **Service-worker attribution.** Some requests a service worker forwards are attributed to the page that triggered them instead of to the template's browser. The guard still applies; only the session recorded with the hit differs. | — |

Guards are not an egress firewall. They keep agents from signing the account out, changing its security settings and minting credentials **where a guard exists**. An agent can still act as the account wherever no guard stops it ([Security](security.md#site-packs)).

## Why a bad pack can do little harm

Packs come from a source you trust less than yourself (a release, later a registry), so the schema and BrowserHive bound what a pack can do even if its author is careless or hostile:

| Field | Bound |
|---|---|
| `sign_in.url` | `https` only, a host inside the pack's domains, a path with no query. Shown in full before a sign-in window opens. |
| `domains` | A domain another pack covers is refused, also for a local file you approve. A new domain is shown in the difference and needs your approval. |
| Pages BrowserHive loads by itself (the probe page) | A path inside the domains, no query, and never one of the pack's own sign-out, account, credential or destructive guards. During a check, page loads that leave the domains are aborted. |
| `guards` | The glob grammar only (`*` and `?`, at most 4 `*` and no `**` per pattern, matched without backtracking; an address over 16 384 characters is judged by its host alone, so a padded address cannot slip past a sign-out or account guard), hosts inside the pack's domains, at most 64. |
| `challenges` | Per-session and per-template bounds on Site checks; an agent's own navigation never triggers one. |
| `signed_in` | Cookie **names** only, never values. A re-login never starts on `challenged` or "couldn't tell". |
| Numbers (sessions, pacing, intervals) | Floors and ceilings built into BrowserHive; sessions never above the template's own cap. |
| Selectors | Standard CSS only, at most 200 characters and 4 selectors per list, one `:has(`, a short list of allowed pseudo-classes, no Playwright extensions; only ever counted, never run. |
| Any text | Control characters (terminal escape sequences) and Unicode bidi and format characters (which reverse or hide text) are refused in every field, and `verify` reports them. Text is shown as text, never as HTML or a one-click link, isolated from the text around it in the dashboard, with any such character replaced by `�` on the command line, and escaped in notifications; length limits on every field; 64 KiB per pack. |
| `strategies` | Only names built into this BrowserHive; an unknown name skips the version. |

No pack field is ever sent anywhere, and every address a pack can make the browser load is inside its approved domains.

## Verifying a pack

```bash
browserhive sitepacks verify ./example.com.json
```

`verify` works offline, without a server: it checks the file against the schema and every rule above and prints each problem with its field. A server refuses an invalid file the same way ([`SITE_PACK_INVALID`](../reference/errors.md#SITE_PACK_INVALID)).

## Writing a local pack

Write a pack for a site you use, or a stricter version of a bundled pack (a local file with the same id overrides it once approved). This example is for a fictional forum at `example.com`:

```json
{
  "schema": 1,
  "id": "example.com",
  "version": 1,
  "min_client": "0.3.0",
  "title": "Example Forum",
  "domains": ["example.com", "example.net"],
  "sign_in": {
    "url": { "host": "www.example.com", "path": "/login" },
    "human_only": false
  },
  "signed_in": {
    "probe": { "host": "www.example.com", "path": "/account/profile" },
    "kind": "redirect",
    "signed_out_redirects": ["www.example.com/login*"],
    "cookie_names": ["session_id"]
  },
  "guards": [
    { "id": "logout", "kind": "logout", "match": { "url": "www.example.com/logout" }, "action": "block" },
    { "id": "go-redirector", "kind": "logout", "match": { "url": "www.example.com/go*" }, "action": "block" },
    {
      "id": "api-tokens",
      "kind": "credential",
      "match": { "url": "www.example.com/settings/tokens*", "methods": ["POST", "DELETE"] },
      "action": "block"
    },
    {
      "id": "new-post",
      "kind": "write",
      "match": { "url": "www.example.com/api/posts*", "methods": ["POST"] },
      "action": "write_policy"
    }
  ],
  "element_guards": [
    {
      "id": "logout-link",
      "kind": "logout",
      "page": "www.example.com/*",
      "target": { "selector": "a[href^=\"/logout\"]" },
      "action": "block",
      "request_guard": "logout"
    },
    {
      "id": "publish-button",
      "kind": "write",
      "page": "www.example.com/compose*",
      "target": { "role": "button", "name": "Publish" },
      "action": "write_policy",
      "request_guard": "new-post"
    }
  ],
  "write_policy": {
    "default": "confirm",
    "stance": "writes_restricted",
    "clause": {
      "quote": "You may not post content by automated means.",
      "url": "https://www.example.com/terms",
      "checked": "2026-11-01"
    }
  },
  "challenges": [
    { "id": "verify", "kind": "checkpoint", "match": { "url": "www.example.com/verify*" }, "action": "attention" },
    { "id": "suspended", "kind": "locked", "match": { "title_contains": "Account suspended" }, "action": "stop" }
  ],
  "verified": { "guards": "2026-11-01", "signed_in": "2026-11-01" }
}
```

Tips:

- Give every element guard the request guard that enforces it on the network (`request_guard`); `verify` warns when one has none.
- Guard the site's open redirectors (`/go*` above): a redirect into a guarded address is not seen ([above](#what-guards-cannot-see)).
- The probe page must not be one of your own sign-out, account, credential or destructive guards.
- Raise `version` with every change you want to show as a new version, and run `verify` before `reload`.
- Record in `verified` only what you checked against the live site.

## Bundled packs

BrowserHive ships packs for popular sites. Every field in them was checked against the live site; a field that can only be checked from a signed-in account and was not, is left out rather than guessed, and each pack's `verified` dates say what was checked and when. `browserhive sitepacks list --source bundled` lists the ones your release has.

The first bundled packs were checked on 2026-11-16 without signing in: sign-in pages and signed-out redirects were observed in a fresh browser, guards and terms come from the sites' official pages. What only a signed-in account can confirm (a signed-in landmark, write endpoints, pacing numbers) is not in them yet; later pack versions add it, and each arrives as a pending update for you to approve.

| Pack | Domains | Probe (signed out → redirect) | Sign in by hand only | Terms → default write policy | Notes |
|---|---|---|---|---|---|
| Google | `google.com` | `myaccount.google.com/` | yes | restricted → warn | account, security, app-password, device and deletion pages blocked; device binding (DBSC on Windows) listed |
| LinkedIn | `linkedin.com`, `licdn.com` | `www.linkedin.com/feed/` | no | prohibited → confirm | headed browser preferred |
| Reddit | `reddit.com`, `redd.it` | `www.reddit.com/settings/account` (`either`) | no | prohibited → confirm | headed browser preferred; the redirect happens after the page loads, so checks are often "couldn't tell"; no logout guard yet |
| Facebook | `facebook.com`, `fbcdn.net` | `www.facebook.com/settings` | no | prohibited → confirm | |
| Instagram | `instagram.com`, `cdninstagram.com` | `www.instagram.com/accounts/edit/` | no | prohibited → confirm | |
| X | `x.com`, `twitter.com`, `twimg.com` | `x.com/settings/account` | no | prohibited → confirm | headed browser preferred |
| GitHub | `github.com` | `github.com/settings/profile` | no | allowed → allow | token, SSH key and OAuth app pages are `credential` guards |
| Indeed | `indeed.com` | `myjobs.indeed.com/` | no | writes restricted → confirm | headed browser preferred |
| Glassdoor | `glassdoor.com` | `www.glassdoor.com/member/profile` | no | prohibited → confirm | signs in through Indeed; headed browser preferred; no logout guard yet |
| Microsoft account | `microsoft.com`, `live.com`, `microsoftonline.com` | `account.microsoft.com/` | no | restricted → warn | headed browser preferred; security pages are guarded (opening them forces a fresh sign-in) |

Packs without write guards (all of these for now) leave the write policy with nothing to act on. YouTube is not bundled yet: its signed-in check could not be confirmed without an account. Besides the packs, every template browser blocks the OAuth consent screens and approvals of Google, GitHub (authorize and device approval) and Microsoft (Entra admin consent, Microsoft account consent), so an agent cannot grant a third-party app access to the account.

## Commands and API

| Task | Command line | REST (`/api/v1`) |
|---|---|---|
| List packs, pending updates and local files | `sitepacks list [--source …] [--pending]` | `GET /site-packs` |
| Show one pack | `sitepacks show <pack>` | `GET /site-packs/{pack}` |
| Show a difference | `sitepacks diff <pack> [--to <version\|local>]` | `GET /site-packs/{pack}/diff?to=…` |
| Apply, reject, revert | `sitepacks apply\|reject\|revert <pack>` | `POST /site-packs/{pack}/apply`, `/reject`, `/revert` |
| Pin, follow | `sitepacks pin\|unpin\|follow <pack> …` | `PUT /site-packs/{pack}/pin`, `/follow` |
| Approve a local file | `sitepacks approve-local <pack>` | `POST /site-packs/{pack}/approve-local` `{sha256}` |
| Enable, disable | `sitepacks enable\|disable <pack>` (disable asks first, or `--yes`) | `POST /site-packs/{pack}/enable`, `/disable` |
| Read the folder again | `sitepacks reload` | `POST /site-packs/reload` |
| Import one pack file | `sitepacks import <file>` | `POST /site-packs/import` `{text}` (the file's exact text) or `{pack}` (a parsed pack, stored re-serialized) |
| Check a file offline | `sitepacks verify <file>` | — |
| Decisions and guard hits (identical hits within a second are recorded once; confirmations always) | — | `GET /site-packs/changes`, `GET /site-packs/guard-hits` (`since`/`until` inclusive) |

The routes need the scopes `sitepacks:read` or `sitepacks:write` ([REST reference](../reference/api.md#site-packs)). The commands are described in the [CLI guide](cli.md#sitepacks).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| [`sitePacks`](../reference/configuration.md#sitePacks) | `true` | `false` turns packs off: every template site is a generic site. |
| [`sitePacksDir`](../reference/configuration.md#sitePacksDir) | `<data-dir>/site-packs/local` | The local folder for your own pack files. |
