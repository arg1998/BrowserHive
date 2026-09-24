---
title: "Stealth, fingerprinting and the reserved proxy layer"
spec: "11"
status: Normative
scope: Everything that makes a BrowserHive session look like a person's browser, the policy layers beside it (launch-arg deny-list, URL blocklist), trace exclusion around vault typing, and the features that are deliberately not built but whose seams exist.
audience: Contributors working on the browser driver, identity, fingerprint, humanize, blocklist or proxy seam; reviewers of stealth-sensitive changes.
related:
  - 00-decisions.md
  - 02-mcp-and-tools.md
  - 08-cli-arguments-and-config.md
  - 09-testing.md
---

# 11 — Stealth, Fingerprinting, and the Intentionally Missing Proxy Layer

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Decisions: D-13 (stealth posture, proxy seam), D-21 (creation pipeline), D-22 (blocklist reload), D-20 (privacy), D-25 (not built), D-26 (browser choice), D-27 (sandbox).

The rule of this spec: **the stealth posture described here is the acceptance bar.** Every mechanism, constant and downgrade rule below is specified exactly; the integration probes in §9 are the regression gate, and §10 lists the invariants a change MUST NOT break.

---

## 1. Threat model and what stealth is

- Stealth means: the browser reports what a real Chrome on this host would report, and inputs arrive the way a hand produces them. It does **not** mean invisibility. Documented ceilings (§14) are real and are stated in the user docs, never hidden.
- Stealth is shipped as *capability, not encouragement*: default `standard` is host-coherent (nothing foreign is asserted), `max` only turns on the display fingerprint, humanization is opt-in. No fabricated OS, GPU, timezone or coordinates — ever ("assert nothing rather than assert wrong").
- Trust model: the agent is untrusted, the operator is trusted, sites are hostile. Stealth never weakens isolation (the deny-list protects isolation; stealth args bypass the deny-list only because they are internal constants).
- Non-goals: managed residential proxies, CAPTCHA farms, TLS/JA3 spoofing, Camoufox/direct-CDP engines in the primary stack (all out of scope; see D-25).

## 2. The pipeline in creation order

Stealth is applied inside the session-creation pipeline (D-21) in this fixed order, because each step needs the previous one's output and Playwright cannot change viewport/locale/timezone after context creation:

```
resolveIdentity  ── channel/engine ─► binary ─► launch flags ─► geo seed ─► fingerprint (context options + init script)
launch           ── BrowserDriver.launch(spec) with the merged options
applyIdentity    ── CDP Emulation.setUserAgentOverride per page (awaitable) + deviceMemory init script
(humanize is not a launch step; it is a per-call decorator on interaction tools and the vault typer)
```

### 2.1 Engine / channel / binary

