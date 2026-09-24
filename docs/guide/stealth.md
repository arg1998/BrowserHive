# Stealth

Stealth makes a BrowserHive session report what a real Chrome on your machine would report, and optionally makes input look hand-made. It is **not** invisibility. This page says what it does, what it does not do, and where the ceilings are.

The principle: **assert nothing rather than assert something wrong.** BrowserHive never invents an operating system, GPU, timezone or location. Everything it presents is derived from the real host.

## Levels

| `--stealth` | What you get |
|---|---|
| `off` | Stock Playwright Chromium. `navigator.webdriver` is `true`. No identity override. |
| `standard` (default) | The full Chromium binary in new-headless mode, the Patchright driver when installed, automation flags removed, and a coherent identity applied through the DevTools protocol. |
| `max` | `standard` plus a display fingerprint (`fingerprint` defaults to `true`). |

Related keys:

| Key | Default | Effect |
|---|---|---|
| `--stealthDriver` | `auto` | `auto` uses Patchright when installed, else Playwright. `patchright` requires it (startup fails with [`BROWSER_NOT_INSTALLED`](../reference/errors.md#BROWSER_NOT_INSTALLED) if missing). `playwright` never uses it. |
| `--fingerprint` | `true` only with `max` | Coherent screen and window geometry per session. Requires `standard` or `max`. |
| `--humanize` | `false` | Human-like pointer paths and typing rhythm. Requires `standard` or `max`. |
| `--defaultHeadless` | `true` | Default for `launch_session` `headless`. |
| `--defaultChannel` | `chromium` | Default browser: `chromium`, `chrome` or `edge`. |

An agent can override `stealth`, `fingerprint`, `humanize`, `headless` and `channel` per session in [`launch_session`](../reference/tools.md#launch_session). The dashboard's **Identity** tab shows what each session actually presents, and `list_sessions` / `session_info` return it as `identity`.

## What `standard` does

- **Real browser binary.** `chromium` runs the full Chromium build, never the stripped headless shell. That restores `window.chrome`, plugins, MIME types, the PDF viewer flag and hardware WebGL.
- **Automation signals removed.** `navigator.webdriver` is `false`; the `--enable-automation` switch is not passed.
- **Patchright** (when installed by `browserhive init`) patches the remaining automation leaks at launch. `evaluate` still runs in the page's main world.
- **One coherent identity**, set through the DevTools protocol on every page, including new tabs and popups before their first request:
  - User agent: the real one, with `HeadlessChrome` rewritten to `Chrome`.
  - Client hints: brands `Chromium` and `Google Chrome` with the real version, platform and architecture from the host, platform version from the OS release.
  - `Accept-Language` from the host locale (`en-CA` → `en-CA,en`), and `navigator.deviceMemory` when the browser would report none.
- **Locale and timezone** from the host (`LC_ALL`, `LANG`, the system timezone). No coordinates are ever set.
- `set_extra_http_headers` refuses to change `user-agent`, `accept-language` and `sec-ch-ua*` on stealth sessions, so the identity stays consistent.

## What `fingerprint` adds

A believable screen for headless sessions: a display size from a catalogue that matches the host OS family (for example 1512×982 at 2× on macOS, 1920×1080 on Windows and Linux; never Playwright's default 1280×720), with a window size and position derived from it so that `innerHeight < outerHeight ≤ availHeight ≤ screen.height` always holds. The patched getters report themselves as native code.

It is seeded per session. A profile saved with `save_full_profile` keeps its seed, so restoring it brings back the same screen with the same cookies. Hardware concurrency, WebGL vendor and renderer, canvas, audio and fonts are left native on purpose: they are cross-checkable against the real GPU.

Downgrades, each recorded as a session warning:

- A headed session gets locale and timezone only, because its window is really on screen.
- A caller-supplied `viewport` keeps the geometry unasserted ([`VIEWPORT_OVERRIDE_UNASSERTED`](../reference/errors.md#VIEWPORT_OVERRIDE_UNASSERTED)).
- A proxy passed in `launch_options` or `context_options` disables the host locale and timezone, because host values over someone else's exit IP are worse than none ([`BYO_PROXY_UNSEEDED`](../reference/errors.md#BYO_PROXY_UNSEEDED)).
- A caller-supplied `locale` or `timezoneId` is honoured.

If applying the identity fails, the session continues without it and records [`STEALTH_INIT_FAILED`](../reference/errors.md#STEALTH_INIT_FAILED).

## What `humanize` adds

`click`, `hover`, `type_text`, `scroll` (by offset) and vault typing use curved pointer paths with overshoot, Fitts-law timing, press dwell, and typing with varied intervals, word pauses and occasional corrected typos. It is seeded per session, so each session has one consistent "hand". Long text (over 400 characters) and calls whose timeout budget is too small fall back to native input, so timeouts keep working. `fill`, `select_option` and `drag_and_drop` stay native.

## Launch-argument guard

To protect isolation, `launch_options.args` may not contain `--user-data-dir`, `--profile-directory`, `--disk-cache-dir`, `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-web-security`, `--disable-site-isolation-trials`, `--disable-features`, `--single-process`, `--no-zygote` or the remote-debugging switches. `chromiumSandbox: false`, `env`, `downloadsPath` and `recordVideo` are refused too. Violations fail with [`UNSAFE_LAUNCH_ARG`](../reference/errors.md#UNSAFE_LAUNCH_ARG). An `executablePath` override is allowed but disables channel routing ([`EXECUTABLE_PATH_OVERRIDE`](../reference/errors.md#EXECUTABLE_PATH_OVERRIDE)).

## Proxies

There is no managed proxy support. Bring your own through Playwright's options:

```jsonc
launch_session({
  "slug": "geo",
  "launch_options": { "proxy": { "server": "http://proxy.example:3128", "username": "u", "password": "p" } }
})
```

Loopback and private network ranges are always bypassed so local tooling never goes through the proxy. The session records a `proxy_label` (never credentials). Chromium's raw proxy switches are also accepted in `args`. A managed pool with rotation and exit-IP geolocation is planned; the configuration key `proxy` is reserved for it and rejected today.

## Ceilings

These are known and documented, not bugs:

- **TLS fingerprints** (JA3/JA4) cannot be changed through Playwright. They are already close to Chrome's.
- **Out-of-process iframes** are not covered by the user-agent override; cross-origin frames may report the raw user agent.
- **The hardest bot checks** (for example Cloudflare Turnstile in strict mode) can still detect DevTools-protocol automation and synthetic input. Use [human takeover](attention.md) for them.
- **Canvas, audio and font entropy** are the host's own: a stable identity tied to your machine, not a rotating one.
- **GREASE brand and platform version** are plausible values, not byte-exact copies of the installed Chrome.
- **Headless sessions render WebGL in software.** The reported WebGL renderer is SwiftShader even on a machine with a GPU, so a headless session looks like one without a GPU. Headed sessions use the real GPU.
- **Headless sessions contradict themselves on notification permission**: the Permissions API says `prompt` while `Notification.permission` says `denied`.
- **Without `--fingerprint`, headless sessions use Playwright's default 1280×720 screen**, a size real users rarely have. `--fingerprint` (on by default with `--stealth max`) picks a common display size instead.
- **WebAuthn and passkeys** cannot be replayed from saved state.
- **Firefox and WebKit** are not supported.

Stealth is a capability for legitimate automation of sites you are allowed to use. Respect their terms.
