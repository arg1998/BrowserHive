# Session templates

> **Initial version.** Session templates are being delivered in stages. This page describes the shared browser behind a template and what its design changes; recording a template, how agents use one and sealing are added as those parts land.

A session template is a browser identity you sign in to sites once. Agents then launch sessions from it with `launch_session` and its `template` parameter, and every such session starts signed in.

Every session of one template runs in **one shared browser**, the template's own Chromium with a persistent profile under `<data-dir>/templates/<id>/`. Each session gets its own window (or windows) in that browser and sees only its own pages: `list_tabs`, screenshots, the live view and every page tool reach only pages that session opened or that a page of it opened. A tab or window you open by hand in the template's browser belongs to no session ("parked").

## The template's browser

- **It starts on demand.** The first launch starts it; it stops after `templateHostIdleTimeout` (default `1h`) with no session, and is restarted after `templateRecycleAfter` (default `24h`) once its sessions have finished (at most `templateDrainTimeout`, default `15m`).
- **It counts as one browser.** `maxSessions` bounds browsers: a template's browser takes one slot however many sessions it serves. `server_status` reports that browser count; the System page's capacity shows both sessions and browsers.
- **Windows open in the background.** On a desktop a session's windows open without taking the focus, and agent windows are never raised or moved. The one exception is the browser's start: its first window appears as a normal window before BrowserHive minimizes it, so starting a template's browser (the first launch after it was stopped) can take the focus once.
- **If it crashes,** every session of the template ends at once (agents get `SESSION_DEAD`) and the browser restarts after 5 s, 15 s, 45 s, 135 s and 405 s; after five failures in 30 minutes it stays down until you restart it. If you quit it yourself (close its windows), its sessions end and it starts again at the next launch.
- **Leftovers of a killed BrowserHive** (a template browser still holding its profile) are terminated when BrowserHive starts again.

## Known limits

A template's browser always routes its requests through BrowserHive (that is how BrowserHive knows which session a request belongs to and keeps the browser away from BrowserHive's own dashboard). Routing has side effects you should know about.

| Limit | What happens | What to do |
|---|---|---|
| **No HTTP cache** | Every page load fetches every script, style and image again: more traffic, slower pages, and a site can notice that nothing is ever served from cache. | Nothing to configure. A cache-preserving mode is planned. |
| **CORS preflights under the Playwright driver** | With the stock Playwright driver, Playwright answers a cross-origin request's preflight itself and allows it, so the site's own refusal is never consulted: a page an agent visits can send a cross-origin write (for example a JSON `POST` with a custom header) to another site the template is signed in to, with its cookies. With Patchright (the stealth driver) the write is not sent. | **Use Patchright for templates**: keep `stealth` on (the default) and `stealthDriver` at `auto` or `patchright`, and do not create templates with `stealth: off`, which run on the stock driver. |
| **SharedWorker requests** | Requests a page's SharedWorker makes are not seen by routing, so they have no owning session and site rules (once site packs exist) cannot stop them. Dedicated and service workers are routed. | Accepted; site packs express such writes as rules on the page actions instead. |
| **Requests sent while a page closes** | A beacon or `keepalive` fetch a page sends while it closes (`close_tab`, `close_session`) is not routed: it reaches the site, with no owning session, and site rules cannot stop it. | Accepted; site packs express such writes as rules on the page actions instead. |
| **Redirects into BrowserHive** | Routing sees only the first URL of a redirect chain. A page can therefore redirect the template's browser to BrowserHive's own address; the request carries the template's marker cookie and BrowserHive refuses it (403), so the dashboard never loads there. BrowserHive also answers only `localhost`, `127.0.0.1` and `::1` among loopback names (not `*.localhost`, other `127.x` addresses or IPv4-mapped forms), so the marker covers every address it answers. | Nothing to configure. |
| **Modifier clicks** | Chromium opens a Ctrl/Cmd/Shift- or middle-click tab with no link to the page that opened it. BrowserHive matches it to the clicking session by the page's own request; when two sessions request the same address at the same moment, the tab is left to no session (closed to agents). | Nothing to configure. |
| **Page caps** | A session holds at most `max(2, floor(templateMaxPagesPerHost / cap))` pages, whoever opens them. A page a site opens beyond that is closed, and the session gets a `SESSION_PAGE_LIMIT` warning, so one session's site cannot take every page of the shared browser. | Raise `templateMaxPagesPerHost` if sessions need more pages. |

A template's browser also carries one cookie of BrowserHive's own (`browserhive_template_host`) for BrowserHive's addresses, which every local service on `localhost` receives with requests from it.