- `channel: 'chromium' | 'chrome' | 'edge'` (`SUPPORTED_CHANNELS`). Map to Playwright: `chromium → channel: 'chromium'` (the **full Chromium binary in new-headless**, never `chrome-headless-shell` — this single choice restores `window.chrome`, plugins, mimeTypes, `pdfViewerEnabled`, hardware WebGL), `chrome → 'chrome'`, `edge → 'msedge'`.
- **Bundled versus installed (D-26).** `chromium` is Playwright's pinned Chrome for Testing build, downloaded by `browserhive init`, identical on every host and always kept. `chrome` and `edge` launch the browser installed on the host (found by Playwright's own lookup, `registry.findExecutable(name).executablePath()`), which updates itself. The trade-off is measured, not assumed: the bundled build reports its pinned full version (for example `153.0.8010.12`, a beta-only build while stable Chrome was `154.0.8037.57`) that real users do not run, and it cannot sandbox on Ubuntu 23.10+ without an AppArmor profile (§4.1); an installed Chrome reports the version real users run and ships the profile Ubuntu needs, but it can drift ahead of the build a release was tested with (`doctor` warns beyond one major version) and company policies can block automation. The recommended setup for stealth is Patchright with the installed Google Chrome (Patchright's own recommendation); the default stays `chromium` because it needs nothing installed.
- **The version is never faked.** UA-CH `fullVersionList` and the UA's major come from the real engine (`Browser.getVersion`, §2.3); BrowserHive never pins or invents a version. Measured through BrowserHive: `fullVersionList` equals the engine's real version for `chromium` and `chrome` on all three OSes.
- A configured channel whose browser is missing fails with `BROWSER_NOT_INSTALLED` naming the install command (`browserhive init`, `browserhive init --installChrome`); BrowserHive never launches another browser in its place.
- `incognito: true` adds `--incognito` for `chrome`/`edge` only; for `chromium` it is metadata (isolation comes from the context / managed `userDataDir`; `--incognito` conflicts with `--user-data-dir`).
- Caller `launchOptions.executablePath` disables channel routing with warning `EXECUTABLE_PATH_OVERRIDE`.
- Driver: stealth sessions use the **Patchright** `BrowserType` when resolvable; non-stealth sessions use stock `playwright.chromium`. Patchright is an API-compatible fork of `playwright-core` whose patches hide the automation control plane (notably the `Runtime.enable` CDP leak). Resolution (`infra/browsers/driver-resolver.ts`) is a guarded `createRequire(...)('patchright').chromium`, memoised per resolver instance (one per process, owned by the composition root) and **fail-open** to stock Playwright, so a partial install never breaks launch. The config key `stealthDriver` (08 §5.2, all three sources) selects the policy: `auto` (default, fail-open), `playwright` (force stock Playwright), `patchright` (mandatory; `BROWSER_NOT_INSTALLED` when unresolvable). The resolved driver name (`StealthDriverName`, `'patchright' | 'playwright'`) is reported by `server_status`, the banner and the System page. Patchright is always launched through its own `BrowserType`, never `connectOverCDP` (launch-time patches would be forfeited).
- Main-world evaluation: Patchright runs `page.evaluate` in an isolated world by default, while tools and probes need main-world semantics. `infra/browsers/evaluate.ts` `evaluateMainWorld(target, isolatedEvaluate, fn, arg?)` is the only call path: when the session's `SessionHandle.capabilities.isolatedEvaluate` is true (Patchright) it passes Patchright's fourth positional `isolatedContext: false` after an `undefined` options bag; otherwise it uses the plain two-argument form, because stock Playwright asserts at most three arguments and rejects a non-object third one. Branching on the driver capability, rather than always passing the extra argument, keeps both drivers correct.
- Engine seam (not built): `BrowserDriver.launch(spec) → SessionHandle { capabilities: { cdpScreencast, pdf, trace, closedShadowRoot, perContextProxy } }`. A second engine (Firefox/WebKit/Camoufox) would plug in here; live view and tools query `capabilities` rather than assuming Chromium.

### 2.2 Launch flags

- `STEALTH_ARGS = ['--disable-blink-features=AutomationControlled']` (projects `navigator.webdriver === false`), added only for stealth sessions and **not** deny-checked (internal).
- `ignoreDefaultArgs` gains `'--enable-automation'` (merge rule: user `true` left alone; array appended if missing; absent ⇒ `['--enable-automation']`).
- Merge order: channel args → stealth args → user args (user wins where the deny-list permits). `headless`, `channel`, `args` are stripped from user `launchOptions` and re-applied by BrowserHive; everything else passes through (`restLaunchOptions`).
- Persistence branches: `persistent` ⇒ `launchPersistentContext(userDataDir, {...common, ...identityContext, ...contextOptions})`; `memory`/`storage-state` ⇒ `launch(common)` then `newContext({...identityContext, ...contextOptions})`. Identity context options are spread **before** caller `contextOptions` so caller `viewport`/`locale`/`timezoneId` win.
- Isolation primitive: one browser subprocess + one context per session; `SessionLauncher`/`BrowserDriver` implementations must never share a `Browser` or `BrowserContext`.

### 2.3 Identity (every stealth session)

Applied by `applyIdentity` after launch, before the agent can drive the page.

- Inputs are **real**: CDP `Browser.getVersion()` (`product`, `userAgent`), `os.platform()`, `os.arch()`, the session's geo seed, and (if fingerprint) the display.
- `deriveCoherentIdentity()` (pure, sync):
  - UA = real UA with `HeadlessChrome` → `Chrome`. Never invents an OS or version.
  - UA-CH `brands` = `[GREASE 'Not_A Brand'/24, Chromium/<major>, Google Chrome/<major>]`; `fullVersionList` likewise with the full version. Adding `Google Chrome` is the point (bundled Chromium reports only Chromium + GREASE). The list replaces the browser's own, so real Google Chrome reports `Google Chrome` exactly once (measured). The same list is applied to `edge`, whose UA keeps `Edg/`: a known incoherence (§14).
  - `platform`/`platformVersion`: darwin → `macOS`, win32 → `Windows`, android → `Android`, else `Linux`. `platformVersion` is derived from `os.release()` (macOS: Darwin major → marketing version table; Windows: build → `15.0.0` for Win11 / `10.0.0` for Win10; Linux: kernel `major.minor.0`) with the constants `15.0.0` (macOS), `15.0.0` (Windows), `14.0.0` (Android) and `6.5.0` (Linux) as fallbacks when derivation fails, so a site always sees a plausible current value.
  - `architecture`/`bitness` from `os.arch()` (`arm64 → arm/64`, `x64 → x86/64`, …); `model: ''`; `mobile: platform === 'android'`; `wow64: false`.
  - `acceptLanguage` = `geo.languages.join(',')` **unweighted** (Chrome appends `q=` itself; pre-weighted input produced malformed `en-CA,en;q=0.9;q=0.9`). Omitted when `geo === null`.
  - `deviceMemory` fallback constant **8** (one constant, `PRESENTED_DEVICE_MEMORY`, §10).
- **Single-owner rule:** UA string, UA-CH metadata and `Accept-Language` are set together in one CDP `Emulation.setUserAgentOverride` and nothing else may write them: `fingerprint.ts` never emits `userAgent`/`extraHTTPHeaders`; `set_extra_http_headers` refuses `user-agent`, `accept-language`, `sec-ch-ua*` on stealth/fingerprint sessions (listed in `rejected`, not thrown).
- `setUserAgentOverride` is page-scoped and reverts when its CDP session detaches, so the session keeps **one CDP session per page** for the page's lifetime and replays the override to every new page (agent tabs and site-opened popups) via `context.on('page')`. `ensureStealthForPage(page)` returns the awaitable so `new_tab` waits before the first request. CDP sessions are tracked in a `WeakMap<Page, { cdp, ready }>` and detached on `page.on('close')`, so a long-lived session that opens many tabs holds no CDP session for a closed page.
- `installDeviceMemory` init script: defines `Navigator.prototype.deviceMemory` **only if** the browser reports `undefined`/`0`; masks the getter (see §2.4 masking rules).
- Failure of `applyIdentity` is non-fatal: warning `STEALTH_INIT_FAILED`, session continues; `session.identity` stays `null` and the dashboard shows "no override". Requested-vs-achieved posture is recorded (`stealth_requested`, `stealth_applied` columns, §7).

### 2.4 Display fingerprint (only `fingerprint: true`)

`deriveFingerprint({ seed, hostPlatform })` is a pure function of the seed (seeded `mulberry32` from `humanize/rng`).

Display catalogue per host family (`darwin → macos`, `win32 → windows`, else `linux`); Playwright's `1280×720` is deliberately absent:

| Family | Displays (`w×h@dsf`) | Furniture |
|---|---|---|
| macos | 1440×900@2, 1470×956@2, 1512×982@2, 1728×1117@2, 1920×1080@2, 2560×1440@2 | system bar 25 (top), browser chrome 87 |
| windows | 1920×1080@1, 1536×864@1.25, 1366×768@1, 1707×960@1.5, 2560×1440@1 | taskbar 48 (bottom), chrome 96 |
| linux | 1920×1080@1, 1366×768@1, 2560×1440@1 | panel 27 (top), chrome 96 |

Derivation, outside-in so the inequality chain holds by construction: display → `availHeight = height − bar` → 70 % maximised else inset window (`marginX` 40..12 % width, `marginY` 20..10 % height, random `screenX/Y` within margin) → viewport = outer minus chrome, height ≥ 400. Guarantee: `innerHeight < outerHeight ≤ availHeight ≤ height`.

Host-coherent, not foreign: `hardwareConcurrency`, WebGL vendor/renderer, canvas/audio/font entropy stay native on purpose (cross-checkable against the real GPU). Only per-user-arbitrary values vary. Under headless, "native" WebGL is Chromium's software renderer, not the host GPU (§14).

`contextOptionsFor(fp, geo, assertDisplay)`: `assertDisplay` ⇒ `{ viewport, deviceScaleFactor }`; else `{ viewport: null }` (track the real window — omitting the key would give 1280×720). Adds `locale`, `timezoneId`, and `geolocation` (only if the seed has coordinates) when `geo !== null`. Never emits `userAgent`, `extraHTTPHeaders`, `colorScheme`.

`installFingerprint(payload)` context-level init script (installed **before** `newPage()` so every tab/popup/frame is covered):
- Redefines `Screen.prototype.{width,height,availWidth,availHeight,availTop,availLeft}` getters.
- Redefines `window.{outerWidth,outerHeight,screenX,screenY}` **on the instance** (prototype definitions are shadowed), plus `screenLeft`/`screenTop` mirrors so `screenX === screenLeft`.
- `Navigator.prototype.deviceMemory` fallback if undefined/0.
- **Masking rules** (one shared helper, §10): every installed getter is registered in a `WeakMap`; `Function.prototype.toString` is replaced (via `defineProperty`, non-enumerable) with a Proxy returning `function get <prop>() { [native code] }` for registered getters and for itself; getter `name` is `get <prop>`; `enumerable: true`; `toString.call(undefined)` still throws `TypeError`. Self-description: raises the cost of detection, not invisibility.

### 2.5 Geo seed

`GeoSeed { locale, languages[], countryCode | null, timezoneId, geolocation?, source: 'host' | 'proxy' }`. `GeoSeedResolver.resolve({ sessionId, proxyServer? }): Promise<GeoSeed>` is a port, async, per session (never process-memoised), so a proxy-exit resolver is a one-line swap. `HostGeoSeedResolver`:
- Locale precedence `LC_ALL → LANG → ICU resolvedOptions().locale → 'en-US'` (POSIX parse `en_US.UTF-8 → en-US`; `C`/`POSIX`/`c`/`posix`/`und` rejected). Reason: Bun and Node disagree on ICU locale.
- Timezone from ICU `resolvedOptions().timeZone`, validated, fallback `UTC`.
- `languages = languagesForLocale(locale)` (`en-CA → ['en-CA','en']`, Chrome's behavior); `countryCode` = 2-letter region subtag.
- **Never invents coordinates**; `geolocation` undefined; `source: 'host'`. There is no IP→geo lookup; that is reserved for the proxy tier (§11).
- Host env is injected (`HostEnvironment`), not read from `process.env` (D-06 rule: no `process.env` below the composition root).

### 2.6 Coherence and downgrade rules (`resolveIdentity`, fingerprint on)

1. Caller supplied `locale` and/or `timezoneId` in `context_options` ⇒ seed built from them (missing half from the host), `source: 'host'`, no warning. Caller truth is honored.
2. Else BYO proxy present (`launchOptions.proxy`, `contextOptions.proxy`, or a raw arg starting with `--proxy-server`, `--proxy-pac-url`, `--host-resolver-rules`, or a resolved `LaunchSpec.proxy`, §11) ⇒ `geo = null`, warning `BYO_PROXY_UNSEEDED` ("display-only"). Host locale over someone else's exit IP is worse than asserting nothing.
3. Else `geo = await geoSeed.resolve({ sessionId, proxyServer })`.
4. Seed = restored profile's identity seed (`<name>.identity.json`) ?? session id (fresh sessions differ).
5. `assertDisplay = headless && !callerViewport`. Headful sessions get geo only (the window is really on screen). Caller `viewport` ⇒ warning `VIEWPORT_OVERRIDE_UNASSERTED` ("geo-only").

Flag collapse: `fingerprint = stealth && (request.fingerprint ?? default)`, `humanize = stealth && (request.humanize ?? default)`.

### 2.7 Humanize

Per-session decorator on `click`, `hover`, `type_text`, `scroll(by)` and the vault typer; constants and fallback rules are listed in `02-mcp-and-tools.md` §7. Seeded per session (one consistent "hand"); vault typer uses system RNG. After an operator takeover the cursor mirror is resynced from the operator's last pointer position; `set_viewport` invalidates it. `humanize/NOTICE.md` credits the prior art (ghost-cursor, MIT) whose path-shaping model and constants the pointer paths derive from.

## 3. Configuration knobs

All follow D-06 (env `BROWSERHIVE_*`, CLI `--camelCase`, file camelCase). Full table in `08-cli-arguments-and-config.md`; the stealth subset:

| Key | Values | Default | Notes |
|---|---|---|---|
| `stealth` | `off \| standard \| max` | `standard` | `off` = raw Playwright, non-stealth driver. `standard` = full binary + Patchright-if-available + flags + CDP identity + deviceMemory. `max` = standard + `fingerprint` default on. |
| `fingerprint` | bool | `false` (derived `true` under `max` when unset) | explicit `true` with `stealth=off` ⇒ config error |
| `humanize` | bool | `false` | `true` with `stealth=off` ⇒ config error |
| `defaultHeadless` | bool | `true` | per-session `headless` overrides |
| `defaultChannel` | `chromium \| chrome \| edge` | `chromium` | per-session `channel` overrides; `browserhive init` offers a computed choice (D-26) |
| `sandbox` | `auto \| on \| off` | `auto` | Chromium's sandbox (§4.1, D-27) |
| `stealthDriver` | `auto \| patchright \| playwright` | `auto` | `auto` = Patchright when resolvable, else stock Playwright; `playwright` is the kill switch that forces stock Playwright; `patchright` fails with `BROWSER_NOT_INSTALLED` if Patchright cannot be resolved. A full config key in all three sources, so the choice shows up in provenance and `config show` (see 08) |
| `captcha` | `attention \| off` | `attention` | `attention` is the documented behavior (operator via `request_attention`); no detection module ships; `solver` is a reserved enum member that fails fast until a solver exists (08 §5.4, D-25) |
| `blocklist` | path | none | §5 |
| `allowEvaluate` | bool | `true` | enforced by `evaluate` (D-12) |

Per-session overrides (`launch_session`): `stealth`, `fingerprint`, `humanize`, `headless`, `channel`, `context_options.locale/timezoneId/viewport`, BYO `launch_options.proxy`/`context_options.proxy`. Not configurable (constants): redaction window 5000 ms (`DEFAULT_REDACTION_WINDOW_MS`), vault confirm default timeout (`attentionTimeout`, D-15), field-entry ceiling 30 000 ms.

## 4. Launch-arg deny-list

Purpose: protect BrowserHive's own guarantees (isolation, managed data-dir, closed remote debugging). Enforced once in the `validate` phase before any spawn, on the trimmed key before `=`, case-sensitive; first offender ⇒ `UNSAFE_LAUNCH_ARG`. Internal stealth args bypass it. The constant is the single source of truth and a test asserts every entry is rejected.

`--user-data-dir`, `--profile-directory`, `--disk-cache-dir`, `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-web-security`, `--disable-site-isolation-trials`, `--disable-features`, `--single-process`, `--no-zygote`, `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`.

Sibling loose fields that bypass the intent of the deny-list (`chromiumSandbox: false`, `env`, `downloadsPath`, `recordVideo`) are **also refused** by the launch-option policy (`UNSAFE_LAUNCH_ARG` with the field name) — a correctness fix, not a behavior an agent could rely on. `--proxy-server`, `--proxy-bypass-list`, `--proxy-pac-url`, `--host-resolver-rules` stay **allowed** (BYO proxy) until a managed proxy layer exists (§11).

### 4.1 Chromium's sandbox (`sandbox`, D-27)

Playwright adds `--no-sandbox` unless `chromiumSandbox: true`. The `sandbox` key decides, per browser executable:

| Situation | `sandbox=auto` (default) | `sandbox=on` | `sandbox=off` |
|---|---|---|---|
| macOS / Windows, normal user | sandboxed | sandboxed | unsandboxed |
| Linux without the user-namespace restriction | sandboxed | sandboxed | unsandboxed |
| Ubuntu 23.10+, `chrome` from Google's package (Ubuntu ships its AppArmor profile) | sandboxed | sandboxed | unsandboxed |
| Ubuntu 23.10+, bundled `chromium` (no profile covers Playwright's path) | falls back, warns once | refuses to start (exit 3) with OS- and browser-specific guidance | unsandboxed |
| Running as root / default Docker | falls back (not attempted as root) | refuses to start (exit 3): root/container guidance | unsandboxed |
| The default sandboxes, an agent asks for a channel that cannot | that session falls back | that `launch_session` fails fast: `SANDBOX_UNAVAILABLE`, `retryable: never`, the channels that work | unsandboxed |
| Configured channel not installed | `BROWSER_NOT_INSTALLED` (no silent switch) | refuses to start: not installed, how to install | `BROWSER_NOT_INSTALLED` |

Facts behind it (measured through BrowserHive on GitHub's runners and an AppArmor-restricted Ubuntu 24.04 derivative):
- Ubuntu 23.10+ sets `kernel.apparmor_restrict_unprivileged_userns=1`: only programs with an AppArmor profile may create the user namespaces the sandbox uses. Ubuntu ships profiles for `/opt/google/chrome/chrome` (and `msedge`, `brave`, `opera`), none for `~/.cache/ms-playwright/…`, and the bundled `chrome_sandbox` helper is not setuid root. Chrome aborts with `No usable sandbox!`. Edge on the Ubuntu runner also failed, with a message that does not name the sandbox.
- Chrome refuses the sandbox as root (`Running as root without --no-sandbox is not supported`); Docker's default seccomp profile blocks namespace creation.
- macOS (Seatbelt) and Windows (restricted tokens, job objects) sandbox every channel with no extra rights.

Mechanics (`infra/browsers/sandbox-policy.ts`): one verdict per executable for the process lifetime. Under `auto` the first real launch tries the sandbox; if it fails and the same browser then starts without it, the verdict is "unavailable", sessions fall back and one `warn` log `sandbox fell back` names the channel, executable and Chrome's reason; concurrent first launches wait for that one attempt. A failure is blamed on the sandbox only when the unsandboxed launch works, so a browser broken for another reason surfaces its own error. Under `on` the boot preflight (`composition/sandbox.ts`) launches the configured browser once with the sandbox forced on before the listeners open and, if it cannot, probes the other installed browsers and refuses to start; a session for a browser that cannot sandbox fails typed (a proof launch without the sandbox is closed at once, so the session never runs unsandboxed). An agent's `launch_options.chromiumSandbox: true` is a requirement for that session in every mode; `false` is refused (§4). A launch failure caused by the sandbox is `SANDBOX_UNAVAILABLE` in every mode, never `INTERNAL_ERROR`.

**Sandbox on and off produce identical page-visible signals.** Measured on all three OSes for `chromium`, `chrome` and `edge` at both stealth levels (plan Phase 0 and the `sandbox-matrix` CI job) and asserted by `packages/browserhive/test/integration/sandbox-stealth.test.ts`.

`browserhive doctor --printApparmorProfile` prints a profile for the configured browser shaped like Ubuntu's own `/etc/apparmor.d/chrome` (`flags=(unconfined)` plus `userns`); BrowserHive never installs it.

## 5. URL blocklist

Operator policy (distinct from the deny-list). Format and matching:
- File, one glob per line; blank lines and `#` comments ignored; trimmed; lowercased (case-insensitive); duplicates skipped-but-reported; bare `*` and `*/*` refused; cap 10 000 entries (overflow reported in `skipped`); each entry keeps its 1-based line.
- Matching: URL reduced to `scheme//host[/path?query]` and `host[/path?query]` (non-default port kept; site root drops trailing `/`); only `http, https, ws, wss, ftp, ftps` considered (`about:`, `data:`, `blob:`, `chrome:`, unparseable ⇒ allowed, fail-open so `about:blank` works); anchored glob with `*` and `?` only (`.` and `/` literal); a pattern not ending in `*` is also tried with `/*` appended. Examples: `example.com` blocks site + subpaths; `*.example.com` subdomains only; `https://example.com/admin/*` scheme-specific; `*doubleclick*` substring.
- Enforcement: (1) tool boundary — `navigate`/`new_tab` policy `urlBlocklist` throws `URL_BLOCKED` before the browser is touched, audit `source: 'tool'`; (2) network — `context.route('**/*')` installed at creation only when the list is non-empty, aborts `document` requests only (`blockedbyclient`), audit `source: 'request'`; subresources deliberately pass (not an egress firewall; documented). Route install failure ⇒ warning `BLOCKLIST_ROUTE_FAILED`. The route handler is the first entry of the `InterceptionChain` seam; a handler exception **fails closed** for document requests, because a policy that fails open silently stops being a policy.
- Startup: a configured but unreadable file is fatal (never silently empty).
- Hot reload (D-22): a debounced file watcher (500 ms) and `POST /api/v1/blocklist/reload` recompile the matcher and swap it in atomically; live sessions pick up the new list on their next request (the route handler reads the current matcher); reload failures keep the previous list and emit `system.degraded`. Admin-editable DB rules remain a later step (security-intercept engine).
- Audit row `blocklist_hits (event_id, session_id, url, domain, pattern, source, tool, ts)`; dashboard Blocklist page shows patterns, hit counts, skipped lines and attempts.

## 6. Identity persistence

- Only the display **seed** is persisted, as `<name>.identity.json = { seed }` (0600) beside a saved **profile** snapshot, written by `save_full_profile` when `sessionFingerprint !== null`; failure ⇒ warning `IDENTITY_SEED_SAVE_FAILED`.
- `restore_profile` loads the seed so the same machine geometry returns with the same cookie jar. Geo is deliberately **not** saved (re-resolved from the restoring host).
- Storage-state snapshots carry no seed; memory sessions persist nothing.
- Reserved for later (not built): profile ↔ fingerprint ↔ proxy pinning fields in the profile blueprint model.

## 7. Durability

`sessions` rows carry launch facts, never re-derived: `stealth_requested`, `stealth_applied`, `fingerprint`, `humanize`, `identity_json` (UA, brands, platform, deviceMemory, chromeMajor, geo, display), `channel`, `headless`, `driver` (`patchright|playwright`), `proxy_label`. A column with no value (for example a session that crashed before identity was applied) is shown as "not recorded". Session metadata (`list_sessions`, `session_info`) exposes `stealth`, `fingerprint`, `humanize`, `identity`, `proxy_label`. The dashboard Identity card and System stealth tiles read these.

## 8. Patchright and Chromium installation

`browserhive init` installs Chromium for the pinned Playwright version and, unless `stealthDriver=playwright`, the Patchright Chromium (second download, same version pin; optional under `auto`, required under `patchright`). It then reports the installed Google Chrome and Microsoft Edge and whether each can sandbox, offers the default-browser choice (D-26, 08 §7.1), and can install Google Chrome with Google's installer (`playwright install chrome`, administrator rights) when asked. `--skipBrowsers` skips both downloads. No `postinstall` download ever (D-18). A missing browser at first `launch_session` is the typed error `BROWSER_NOT_INSTALLED` naming the exact command. `browserhive doctor` reports Playwright/Patchright versions, binary presence, and the resolved driver. `PLAYWRIGHT_BROWSERS_PATH` is honored. Playwright and Patchright are pinned exactly, to the same version, because Patchright patches a specific `playwright-core` release; the stealth integration suite (§9) is the gate for any bump.

## 9. Regression gate (integration suite, real Chromium, localhost fixture origin)

Probes run in the main world (`evaluateMainWorld`, §2.1). Sandbox parity (`test/integration/sandbox-stealth.test.ts`, every installed channel, `sandbox=off`, `auto` and an agent's `chromiumSandbox: true`): `auto` never fails a launch; `off` stays unsandboxed; every launched session passes the §6-of-the-plan checks (no `HeadlessChrome`, `Google Chrome` exactly once in the brands, `webdriver === false`, `window.chrome`, 5 plugins, `pdfViewerEnabled`, H.264/AAC `probably`, `fullVersionList` equal to the engine's real version); sandboxed and unsandboxed sessions report identical signals; a required sandbox the host cannot give fails as `SANDBOX_UNAVAILABLE`, `retryable: never`. Channels not installed skip with the reason printed. The cross-OS `sandbox-matrix` CI job runs the same harness on Linux, macOS and Windows for `sandbox=off|auto|on` and both stealth levels and puts the table in the job summary.

Phase 0 (`stealth: true`): UA lacks `HeadlessChrome` and contains `Chrome/`; `navigator.webdriver === false`; `userAgentData.brands` contains `Google Chrome` and `Chromium`; `deviceMemory > 0`; `typeof window.chrome === 'object'`; `plugins.length > 0`; metadata `identity` recorded with `Google Chrome`; non-stealth session: `webdriver === true`, `identity === null`; a new tab's **first wire request** already carries the overridden UA; the second tab has UA + brands.

Phase 1 fingerprint: chain `innerHeight < outerHeight ≤ availHeight ≤ height`, `innerHeight < screen.height`, viewport ≠ 1280×720; `languages.length > 1`, `languages[0] === language`, `Intl` locale === language; wire `Accept-Language` contains `;q=0.9`, never `/q=0\.9;q=/`, starts with `<language>,`; `Intl` timeZone === `geo.timezoneId`; `Screen.prototype.width` getter `.toString()` === `function get width() { [native code] }`, same for `window.outerHeight`; untouched `hardwareConcurrency`; `Function.prototype.toString.toString()` native; `toString.call(undefined)` throws `TypeError`; getter `.name === 'get width'`; `screenX === screenLeft && screenY === screenTop`; metadata display equals what the page saw; second tab same `availHeight`; `fingerprint: false` ⇒ `screen.height === innerHeight`, `display === null`.

Phase 1 humanize: curved pointer path (> 5 mousemoves, off-chord > 2 px, click inside box not at centre); typing with varying gaps (> 3 distinct 5 ms buckets, min gap > 5 ms) landing exact text; `humanize: false` click completes < 2 s.

Unit tests: channel map; fingerprint purity/variation/no-1280×720/Retina per platform/bar placement; `contextOptionsFor` never emits UA and emits `viewport: null` when not asserting; geo precedence, fallbacks, BYO detection incl. raw args; brands/platform/arch mapping; resolver fail-open + memoisation; deny-list rejects every key; blocklist format/matching/reload.

Third-party detection pages (sannysoft/CreepJS-style checks) are never a merge gate, because their availability and verdicts change without any change in BrowserHive; a nightly job running them with results attached is reserved (not built).

## 10. Invariants and shared helpers

Shared helpers (one implementation each, so two copies can never disagree or stack):
- One masked-getter init script (`infra/browsers/native-getter.ts`) with a single `Function.prototype.toString` proxy, shared by the display fingerprint and the deviceMemory fallback. Two independent proxies would wrap each other, and the outer one would report the inner proxy rather than native code. The script is serialised by Playwright, so the helper *is* the script and the fingerprint and identity modules only build its payload.
- One `PRESENTED_DEVICE_MEMORY = 8` constant.
- CDP sessions in a `WeakMap<Page, …>`, detached on page close (§2.3).
- `platformVersion` from `os.release()` with fixed fallbacks (§2.3).
- Injected `HostEnvironment` instead of `process.env` reads (D-06).
- `stealth_applied` recorded separately from `stealth_requested` (§7), so a degraded launch is visible.

Invariants. A change MUST NOT alter the following without a decision-log entry, because each one is either what real Chrome does on this host or a guarantee the §9 probes assert:
- Catalogue values and furniture constants (§2.4): real display sizes and window chrome keep `innerHeight < outerHeight ≤ availHeight ≤ height` true, and Playwright's 1280×720 default is a known automation tell.
- Brand list and GREASE brand, and the `HeadlessChrome → Chrome` rewrite (§2.3): they match what Google Chrome sends.
- The single-owner rule and per-page override replay with awaitability (§2.3): two writers of UA/UA-CH/`Accept-Language` produce contradictory signals, and an unreplayed or unawaited override leaks the raw UA on a new tab's first request.
- Unweighted `Accept-Language` input (§2.3): Chrome appends `q=` itself.
- The merge orders and `viewport: null` for headful/unasserted sessions (§2.2, §2.4): the caller's explicit options win, and omitting the key would reintroduce 1280×720.
- The downgrade rules and warning codes (§2.6): asserting nothing beats asserting something inconsistent, and agents and operators read the warnings.
- Main-world evaluation through `evaluateMainWorld` (§2.1).
- Deny-list contents (§4): they protect isolation, the managed data dir and closed remote debugging.
- Blocklist grammar and dual enforcement (§5): operators' blocklist files must keep meaning the same thing across releases.
- Humanize constants and fallback rules (02 §7), and seed persistence semantics (§6).

## 11. Proxy: reserved design (not built)

BYO works today with zero code: Playwright's `proxy: { server, bypass, username, password }` rides through `launch_options`/`context_options`. The seam is explicit so a managed tier can land without touching stealth modules. Acceptance criterion for that tier: `fingerprint`, identity, `applyIdentity`, launcher merge and the dashboard Identity card stay **untouched** when the pool arrives.

Built (D-13):
- `LaunchSpec.proxy?: { server: string; username?: string; passwordRef?: SecretRef; bypass: string[]; label: string; source: 'byo' | 'managed' }` — a typed first-class field. BYO input from `launch_options.proxy`/`context_options.proxy` is normalised into it; raw `--proxy-*` args are detected (`byoProxyPresent`) and still allowed.
- `ProxyResolver` port: `resolve({ sessionId, requested }): Promise<LaunchSpec['proxy'] | null>`. Default implementation: pass-through of the BYO value with a **forced `bypass` list** for loopback and RFC1918 (`localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, *.local`) unioned with the caller's, so the dashboard CDP/screencast and local fixtures never tunnel.
- `proxy_label` (never credentials) on `SessionMetadata`, `sessions.proxy_label` column, `proxy_assigned` domain event (label + source), Identity card shows "host-seeded" vs "proxy-seeded" from `GeoSeed.source`.
- `GeoSeedRequest.proxyServer` populated from the resolved proxy (still ignored by the host resolver).
- Proxy passwords go through the always-on `SecretRegistry` (redacted in logs/events).

Future tiers (roadmap; not built):
- **Tier 0** single static proxy: `proxy` config key (`scheme://user:pass@host:port`, env `BROWSERHIVE_PROXY`), per-session arg; local auth shim (`proxy-chain` `anonymizeProxy()` → `http://127.0.0.1:<port>`) because Chromium cannot do authenticated SOCKS5; forced bypass as above; shim lifecycle per session.
- **Tier 1** named pool: `proxies` table (`id, label, server, username, vault_ref, tags, weight, enabled`), `ProxyPool.acquire(sessionId, selector)/release`, strategies `sticky-per-session` (default) | round-robin | random | least-connections | weighted | rotating-per-request (warned); tag selectors; failure eviction; MCP read-only `list_proxies`; CRUD operator-side only.
- **Tier 2** health sweeper (EWMA, egress IP), offline GeoLite2 verification (opt-in licence), per-domain routing rules, CA-cert trust, dashboard Proxies panel, sticky tag remembered with saved profiles.
- Mandatory coupling: proxy exit geo must be resolved **before** fingerprint/locale/timezone derivation (the `GeoSeedResolver` seam), or a proxy is net-negative for stealth. Once managed proxies exist, deny `--proxy-server`, `--proxy-bypass-list`, `--proxy-pac-url`, `--host-resolver-rules` (raw args would bypass shim, bypass list, coherence and vault refs).
- Vocabulary to adopt when built: `server`, `username`/`password`, `geolocation: { country, state, city }`, `bypass`, per-domain routing.
- Non-mechanism: live-browser TLS/JA3/JA4 spoofing (no Playwright seam; already ~Chrome-identical).

## 12. Vault typing and traces

Playwright tracing (default on with `admin=true`) serialises input values and network request bodies into `trace.zip`. The session's `TracingHandle` (`infra/browsers/tracing.ts`, state machine `idle → recording ⇄ paused → stopped`) therefore performs a **full stop and restart** around a `vault_fill` (D-13): `pauseChunk()` runs `tracing.stop({ path: <partsDir>/part-N.zip })` before the first credential keystroke, and `resumeChunk()` runs `tracing.start(originalOptions)` after submit (or after clear/failure, in `finally`). At close, `stop(path)` writes the last recording as a final part and merges every part into the session's `trace.zip`; each part keeps its own trace and network ordinal, which the trace viewer loads as one timeline. `partsDir` comes from `LaunchSpec.tracing`.

A chunk-level pause (`tracing.stopChunk`/`startChunk`) is not sufficient: it keeps Playwright's network tracer running, so the login POST body would land in the resumed chunk. With a full stop nothing records between pause and resume, so neither the typed credential nor the submitted request appears in any part; `packages/core/test/integration/vault.test.ts` unzips the merged trace and asserts the credential string is absent. A pause or resume failure is logged at `warn` and never fails the fill. `clear_after_fill` semantics are independent of tracing. Screenshot-trace capture is suppressed while a redaction window is open. The live-view screencast remains raw pixels (documented; operator is trusted).

## 13. Hardening in place and deferred work

In place (specified above): the shared getter-masking helper; one deviceMemory constant; CDP session pruning; `platformVersion` from `os.release()`; blocklist hot reload + reload endpoint; typed `LaunchSpec.proxy` + `ProxyResolver` + forced bypass; `stealth_applied` vs requested; trace exclusion around vault typing; the sibling-field launch-option policy; the fail-closed blocklist route.

Deferred (seam only, not built): stealth self-test page on the dashboard System page (bundled probe asserting §9 invariants after a Chrome/Patchright bump); explicit `identity_seed` per-session option to pin an identity across memory sessions; reading GREASE brand from a throwaway page; TTY vault unlock; DOM-reading tool gate during a fill (not claimed by the user docs); OOPIF coverage via `Target.attachedToTarget`; CAPTCHA detection module and `solve_captcha_via_attention`; Web Bot Auth signing; engine capability map beyond the single Chromium driver.

## 14. Known ceilings (documented, not fixed)

- **TLS/JA3/JA4**: not changeable through Playwright; a non-mechanism.
- **OOPIF**: out-of-process iframes are not covered by the per-page UA override (needs `Target.attachedToTarget`); cross-origin frames may report the raw UA.
- **Hardest gates (Turnstile/Brotector)**: CDP command choreography and input provenance remain residual signals; OS-level input transports are out of scope.
- **Canvas/audio/font entropy**: host-coherent by design; a stable host-linked identity, not a rotating one.
- **GREASE brand / `platformVersion`**: plausible values, not byte-exact live-Chrome values.
- **Blocklist is not egress control**: subresources pass; an `evaluate`-enabled agent can `fetch()` a blocked URL.
- **Headless WebGL is software-rendered.** Measured through BrowserHive (headless, `stealth=standard`, Patchright, Chrome for Testing 153), with and without `fingerprint`: `UNMASKED_RENDERER_WEBGL` is `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` on a host that has a GPU. A headless session therefore presents as a GPU-less machine; headed sessions use the real GPU.
- **Headless notification permission.** Measured again through BrowserHive (Chromium 153 bundled and Google Chrome 154, headless): before any request `navigator.permissions.query({ name: 'notifications' })` answers `prompt` and `Notification.permission` is `default`, which agree; `Notification.requestPermission()` resolves `denied` after about 1.7 s without showing anything, after which both read `denied`. The silent auto-deny is the remaining tell (an earlier measurement found `Notification.permission` already `denied` before a request). Same with and without `fingerprint` or the sandbox; not masked.
- **Edge is presented as Google Chrome.** With `channel: 'edge'` and stealth on, the brands read `Not_A Brand, Chromium, Google Chrome` with Edge's own version (for example `153.0.4234.48`) as the Chromium version, while `navigator.userAgent` keeps `Edg/153.0.0.0`; real Edge reports `Microsoft Edge` and Chromium's version. A site that compares the two sees the mismatch. Measured on all three OSes; fixing it is an open decision. `chrome` is the recommended channel for stealth.
- **Headless WebGL per OS.** Measured through BrowserHive: SwiftShader on Linux, "Microsoft Basic Render Driver" on the Windows runner, "Apple Paravirtual device" on the macOS VM, the same for `chromium`, `chrome` and `edge` and with or without the sandbox.
- **Default geometry is Playwright's.** With `fingerprint: false` — the default under `stealth=standard` — a headless session reports a 1280×720 screen and viewport, the size the display catalogue deliberately excludes (§2.4). `fingerprint: true` (default under `stealth=max`) replaces it with a catalogue display, e.g. 2560×1440 on Linux.

## Design notes

- `captcha=solver` is a reserved enum member: accepting a value with no implementation would tell the operator CAPTCHAs are handled when they are not. When a solver tier ships, making it a real member is additive.
- `BROWSERHIVE_STEALTH_DRIVER` is the env spelling of `stealthDriver`; `BROWSERHIVE_DISABLE_PATCHRIGHT` is an unsupported spelling answered with a hint naming it (08 §5.5).
- Refusing `chromiumSandbox: false`, `env`, `downloadsPath` and `recordVideo` in pass-through launch options closes a high-severity bypass of the deny-list's intent (sandbox off, injected environment, writes outside the managed data dir); the error code reuses `UNSAFE_LAUNCH_ARG` with the field name in details.
- **The Chromium sandbox is on wherever the host allows it (D-27).** Before the `sandbox` key every session ran with `--no-sandbox`, because Playwright adds it unless told otherwise. Enabling it unconditionally would have broken every Ubuntu 23.10+ host with the bundled browser, so `auto` (the default) sandboxes per executable and falls back where it cannot, and `on` turns the sandbox into a guarantee checked at startup (§4.1). The refusal of `chromiumSandbox: false` stays, so an agent can never weaken the operator's setting.
