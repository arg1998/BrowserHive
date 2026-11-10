# FAQ

**Does it run on Node.js?**
No. Bun ≥ 1.4 is the runtime. You can install the package with npm or pnpm, but Bun must be installed to run it.

**Why one port for everything?**
MCP, the REST API, the WebSocket and the dashboard share `--port`, so there is one bind rule, one authentication surface and one health check (`/health`).

**How isolated are sessions?**
Each session is its own Chromium process with its own browser context: separate cookies, local storage, IndexedDB, cache and service workers. Nothing is shared between sessions, except between sessions launched from the same [session template](templates.md), which share one signed-in browser on purpose.

**Can several agents share a session?**
With `--auth token`, a session belongs to the principal (token) that created it and other agents cannot see it. Without authentication every caller is `local` and sees every session.

**Do sessions survive a restart?**
With `persistence_mode: "persistent"` (or `--persistence persistent`) the profile is kept on disk under the data directory. Memory sessions are gone when they close. Agents can also save a login with `save_storage_state` or `save_full_profile` and restore it in a later session. A full-profile snapshot leaves out the browser's caches (HTTP, compiled code, GPU and shader caches, service-worker caches), which the browser rebuilds; cookies, local storage, IndexedDB and saved passwords are kept. Saving a large profile streams it to disk, so other sessions keep working meanwhile.

**Where are my passwords?**
In your password manager. BrowserHive stores only bindings (which entry may be filled on which origins, by which sessions) and an audit log without secrets.

**Can the model read a password after a fill?**
Not through tool results while the redaction window is open, and never from BrowserHive's logs, database or traces. An agent with `evaluate` could read a field that still contains the value later; see [Security](security.md#redaction-and-its-limits) for the mitigations.

**Does it phone home?**
No. Telemetry is opt-in and goes only to the OTLP endpoint you configure. [Notification channels](notifications.md) are opt-in too: each sends only to the Telegram bot, Discord channel, ntfy topic or webhook you set up, at the content level you pick. BrowserHive runs no servers of its own.

**Does it solve CAPTCHAs?**
No. An agent can ask a human with `request_attention`; see [Human takeover](attention.md).

**Is stealth undetectable?**
No. It makes the browser coherent and removes common automation signals. The limits are documented in [Stealth](stealth.md#ceilings).

**Firefox or WebKit?**
Not yet. Chromium, Chrome and Edge channels are supported.

**Proxies?**
Pass Playwright's `proxy` in `launch_options` (or `context_options`) today. Loopback and private networks are always bypassed. A managed pool is planned.

**Can I run it in Docker or on a server?**
Yes. Bind with `--host 0.0.0.0 --auth token`, put a TLS reverse proxy in front, add the name it forwards to `--allowedHosts`, and configure it with environment variables; see [Configuration](configuration.md#environment-only-deployments).

**How do I keep secrets out of `browserhive.config.json`?**
Write a reference to an environment variable in their place: `"authTokens": "ci-runner:{env:CI_TOKEN}"` or `"otelHeaders": { "Authorization": "Bearer {env:OTLP_TOKEN}" }`. The file can then be committed, `config show` and the dashboard name the variable without showing its value, and `doctor` stops asking you to `chmod 600` the file. See [References](configuration.md#references).

**How many sessions can I run?**
By default `min(floor(RAM in GiB / 1.5), 20)`. Each Chromium session typically needs a few hundred MB. Set `--maxSessions` to override.

**How much is recorded, and for how long?**
Tool calls, navigations and audit rows are kept for 7 days or up to 1 GiB by default (`--retentionDays`, `--retentionBytes`). `--recordToolResults shape` or `none` stores less. See [Security](security.md#what-is-recorded).

**What is a session template for?**
Signing agents in to sites without giving them your password. You sign in to the sites once, in a window BrowserHive opens; agents then launch sessions from the template that start signed in. See [Session templates](templates.md).

**Why do a template's sessions share one browser instead of each getting a copy?**
Because a site sees one person on one device. Copies of a signed-in profile running side by side look like the same account on several devices at once, with sign-ins that drift apart and refresh tokens that invalidate each other, which sites can answer by signing everyone out or asking for verification. One browser keeps one cookie jar, one fingerprint and one IP address, and each session still gets its own windows and sees only its own pages. It also costs less memory: one window instead of one browser per session.

**Can two agents use one template at once?**
Yes, up to the template's cap (`max_concurrent`, default 5). Each gets its own session and windows. They share the sign-ins and site data, so one agent signing out signs the others out. See [what agents can observe](templates.md#what-agents-can-observe).

**Can agents see the cookie values of a template?**
Not by default. Template sessions are sealed: `get_cookies` returns names with empty values, `evaluate`, `set_cookies` and `save_storage_state` are refused, and cookie values are replaced with `[sealed]` in text results. You can unseal a template, for every agent or some. Sealing does not stop an agent from acting as the account, and it does not hold against an agent that can run commands as BrowserHive's OS user. See [Sealing](templates.md#sealing).

**Can I sign a template in to Google?**
Maybe not. Google may refuse sign-ins in a browser controlled through automation, which a template's browser is even while you type in it. Whether a person can complete the Google sign-in there is still being verified. Seeding a template from a storage state saved in another browser, the fallback for such sites, arrives in a later release.

**Is it free?**
Yes, MIT licensed.
