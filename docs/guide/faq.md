# FAQ

**Does it run on Node.js?**
No. Bun ≥ 1.4 is the runtime. You can install the package with npm or pnpm, but Bun must be installed to run it.

**Why one port for everything?**
MCP, the REST API, the WebSocket and the dashboard share `--port`, so there is one bind rule, one authentication surface and one health check (`/health`).

**How isolated are sessions?**
Each session is its own Chromium process with its own browser context: separate cookies, local storage, IndexedDB, cache and service workers. Nothing is shared between sessions.

**Can several agents share a session?**
With `--auth token`, a session belongs to the principal (token) that created it and other agents cannot see it. Without authentication every caller is `local` and sees every session.

**Do sessions survive a restart?**
With `persistence_mode: "persistent"` (or `--persistence persistent`) the profile is kept on disk under the data directory. Memory sessions are gone when they close. Agents can also save a login with `save_storage_state` or `save_full_profile` and restore it in a later session.

**Where are my passwords?**
In your password manager. BrowserHive stores only bindings (which entry may be filled on which origins, by which sessions) and an audit log without secrets.

**Can the model read a password after a fill?**
Not through tool results while the redaction window is open, and never from BrowserHive's logs, database or traces. An agent with `evaluate` could read a field that still contains the value later; see [Security](security.md#redaction-and-its-limits) for the mitigations.

**Does it phone home?**
No. Telemetry is opt-in and goes only to the OTLP endpoint you configure.

**Does it solve CAPTCHAs?**
No. An agent can ask a human with `request_attention`; see [Human takeover](attention.md).

**Is stealth undetectable?**
No. It makes the browser coherent and removes common automation signals. The limits are documented in [Stealth](stealth.md#ceilings).

**Firefox or WebKit?**
Not yet. Chromium, Chrome and Edge channels are supported.

**Proxies?**
Pass Playwright's `proxy` in `launch_options` (or `context_options`) today. Loopback and private networks are always bypassed. A managed pool is planned.

**Can I run it in Docker or on a server?**
Yes. Bind with `--host 0.0.0.0 --auth token`, put a TLS reverse proxy in front, and configure it with environment variables; see [Configuration](configuration.md#environment-only-deployments).

**How many sessions can I run?**
By default `min(floor(RAM in GiB / 1.5), 20)`. Each Chromium session typically needs a few hundred MB. Set `--maxSessions` to override.

**How much is recorded, and for how long?**
Tool calls, navigations and audit rows are kept for 7 days or up to 1 GiB by default (`--retentionDays`, `--retentionBytes`). `--recordToolResults shape` or `none` stores less. See [Security](security.md#what-is-recorded).

**Is it free?**
Yes, MIT licensed.
