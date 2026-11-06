---
title: "Session templates and site packs"
spec: "13"
status: Normative
scope: Session templates (a signed-in browser identity an operator records once and agents launch sessions from), live mode (one shared browser per template, one window per agent session), sealing, template access, health and re-login, versions, and site packs (signed per-site data selecting from strategies compiled into the binary) with their registry on browserhive.ai; every surface they add, and the PR program that delivers them.
audience: Contributors implementing templates or site packs; reviewers of the session model, the interception chain and the registry trust chain; operators and agent authors who want the exact contract.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
  - 02-mcp-and-tools.md
  - 03-admin-backend.md
  - 04-admin-frontend.md
  - 08-cli-arguments-and-config.md
  - 09-testing.md
  - 10-error-handling-and-telemetry.md
  - 11-stealth.md
---

# 13 — Session Templates and Site Packs

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: the template object and its storage, live mode (one shared browser per template), the agent surface (`list_templates`, `launch_session.template`, sealing), template access, the recording workflow, health and re-login, versions, site packs and their registry, every REST/WS/dashboard/CLI/config/telemetry surface they add, and the PR program (§17). Decisions: D-49 (templates are their own object), D-50 (live mode and the shared-browser session model), D-51 (sealing and tracing), D-52 (template access), D-53 (template state at rest), D-54 (site packs are data selecting from a closed strategy set), D-55 (registry delivery and update policy), D-56 (capacity accounting).

**Implementation status.** This spec describes the target design. It is delivered by the PRs of §17 (T0 to T4); until a PR lands, the current behaviour of the other specs applies to what that PR changes. Each section names the PR that delivers it where that is not obvious. Code references (`file:line`) point at `main` @ `72f20e7` (schema v7, 43 tools) and describe what exists today.

---

## 1. Concepts

### 1.1 Glossary

| Term | Meaning |
|---|---|
| **Session template** (template) | An operator-owned, named browser identity: a pinned fingerprint, network and locale, a persistent Chromium profile signed in to one or more sites, a policy, versions and per-site health. Identified by `tp-<nanoid10>`, addressed by agents by its `name`. |
| **Site** | One registrable domain (eTLD+1, as `getDomain` computes it, `packages/core/src/kernel/url.ts:59`) a template is signed in to, for example `linkedin.com`. A site may have a site pack. |
| **Template host** (host) | The one long-lived browser of a template: a persistent context on `<data-dir>/templates/<id>/userdata`, headed by default, with a sentinel window. At most one host per template exists at a time. |
| **Sentinel window** | The host's first window, never attributed to any session, kept open so the browser survives having no sessions (a headed persistent context exits when its last page closes). |
| **Live mode** | The only concurrent template mode: every session launched from a template is a virtual session of its host. |
| **Virtual session** | A session (`<slug>-<nanoid8>`, a normal `sessions` row) that owns a set of windows and pages of a host instead of a browser of its own. It shares the host's cookie jar, storage, fingerprint and IP with its siblings. |
| **Exclusive session** | Every session that is not virtual: one browser and one context of its own, as before (D-21). |
| **Maintenance session** | A virtual session BrowserHive opens on a host for its own work: one per recording or re-login (slug `recording` or `relogin`, owned by the operator who started it) and one per host start for probes and keep-alive visits (slug `maintenance`, owned by `browserhive`, closed with the host). Never counted against the template's cap, never visible to agents, hidden from the dashboard's session list unless asked for (§11.1). |
| **Page attribution** | The rule that assigns each page of a host to exactly one session, or to none (a parked page), before any session can see it (§3.4). |
| **Parked page** | A page of a host that no session owns: the sentinel, windows the operator opened by hand, windows a service worker opened. Never in any `TabRegistry`. |
| **Serial checkout** | A deferred mode (§16): one copy of the template at a time under an exclusive lease, written back on close. Never N concurrent copies. |
| **Sealing** | The default restriction of template sessions so an agent can use the sign-ins but not read or export them (§5.4, D-51). **Unsealing** relaxes it per template. |
| **Checkpoint** | An encrypted storage-state snapshot of the host's context written by the host, the single writer (§2.4, §3.9). |
| **Version** | A numbered checkpoint kept for rollback (`template_versions`). The live profile is the template; versions are its backups. |
| **Probe** | A per-site check of whether the host is signed in, with one of four outcomes: `signed_in`, `signed_out`, `challenged`, `inconclusive` (§8.1). |
| **Re-login** | Restoring a site's sign-in in the host: in a window on the BrowserHive machine, through an agent's attention request, or by a vault fill into the host (§8.4). |
| **Site pack** (pack) | Signed, versioned, declarative data about one site (sign-in, signed-in detection, guards, challenges, pacing, write policy, browser and consistency requirements, strategy selections). Data only, never code (D-54). |
| **Strategy** | A named behaviour compiled into the binary (`SiteStrategy`) that a pack may select and parameterise within bounds the binary fixes (§9.4). |
| **Guard** | A pack rule that matches requests by method, URL glob and resource type, or elements by role and name, and blocks, holds for confirmation, or warns (§9.3). |
| **Write policy** | Per site, what happens to requests a pack marks as writes: `allow`, `warn` or `confirm` (an operator approves each one). |
| **Tightening / loosening** | The classification of every pack change (§9.7): tightening makes BrowserHive more conservative; loosening or a new domain always waits for the operator's approval. |
| **Registry** | The static, signed files on `browserhive.ai/registry/v1/` from which BrowserHive downloads pack updates (§10). |

### 1.2 Picture

```
                       ┌──────────────── template "job-hunt" (tp-…) ────────────────┐
launch_session         │ host: one Chromium, one persistent context, one cookie jar   │
 {slug, template} ───► │  ┌ sentinel ┐  ┌ window A ────────┐  ┌ window B ──────────┐ │
                       │  │(parked)  │  │ session jh-a1b2… │  │ session jh-c3d4…   │ │
                       │  └──────────┘  │ tab t-… tab t-…  │  │ tab t-…            │ │
                       │                └──────────────────┘  └────────────────────┘ │
                       │  identity: seed, Chrome major, UA-CH, screen, locale, tz, geo │
                       │  network: one pinned proxy (or the host's IP)                 │
                       │  userdata/ (live profile)   versions/vN.state.enc (encrypted) │
                       └──────────────────────────────────────────────────────────────┘
```

### 1.3 What does not change for agents

The 43 existing tools keep their names, parameters, defaults and result shapes (D-12). A template session is driven exactly like any other session; it is opened with one new optional parameter and listed with one new tool (§5). The differences an agent can observe are listed in §5.6.

---

## 2. The template object

### 2.1 Fields

`Template` is the wire shape (snake_case, D-05) used by REST, WS and the dashboard. Agents see only the subset of §5.1.

| Field | Type | Default | Notes |
|---|---|---|---|
| `template_id` | string `tp-<nanoid10>` | minted | permanent; names the directory |
| `name` | string `^[a-z][a-z0-9-]{1,31}$` | required | unique; what agents pass as `launch_session.template`; renaming is allowed and breaks agents that use the old name (the editor says so) |
| `display_name` | string 1–80 | `name` | shown in the dashboard |
| `description` | string 0–500 | `''` | shown to agents in `list_templates`; plain text |
| `status` | `recording` \| `ready` \| `disabled` | `recording` | `recording` until the first version exists; `disabled` by the operator; only `ready` templates can be launched |
| `owner` | principal subject | creator | the operator principal that created it |
| `sites` | `TemplateSite[]` 1–16 | required | §2.3 |
| `identity` | `PinnedIdentity` | resolved at creation | frozen (§2.2) |
| `channel` | `chromium` \| `chrome` \| `edge` | server `defaultChannel`, or `chrome` when a pack asks for it and Chrome is installed | frozen; a change requires a host restart and is confirmed in the editor |
| `headless` | boolean | `false` | `true` is allowed with a warning (§3.11); refused when an enabled site's pack says `headed: 'required'` |
| `stealth` | `off` \| `standard` \| `max` | server `stealth` | frozen like the identity |
| `fingerprint` | boolean | derived as for sessions (11 §3) | the display is asserted only when the host is headless (11 §2.6 rule 5) |
| `humanize` | boolean | server `humanize` | default for the template's virtual sessions; an agent may override per session (§5.3); collapses to `false` when `stealth` is `off` |
| `proxy` | `TemplateProxy \| null` | `null` | §2.2 |
| `policy` | `TemplatePolicy` | §6 | access rule, cap, unsealing, health, recycling |
| `agent_windows` | `normal` \| `minimized` | `normal` | window state of virtual sessions' windows on a headed host (§3.3) |
| `current_version` | integer ≥ 1 \| null | `null` | the newest version |
| `version` | integer ≥ 1 | 1 | optimistic-concurrency row version (`If-Match`, 409 `CONFLICT`, D-14) |
| `created_at`, `updated_at`, `last_used_at`, `disabled_at` | epoch ms | | `last_used_at` = the last virtual-session launch |

### 2.2 Pinned identity and network (frozen at creation)

A template is one person on one device. Everything a site can use to tell that device apart is resolved once, when the template is created, and never re-derived:

| Field | Source at creation | Afterwards |
|---|---|---|
| `seed` | 21 random characters (`nanoid`) | fixed for life; feeds `deriveFingerprint` (11 §2.4) exactly as a restored profile's seed does today (`packages/core/src/infra/browsers/identity-resolver.ts:96`) |
| `chrome_major`, `user_agent`, `ua_ch` (`brands`, `full_version_list`, `platform`, `platform_version`, `architecture`, `bitness`) | read from the first host launch (`Browser.getVersion`, 11 §2.3) | recorded, never faked (D-26). When a later host launch reports a different major, the template records an **identity drift** (`template.changed` with `identity_drift: {from, to}`, a dashboard banner, a `doctor` warning); launches continue |
| `screen` (`width`, `height`, `device_scale_factor`) and `window` (`width`, `height`) | headless: the fingerprint display; headed: the real screen read from the first host window (`Browser.getWindowBounds` of the sentinel and `screen.*` through the identity probe page), window = the recording window's size clamped to the screen | the window size is used for every virtual session's window (§3.3); the screen is asserted only when headless |
| `locale`, `languages`, `timezone_id`, `country_code` | the host geo seed (11 §2.5), or the operator's explicit values; **required explicitly** when a proxy is set (the wizard pre-fills the host's values and says why) | passed to the host as caller-supplied context options, so 11 §2.6 rule 1 applies (caller truth honoured, no `BYO_PROXY_UNSEEDED`); never re-resolved from a host that moved |
| `geolocation` | the operator's explicit coordinates only (BrowserHive never invents coordinates, 11 §2.5) | omitted when not given |
| `proxy` | `{server, bypass?, username?, password_env?, label}` | `server` is `scheme://host:port` without credentials (a URL with `user:pass@` is refused, 400 `VALIDATION_FAILED`); the password is the **name** of an environment variable (D-33), resolved at each host start; the loopback/RFC 1918 bypass is forced as for sessions (11 §11). A host start first opens a TCP connection to the proxy's host and port (3 s timeout); on failure the host does not start and launches answer `TEMPLATE_DISABLED` with `reason: 'proxy_unreachable'`. BrowserHive never falls back to the host's IP |

Changing the proxy or channel is allowed (`PATCH`, with `confirm_identity_change: true`) and restarts the host; the editor warns that sites may sign the account out. The seed, locale, timezone and screen cannot be changed; a different identity is a different template.

### 2.3 Sites

`TemplateSite`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `site_id` | registrable domain | required | `getDomain(host)`; a host on a public suffix only is refused |
| `pack_id` | registrable domain \| null | the pack whose `domains` include `site_id`, if any (§9.6) | `null` = no pack: a generic site (cookie-presence probe only, §8.1) |
| `pack_version` | integer \| null | the approved version at the time | updated when the operator approves an update (§10.6) |
| `enabled` | boolean | `true` | a disabled site keeps its sign-in but is not probed, guarded or offered in `list_templates` |
| `write_policy` | `allow` \| `warn` \| `confirm` \| null | `null` = the pack's default | §9.3 |
| `vault_handle` | string \| null | `null` | a vault binding linked for auto-relogin (§8.4); a binding with `dashboard_confirm` may be linked (the confirmation is asked on the maintenance session) |
| `auto_relogin` | boolean | `false` | requires `vault_handle`; refused for a site whose pack says `human_only: true` |
| `form` | `{username, password, submit?, next?}` CSS selectors \| null | the pack's `sign_in.form` | used only by auto-relogin |
| `health` | `{state, checked_at, changed_at, reason, consecutive_inconclusive}` | `state: 'unknown'` | §8 |
| `device_bound` | boolean | `false` | set by the `device-bound-session` strategy (§9.4) |

Sites that share one login (`shares_login_with`, §9.2) are grouped by identity provider in health and notifications: a Glassdoor sign-out on a job-hunt template reads "Indeed login (covers Indeed, Glassdoor)".

### 2.4 Storage layout and encryption at rest

```
<data-dir>/
  templates/<template_id>/            0700
    userdata/                         the host's live Chromium profile; only the host opens it (§3.9)
    versions/v<N>.state.enc           encrypted Playwright storage state (cookies, localStorage, IndexedDB), 0600
    versions/v<N>.meta.json           {version, created_at, reason, size_bytes, sha256, key_id, summary}, 0600
    downloads/                        the host's browser-level downloads directory (§5.5)
  admin/template.key                  32 random bytes, base64, 0600 (absent when templateKey is set)
  site-packs/                         0700 (§9, §10)
    cache/                            verified registry files, content-addressed
    local/                            operator packs (default sitePacksDir)
```

`summary` holds, per registrable domain, the cookie count, the names of the pack's sign-in cookies that are present, the earliest expiry and whether a session cookie exists; never a cookie value (D-20).

**Encryption.** Every version file is AES-256-GCM, written as one binary envelope: magic `BHTE` (4 bytes), format `1` (1 byte), `key_id` (8 bytes: the first 8 bytes of SHA-256 of the key), nonce (12 random bytes), ciphertext, tag (16 bytes); the additional authenticated data is `<template_id>:<version>`, so a file cannot be swapped between templates or versions. The key is resolved once per process:

1. `templateKey` (08 §5.9; secret; typically `BROWSERHIVE_TEMPLATE_KEY` or an `{env:…}` reference): base64 of exactly 32 bytes, else `CONFIG_INVALID` at boot;
2. otherwise `<data-dir>/admin/template.key`, created with mode 0600 when the first template is created.

A version whose `key_id` does not match the resolved key cannot be read: rollback to it answers `TEMPLATE_DISABLED` with `reason: 'key_unavailable'`, the version list marks it "unreadable with the current key", and a `TEMPLATE_KEY_MISMATCH` degradation (10 §3) names the template. The live profile is unaffected.

**Honest scope (stated in `docs/guide/security.md` and the wizard).** Encryption protects copies of version files (backups, synced folders, a stolen disk image of `versions/`) when the key is not copied with them. It does **not** protect the live profile in `userdata/` (Chromium under Playwright encrypts cookies with a published constant key, so the profile is effectively plaintext and its protection is the 0700/0600 modes), a host where an attacker can read the data directory (the default key file lives next to it; `templateKey` from the environment keeps the key out of the data directory), or a running process. Saved auth states (`auth-states/`) stay unencrypted in this program (§16).

### 2.5 Database (migration `0008-templates`, schema v8, PR T1)

`compatible: true`: purely additive, so `meta.min_reader_version` is not raised and an older binary can still open the database (D-04). `sessions.persistence_mode` keeps its frozen CHECK (`memory`, `persistent`, `storage-state`); a virtual session is recorded as `memory` (§5.5), so no table rebuild and no new enum value is needed (D-12).

```sql
-- v8 (0008-templates): session templates (spec 13, D-49)
CREATE TABLE templates (
  template_id TEXT PRIMARY KEY,                                  -- tp-<nanoid10>
  name TEXT NOT NULL UNIQUE,                                     -- ^[a-z][a-z0-9-]{1,31}$
  display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('recording','ready','disabled')),
  owner TEXT NOT NULL, tenant_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('chromium','chrome','edge')),
  headless INTEGER NOT NULL DEFAULT 0 CHECK (headless IN (0,1)),
  stealth TEXT NOT NULL CHECK (stealth IN ('off','standard','max')),
  fingerprint INTEGER NOT NULL CHECK (fingerprint IN (0,1)),
  humanize INTEGER NOT NULL CHECK (humanize IN (0,1)),
  identity_json TEXT NOT NULL,                                   -- PinnedIdentity (§2.2); no secret
  proxy_json TEXT,                                               -- {server, bypass, username, password_env, label}; env NAME only (D-33)
  agent_windows TEXT NOT NULL DEFAULT 'normal' CHECK (agent_windows IN ('normal','minimized')),
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',         -- [] = any principal (§6.1)
  harnesses_json TEXT,                                           -- NULL = all harnesses, '[]' = none (D-48 semantics, D-52)
  max_concurrent INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent BETWEEN 1 AND 20),
  unseal_json TEXT NOT NULL DEFAULT '{}',                        -- {cookie_values, evaluate, cookie_writes, state_export} booleans (§5.4)
  health_interval_ms INTEGER NOT NULL CHECK (health_interval_ms BETWEEN 1800000 AND 604800000),
  prelaunch_check INTEGER NOT NULL DEFAULT 1 CHECK (prelaunch_check IN (0,1)),
  current_version INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, disabled_at INTEGER
) WITHOUT ROWID;
CREATE TABLE template_sites (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,                                         -- registrable domain
  pack_id TEXT, pack_version INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  write_policy TEXT CHECK (write_policy IN ('allow','warn','confirm')),   -- NULL = the pack's default
  vault_handle TEXT, auto_relogin INTEGER NOT NULL DEFAULT 0 CHECK (auto_relogin IN (0,1)),
  form_json TEXT,
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('unknown','signed_in','signed_out','challenged','inconclusive')),
  health_reason TEXT, health_checked_at INTEGER, health_changed_at INTEGER,
  consecutive_inconclusive INTEGER NOT NULL DEFAULT 0,
  device_bound INTEGER NOT NULL DEFAULT 0 CHECK (device_bound IN (0,1)),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, site_id)
) WITHOUT ROWID;
CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('recording','checkpoint','relogin','shutdown','restore')),
  restored_from INTEGER,                                         -- set when reason = 'restore'
  size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, key_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,                                    -- per-domain counts and cookie NAMES only (D-20)
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),     -- exempt from templateVersionsKeep
  created_by TEXT,                                               -- principal, or 'browserhive' for automatic checkpoints
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
) WITHOUT ROWID;
CREATE TABLE template_probes (                                   -- telemetry class (§11.10): one row per probe
  seq INTEGER PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('signed_in','signed_out','challenged','inconclusive')),
  reason TEXT NOT NULL,                                          -- §8.1 reason codes
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','prelaunch','recording','relogin','manual','host_start','attention')),
  final_url TEXT,                                                -- sanitized (query and fragment stripped, D-20)
  duration_ms INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX idx_template_probes_template ON template_probes(template_id, site_id, at);
CREATE INDEX idx_template_probes_at ON template_probes(at);
-- the session's template, written once at launch; NULL for exclusive sessions and for every session created before v8
ALTER TABLE sessions ADD COLUMN template_id TEXT REFERENCES templates(template_id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN template_name TEXT;             -- the name at launch (history survives a rename or delete)
ALTER TABLE sessions ADD COLUMN template_version INTEGER;       -- current_version at launch
ALTER TABLE sessions ADD COLUMN template_mode TEXT;             -- open set, no CHECK: 'live' (agent) | 'maintenance'; 'serial' reserved (§16)
ALTER TABLE sessions ADD COLUMN sealed INTEGER CHECK (sealed IN (0,1));
CREATE INDEX idx_sessions_template ON sessions(template_id, created_at) WHERE template_id IS NOT NULL;
```

`MIGRATIONS` gains the entry after `vaultHarnesses` (`packages/core/src/infra/persistence/migrations/index.ts:14-22`), `TABLES` gains `template_probes`, `template_versions`, `template_sites` and `templates` before `sessions` (children first). The fixture `v8.db`, the golden `schema-v8.json` and regenerated `db.d.ts` ship with it (09 §3.2). Migration `0009-site-packs` (PR T3) is in §9.9.

### 2.6 Ports

```ts
interface TemplateRepository {
  list(query): Promise<Page<TemplateRow>>; get(id); getByName(name);
  insert(row); update(id, patch, ifVersion?): Promise<TemplateRow>;   // CONFLICT on a stale version
  remove(id); touchLastUsed(id, at);
}
interface TemplateSiteRepository { list(templateId); upsert(row); remove(templateId, siteId); setHealth(templateId, siteId, health); }
interface TemplateVersionRepository { list(templateId, query); get(templateId, version); insert(row); setPinned(templateId, version, pinned); prunable(templateId, keep): Promise<number[]>; remove(templateId, version); }
interface TemplateProbeRepository { insert(row); list(templateId, query); prune(before): number; }
interface TemplateKeyProvider { resolve(): Promise<{ key: CryptoKey; keyId: string }>; }   // §2.4
interface TemplateStateStore {   // the files under templates/<id>/versions, encryption included
  write(templateId, version, state: StorageState): Promise<{ sizeBytes; sha256; keyId }>;
  read(templateId, version): Promise<StorageState>;           // TEMPLATE_DISABLED key_unavailable on a key mismatch
  remove(templateId, version): Promise<void>;
}
```

---

## 3. Live mode

### 3.1 The host

A host is launched with `launchPersistentContext(<data-dir>/templates/<id>/userdata, options)` (the same call persistent sessions use, `packages/core/src/infra/browsers/playwright-browser-driver.ts:221`) where `options` are built from the template only:

- `channel`, `headless`, the stealth flags and `ignoreDefaultArgs` of 11 §2.2;
- the pinned identity's context options (locale, timezone, languages, geolocation when given; viewport `null` when headed, the fingerprint display when headless and `fingerprint` is on);
- the pinned proxy (§2.2);
- `downloadsPath: <data-dir>/templates/<id>/downloads`;
- no tracing (§5.4);
- the required flags of §3.10.

The persistent context's first page becomes the **sentinel**: it stays on `about:blank`, is never attributed (§3.4) and, on a headed host, its window is minimized (`Browser.setWindowBounds {windowState: 'minimized'}`) once the host is running. Identity (11 §2.3) is applied per page exactly as for sessions; the UA-CH probe page of the applier (`packages/core/src/infra/browsers/identity-applier.ts:183`) runs **once per host start**, opened as a parked page, never per virtual session.

### 3.2 Host lifecycle and supervisor

`TemplateHostSupervisor` (`app/templates/host-supervisor.ts`) owns every host, keyed by `template_id`; it is the only code path that launches or closes a host.

| State | Meaning | Launches |
|---|---|---|
| `stopped` | no browser | start the host, then proceed |
| `starting` | launching (deadline 60 s) | wait for it, up to the launch deadline |
| `running` | browser up, sentinel open | admitted (§6.3) |
| `draining` | recycle or operator restart in progress | `TEMPLATE_UNAVAILABLE` `reason: 'restarting'` with `retry_after_ms` |
| `crashed` | browser exited unexpectedly; restart scheduled | `TEMPLATE_UNAVAILABLE` `reason: 'crashed'` |
| `failed` | 5 consecutive failed starts within 30 min, no display, unreachable proxy or unreadable key | `TEMPLATE_DISABLED` with the reason; an operator restart (dashboard, CLI) clears it |

- **Start** is lazy: on the first launch, recording, re-login, probe or keep-alive. Hosts are never started at boot. The start needs a free browser slot (§6.3); without one the launch answers `SESSION_LIMIT_REACHED`.
- **Restart after a crash** uses backoff 5 s, 15 s, 45 s, 135 s, 405 s; the fifth consecutive failure within 30 min sets `failed`, records the `TEMPLATE_HOST_FAILED` degradation and produces the `template.host_failed` notification (§8.6).
- **Idle stop.** A host with no agent virtual session, no recording or re-login session (its `maintenance` session does not count) and no parked page other than the sentinel for `templateHostIdleTimeout` (default `1h`; `0` = never) is stopped cleanly: final checkpoint (§3.9), then `context.close()`.
- **Recycle.** A host is drained and reopened when it is older than `templateRecycleAfter` (default `24h`), when the resident memory of its process tree exceeds `templateRecycleRss` (default `3GiB`, sampled every 60 s with the browser-memory sampler of 10 §7), after a proxy or channel change, or on an operator restart. Draining refuses new launches, lets virtual sessions finish, and force-closes those still open after `templateDrainTimeout` (default `15m`) with `closed_reason: 'operator'` for an operator restart and `'shutdown'` otherwise. A user-data-dir cannot be opened twice (Chromium's `SingletonLock`), so the new generation starts only after the old one has closed; there is no overlap.
- **Daemon shutdown** drains every host within the sessions budget of 01 §6 (virtual sessions close with `shutdown`), writes a final checkpoint per host when the budget allows (reason `shutdown`), then closes the hosts. At the next start, `reconcileOnStartup` marks virtual sessions that were open `interrupted` like any other (`packages/core/src/app/maintenance/startup-reconcile.ts:10`).

### 3.3 Virtual sessions: windows

A virtual session owns one or more windows of its host. Its first window is created with:

```ts
const cdp = await browser.newBrowserCDPSession();                 // browser = context.browser(), as session-handle.ts:165-168 does
const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId: sentinelTargetId });
const { targetId } = await cdp.send('Target.createTarget', {
  url: 'about:blank', newWindow: true, browserContextId: targetInfo.browserContextId,
  width: identity.window.width, height: identity.window.height,
});
```

Playwright adopts the new target into `context.pages()` and fires `context.on('page')`; the attribution dispatcher (§3.4) claims it by `targetId` within the adoption deadline (10 s; on timeout the target is closed and the launch fails with `TEMPLATE_UNAVAILABLE` `reason: 'starting'`). The window id (`Browser.getWindowForTarget`) is recorded in the session's window set. With `agent_windows: 'minimized'` the window is minimized after creation; focus emulation keeps its pages visible to scripts (§3.10).

**`new_tab`** opens a tab in the session's window: BrowserHive runs `window.open('about:blank', '_blank', 'noopener')` in an **isolated world** of the session's active page (`Page.createIsolatedWorld`, then `Runtime.evaluate` with `userGesture: true`), so the page's own scripts cannot observe or intercept the call and the new tab has no `window.opener`. The popup lands in the opener's window as a tab. When the active page cannot run it (no page left in the window, a `chrome-error://` or PDF page, an evaluation failure), `new_tab` creates another window for the session with `Target.createTarget {newWindow: true}`; a session may own several windows. `context.newPage()` is never called on a host (it would put the tab in whichever window was activated last, possibly another session's).

**`switch_tab`** additionally calls `page.bringToFront()` on a virtual session's page, so the active tab is the front tab of its window (a background tab's `requestAnimationFrame` runs at about 15 fps instead of 60–100). Exclusive sessions keep today's registry-only switch (`packages/core/src/app/sessions/session-tabs.ts:65-69`).

**Viewport.** `set_viewport` and `context_options.viewport` act per page (`page.setViewportSize`); on a headed host they also resize the session's window (`Browser.setWindowBounds`) so the page is not letterboxed.

### 3.4 Page attribution

One dispatcher per host subscribes to `context.on('page')` and decides, for every new page, **before** any session's `TabRegistry` sees it:

1. **Claim.** The page's target id (`Target.getTargetInfo` on its own CDP session) matches a pending claim from §3.3 → the claiming session.
2. **Opener.** `page.opener()` (Playwright sets it for `noopener` popups too) is a page owned by session S → S.
3. **Window.** `Browser.getWindowForTarget` returns a window in session S's window set → S.
4. **Hold.** A page that matches nothing while a `createTarget` of this host is still awaiting its response is held for at most 2 000 ms and re-evaluated when the response arrives.
5. **Park.** Anything else is parked: the sentinel, the identity probe page, windows the operator opened by hand in a headed host, and windows a service worker opened (`clients.openWindow`). Parked pages are listed on the template page (§11.4) with a Close action and never closed automatically.

**Invariant (the isolation boundary of live mode, D-50).** For every host at every instant: each page is attributed to at most one session; an attribution never changes; a page enters a session's `TabRegistry` only after it is attributed to that session; a parked page is in no `TabRegistry`; a page opened by a page of session S, or created in a window of S, belongs to S. The site-opened-page subscription that today adds every page of the context to the one session (`packages/core/src/app/sessions/create-phases.ts:250-254`) becomes a subscription to the session's own `SessionView.onPage`. Property tests (§17, T0) guard the invariant.

### 3.5 Close semantics

`close_session`, a lease expiry, an operator terminate and a drain close a virtual session the same way: mark it `draining`; close every page it owns with `page.close({runBeforeUnload: false})` (5 s per page, within `sessionCloseTimeout`), which closes its windows; drop its window set, claims and per-page routes and headers; call `pageActions.forgetSession` as for every session (`packages/core/src/interface/mcp/tools/lifecycle/index.ts:56`); move or delete its downloads (§5.5); remove its session directory (it has no `userdata`). The host, its context and the other sessions are never touched: `context.close()` and `browser.close()` are host operations only (`packages/core/src/infra/browsers/session-handle.ts:141` today). A session whose last tab closes stays open with zero tabs, as today; its next `new_tab` creates a window.

### 3.6 Crashes

| Failure | Effect |
|---|---|
| A renderer crashes (`page.on('crash')`) | only the pages of that process (the tab and its scripted popups); the session stays live; its tools on the dead tab answer `TAB_NOT_FOUND` once the page closes |
| The host browser exits or its context closes (`browser.on('disconnected')`, `context.on('close')`, today `session-handle.ts:71-72`) | **fan-out**: every virtual and maintenance session of the host is marked `crashed` and reaped at once (tools answer `SESSION_DEAD`); the supervisor schedules a restart (§3.2) |
| GPU or network service restarts | Chrome restarts them; pages may see failed requests; nothing is fanned out |

### 3.7 Creation pipeline for a virtual session

The D-21 phase names, spans and compensators are kept; `runCreatePipeline` takes the template branch when `request.template` is set:

| Phase | Exclusive session (today) | Virtual session |
|---|---|---|
| `validate` | `validateCreateRequest` (`packages/core/src/domain/session/create-request.ts:173`) | plus: resolve the template by name, check access (§6.1), apply the option rules (§5.3) |
| `admit` | `CapAdmissionPolicy` (`packages/core/src/domain/session/admission.ts:46`) | template admission (§6.3): template status and host state, cap, pack concurrency and strategies, health (§8.2) |
| `reserve` | registry insert under the lock | the same; the session row carries `template_id`, `template_name`, `template_version`, `template_mode: 'live'`, `sealed` |
| `prepareProfile` | session directory, restores | session directory without `userdata`; **acquire the host** (start it when `stopped`) |
| `resolveIdentity` | geo seed and fingerprint | the host's identity (nothing resolved) |
| `launch` | `driver.launch` | open the first window (§3.3); compensator closes it |
| `installPolicies` | blocklist route on the context | register the session with the host's interception chain (§3.8); per-page extra headers |
| `startTracing` | confirm the trace | none (§5.4) |
| `applyIdentity` | `ensureIdentityForPage(handle.page)` | the same, on the session's first page |
| `register` | first page + context page subscription | first page + `SessionView.onPage` (§3.4) |

### 3.8 Interception on a host

A host installs one `context.route('**/*')` chain (`InterceptionChain`, 01 §9) for all its sessions: the blocklist handler (11 §5) first, the request guard (§9.3, PR T0) second. Each handler resolves the **owner of every request** instead of a fixed `sessionId` (today `packages/core/src/infra/browsers/blocklist-route.ts:82`): `request.frame().page()` through the attribution map; a request without a page (service worker, `frame()` throws) or from a parked page is owned by the host and gets the template's rules. Blocking decisions fail closed for document requests, as the blocklist does today (`blocklist-route.ts:89-93`); detection (challenges, §9.5) fails open. Audit rows carry the owning session, or `session_id NULL` with the template in their details for host-owned requests (`blocked_requests.session_id` is nullable).

### 3.9 Single writer, checkpoints and versions

- The host is the only writer of the template: nothing else opens `userdata/`, and no version is restored while a session is attached (§3.12).
- **Checkpoint**: `context.storageState({indexedDB: true})` of the host, every `templateCheckpointInterval` (default `15m`) while the host runs, at a clean host stop, after a recording finishes and after a re-login succeeds. A checkpoint becomes version `current_version + 1` only when its content hash (SHA-256 over the canonical JSON) differs from the current version's; otherwise nothing is written.
- **Retention.** The newest `templateVersionsKeep` (default 10) versions and every pinned version are kept; older ones are deleted with their files.
- Storage state excludes sessionStorage, service workers, the Cache API, the HTTP cache, permissions and saved passwords (Playwright `storageState`); the live profile keeps all of them. A restore therefore brings back sign-ins, not the whole profile (§3.12).

### 3.10 Required launch flags and focus emulation

Hosts and virtual sessions rely on three of Playwright's default switches and on its focus emulation (03-mechanics measurements, Playwright and Patchright 1.63):

- `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` MUST stay on the host's command line. Template creation refuses `ignoreDefaultArgs: true` and any `ignoreDefaultArgs` array naming one of them (400 `VALIDATION_FAILED`); there is no other path to template launch options.
- `Emulation.setFocusEmulationEnabled` (sent by Playwright on every page) keeps every agent page `visibilityState: 'visible'` and `hasFocus() === true`, so timers, screenshots and the live view's screencast work in background tabs and minimized windows. No BrowserHive CDP session may disable it; a future raw-CDP attach MUST enable it itself.
- Patchright drops `--disable-popup-blocking`; `new_tab` therefore evaluates with `userGesture: true` (§3.3).

### 3.11 Headed hosts and displays

Hosts are headed by default (D-50): a human signs in in them (Google refuses sign-in from automation-controlled browsers) and several sites challenge headless browsers. A template may be set headless; the editor warns that sites may challenge it more often, and it is refused while an enabled site's pack says `headed: 'required'`.

A headed host needs a display on the machine running BrowserHive:

| Platform | Requirement | When missing |
|---|---|---|
| Linux | `DISPLAY` or `WAYLAND_DISPLAY` (a desktop session, or Xvfb on a server: `xvfb-run browserhive …` or an `Xvfb :99` sidecar with `DISPLAY=:99`) | host start fails: `TEMPLATE_DISABLED` `reason: 'no_display'` |
| macOS | a logged-in user session (a LaunchAgent, not a LaunchDaemon) | the same |
| Windows | an interactive session (not a service in Session 0) | the same |

`Desktop.hasDesktopEnvironment()` (`packages/core/src/ports/desktop.ts:23`) decides; `doctor` reports it (§11.9). On a Wayland desktop window activation is compositor-controlled, so BrowserHive never relies on window order.

### 3.12 Restore (rollback)

`POST /templates/{id}/versions/{version}/restore` drains the host (§3.2), starts it, calls `context.setStorageState(<decrypted version>)` (Playwright clears cookies, localStorage, IndexedDB and OPFS and sets the state), writes a new version with `reason: 'restore'` and `restored_from`, and probes every site. Agents get `TEMPLATE_UNAVAILABLE` `reason: 'restarting'` meanwhile. Restoring never edits an old version.

### 3.13 The driver port: `BrowserHost` and `SessionView` (PR T0)

`SessionHandle` (`packages/core/src/ports/browser-driver.ts:185-216`) is split in two. Tools, live view and the vault stop reaching into `handle.context`; they ask the view.

```ts
/** One running browser and its context. Exclusive sessions get one each; a template host is shared. */
interface BrowserHost {
  readonly hostId: string;                         // the session id (exclusive) or the template id (template host)
  readonly kind: 'exclusive' | 'template';
  readonly browser: Browser | null;
  readonly context: BrowserContext;                // used by infra only (interception chain, identity applier, CDP bridge)
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly browserInfo?: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: TracingHandle | null;          // always null for a template host (§5.4)
  ensureIdentityForPage(page: Page): Promise<void>;
  onCrash(listener: (reason: string) => void): () => void;
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;
  browserPid?(): Promise<number | null>;
}

/** What one session may touch: its own pages only. */
interface SessionView {
  readonly sessionId: string;
  readonly host: BrowserHost;
  readonly page: Page;                             // the first page
  pages(): readonly Page[];
  owns(page: Page): boolean;
  onPage(listener: (page: Page) => void): () => void;      // pages attributed to this session after it opened
  newPage(): Promise<Page>;                        // exclusive: context.newPage(); virtual: §3.3
  cookies(urls?: readonly string[]): Promise<Cookie[]>;
  addCookies(cookies: readonly CookieInput[]): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;   // exclusive: context-wide; virtual: per page, replayed on new pages
  storageStateSource(): StorageStateSource | null;                       // null for virtual sessions
  userDataDir(): string | null;                                          // null for virtual sessions
  onCrash(listener: (reason: string) => void): () => void;              // host crash fan-out plus its own
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;  // exclusive: closes the host; virtual: §3.5
}

interface BrowserDriver {
  stealthDriverName(): 'patchright' | 'playwright';
  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<SessionView>;            // an exclusive host and its one view
  launchTemplateHost(spec: TemplateHostSpec, signal?: AbortSignal): Promise<TemplateHost>;   // PR T1
}
interface TemplateHost extends BrowserHost { openView(sessionId: string, opts: { windowState: 'normal' | 'minimized' }): Promise<SessionView>; parkedPages(): readonly Page[]; }
```

The port's isolation sentence becomes: "An exclusive host MUST NOT be shared between sessions; a template host is shared only by the virtual sessions of its template, and its views MUST satisfy the attribution invariant of spec 13 §3.4." The reach-ins that move behind the view: `contextOf` in the state tools (`packages/core/src/interface/mcp/tools/state/index.ts:15`, `:36`, `:51`, `:100`), the storage-state source of `save_storage_state` (`packages/core/src/interface/mcp/tools/auth-states/index.ts:23`), `newTab` (`session-tabs.ts:41`), the page subscription (`create-phases.ts:252`), close (`session-close.ts:92-107`), the CDP bridge's `newCDPSession` (`packages/core/src/interface/ws/cdp-bridge.ts:127`, which keeps using the host context) and the vault's tracing handle (`packages/core/src/interface/mcp/tools/vault/index.ts:97`).

## 4. Settings shared by the whole browser

A context-level setting is the template's, never a session's. The table fixes, for every setting a session could ask for, whether a virtual session can have its own value.

| Setting | Scope in a host | Per virtual session | How |
|---|---|---|---|
| User agent, UA-CH, `Accept-Language` | host (one identity) | no | the pinned identity (§2.2); the per-page CDP override is replayed on every attributed page (11 §2.3) |
| Locale, timezone, geolocation, permissions | host | no | context options from the pinned identity |
| Proxy, egress IP | host | no | the pinned proxy |
| Cookies, localStorage, IndexedDB, Cache API, service workers, SharedWorkers, BroadcastChannel, Web Locks | host (shared) | no | shared by design: one person, one jar |
| `sessionStorage` | page | yes | per tab, copied into a `window.open` popup |
| Request routing (`context.route`) | host | no | one interception chain, per-request owner resolution (§3.8) |
| Extra HTTP headers | page | yes | `page.setExtraHTTPHeaders` on the session's pages, replayed on new ones |
| Viewport | page | yes | `page.setViewportSize`, plus window bounds on a headed host (§3.3) |
| Color scheme | page | yes | `page.emulateMedia({colorScheme})` |
| Clock, offline emulation, HTTP credentials, `recordVideo`, `bypassCSP`, `javaScriptEnabled`, `serviceWorkers`, `ignoreHTTPSErrors`, `isMobile`, `hasTouch`, `deviceScaleFactor` | host | no | Playwright's defaults for hosts; never set |
| Tracing | host | no | off for virtual sessions in v1 (§5.4) |
| Downloads directory | host | no | the host's `downloads/`, claimed per page (§5.5) |
| Humanize state, evaluate permission, vault permission | session | yes | per session, as today (`packages/core/src/infra/browsers/page-actions.ts:51-61`) |

---

## 5. Agent surface

### 5.1 `list_templates` (new tool, pack `templates`, PR T1)

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `list_templates` | *(none; registered without a schema, like `list_sessions`, 02 §3.1)* | `{ templates: [{ name, display_name, description, sites: [{ site, title, status: 'signed_in'\|'signed_out'\|'challenged'\|'inconclusive'\|'unknown', checked_at: number\|null }], mode: 'live', in_use: number, cap: number, availability: 'available'\|'busy'\|'needs_login'\|'unavailable', sealed: boolean }] }` sorted by `name` | `TOOL_NOT_AVAILABLE` (when `templates=false`) | yes/no/yes/no |

- **Only templates the caller may launch are listed** (§6.1); a template the caller may not use is absent, never marked. `site` is the registrable domain; `title` the pack's title or the domain; disabled sites are omitted.
- `in_use` counts the template's live virtual sessions of every principal (maintenance sessions excluded); `cap` is the effective cap (§6.3).
- `availability`: `available` (a launch would be admitted now; a stopped host counts as available, it starts on launch); `busy` (`in_use ≥ cap`, or a strategy defers launches, §9.4); `needs_login` (every enabled site is `signed_out` or `challenged`); `unavailable` (the template is not `ready`, or its host is `draining`, `crashed` or `failed`).
- Pack `templates`, capability `read`, `since` = the release that ships T1. Registration order: appended after `vault_fill` (02 §3.14), so the existing 43 keep their positions.
- Description: "List the session templates you may use: signed-in browsers prepared by the operator. Pass a template's name to launch_session as `template` to open a session that is already signed in to its sites. Sessions of one template share cookies and sign-ins: do not sign out, and do not change account settings."

### 5.2 `launch_session.template` (new optional parameter, PR T1)

`template?: string` (`^[a-z][a-z0-9-]{1,31}$`): the template's `name`. Described as: "Name of a session template from list_templates. The session opens as a new window in that template's signed-in browser and shares its cookies and sign-ins with the template's other sessions." `slug` stays required and names the session as usual (`<slug>-<nanoid8>`).

`SessionMetadata` (the result of `launch_session`, `list_sessions`) and `session_info` gain one additive key for template sessions only: `template: { name, sites: [{ site, status }] }` (D-12: a new result key). Exclusive sessions do not carry it.

### 5.3 Launch options on a template

The schema bakes defaults into five parameters (`channel`, `incognito`, `headless`, `disable_evaluate`, `vault_enabled`; `packages/contracts/src/tools/lifecycle.ts:46-54`), so the server cannot tell an explicit value from a default for those five. The rules:

| Parameter | Rule on a template launch |
|---|---|
| `channel`, `headless`, `incognito` | **ignored**: the template's values apply (never refused, because they always arrive) |
| `disable_evaluate` | applied as sent; a sealed template forces `true` (§5.4) |
| `vault_enabled` | applied as sent (per session) |
| `humanize` | applied as sent; collapses to `false` when the template's `stealth` is `off`; a `humanize-input` strategy forces it on for its site (§9.4) |
| `stealth`, `fingerprint` | refused when present and different from the template's |
| `persistence_mode` | `memory` accepted (it is what the session reports); `persistent` or `storage-state` refused |
| `restore_profile` | refused when present |
| `launch_options` | refused when it has any key whose value differs from the host's effective launch option of that name (`{}` is accepted) |
| `context_options` | `viewport`, `extraHTTPHeaders` and `colorScheme` are applied per session (§4); any other key is refused when its value differs from the host's effective context option (`storageState` is always refused) |

A refusal is `INVALID_ARGUMENTS` with one issue per offending option, `path` naming it (`context_options.locale`) and the message `template '<name>' fixes <option>; omit it` (02 §2.3 text format). Nothing is refused for an option that equals the template's value, so an agent reveals that a session comes from a template only when it explicitly asks for something the template cannot give.

### 5.4 Sealing and tracing (D-51)

Template sessions are **sealed** unless the operator unseals the template. Unseal flags (`unseal_json`, each `false` by default):

| Flag | Sealed behaviour (default) | Unsealed |
|---|---|---|
| `cookie_values` | `get_cookies` returns every cookie with `value: ""` (name, domain, path, expiry and flags kept) and the additive result key `sealed: true` | full values, as for exclusive sessions (never persisted, D-20) |
| `evaluate` | `disable_evaluate` is forced `true`: `evaluate` answers `EVALUATE_DISABLED` with `scope: 'session'` (02 §3.6), byte-identical to a session launched with `disable_evaluate: true` | the session's `disable_evaluate` and the server's `allowEvaluate` apply as usual |
| `cookie_writes` | `set_cookies` answers `SESSION_SEALED` | allowed; it changes the jar of every session of the template (the editor says so) |
| `state_export` | `save_storage_state` answers `SESSION_SEALED` | allowed; the snapshot is saved under the caller's own auth-state namespace (02 §6) |

`save_full_profile` always answers `INVALID_PERSISTENCE_CONFIG` in a virtual session, exactly as today for a session that is not `persistent` (`auth-states/index.ts:42`): it has no profile of its own. `set_extra_http_headers` applies to the session's pages only (§4).

**Tracing is off for virtual sessions in v1.** A Playwright tracer is per context: a host trace would record every agent's pages, and the vault's pause/resume around a fill (`packages/core/src/domain/vault/broker.ts:264`, `:305`) would cut every sibling's trace and could let a sibling's keystrokes into a resumed chunk (D-13). `GET /sessions/{id}/trace.zip` answers 404 `TRACE_UNAVAILABLE` with `enabled: false`; the dashboard explains why (§11.4). A per-page trace split is deferred (§16).

### 5.5 Tool-by-tool behaviour in a virtual session

U = unchanged (page-scoped through `TabRegistry`, correct once attribution is, `packages/core/src/interface/mcp/tools/shared.ts:11-13`); S = scoped or changed as stated.

| Tools | | In a virtual session |
|---|---|---|
| `launch_session` | S | §5.2–§5.3; the pipeline of §3.7 |
| `close_session` | S | closes the session's pages and windows only (§3.5) |
| `list_sessions`, `get_attention_result`, `request_attention`, `list_saved_auths`, `vault_list_available` | U | ownership as today; `get_attention_result` also re-attaches to a `security_intercept` request of the caller's session (§9.5) |
| `server_status` | S | `sessions.count` counts virtual sessions; additive `sessions.browsers` (§6.3) |
| `session_info` | S | `config` reports the template's channel, headless, stealth and fingerprint, `persistence_mode: 'memory'`, `incognito: false`; additive `template` (§5.2) |
| `navigate`, `go_back`, `go_forward`, `reload`, `wait_for_url`, `wait_for_selector`, `wait_for_load_state`, `snapshot`, `get_content`, `screenshot`, `accept_next_dialog`, `dismiss_next_dialog`, `upload_file` | U | site-pack guards and strategies apply on in-scope pages (§9.3, §9.4) |
| `click`, `type_text`, `fill`, `press_key`, `hover`, `select_option`, `scroll`, `drag_and_drop` | U | humanize per session; element guards and strategies on in-scope pages |
| `new_tab` | S | a tab in the session's window (§3.3); `TEMPLATE_BUSY` when the host's page cap is reached (§6.3) |
| `close_tab`, `list_tabs` | U | |
| `switch_tab` | S | also `bringToFront()` (§3.3) |
| `set_viewport` | S | per page, plus window bounds when headed |
| `set_extra_http_headers` | S | per page, replayed on the session's new pages |
| `evaluate`, `get_cookies`, `set_cookies`, `save_storage_state` | S | sealing (§5.4) |
| `save_full_profile` | S | `INVALID_PERSISTENCE_CONFIG` (§5.4) |
| `download_file` | S | the download is attributed by `download.page()` and saved into `sessions/<id>/downloads` (`saveAs`); a download no session claims within 60 s is deleted from the host's `downloads/` |
| `vault_fill` | S | gates unchanged (02 §3.13); no trace pause (no trace); a site whose pack says `human_only: true` refuses the fill with `blocked` / `not_authorized` (the audit row records `human_only_site`, §9.3) |
| `list_templates` | new | §5.1 |

`SessionMetadata` for a virtual session (D-12: no new enum value): `persistence_mode: 'memory'` (nothing the session does is saved for it), `incognito: false`, `headless`/`channel`/`stealth`/`fingerprint` = the template's, `disable_evaluate` = the effective value (`true` when sealed), `identity` = the host's applied identity, `proxy_label` = the template proxy's label.

### 5.6 What an agent can still observe

No API change hides these; the agent guide (`docs/guide/templates.md`) states them:

- **Shared state.** Cookies and storage change underneath the session when a sibling acts; `storage` events, BroadcastChannel and SharedWorker messages arrive from sibling windows; service workers are shared.
- **Shared sign-out.** A sibling (or the site) signing the account out signs every session out. Packs guard logout and account pages (§9.3); `list_templates` and the `template` key of `session_info` report site status.
- **Shared fate.** A host crash ends every session of the template with `SESSION_DEAD` (§3.6); a recycle answers new launches with `TEMPLATE_UNAVAILABLE`.
- **Focus.** Every agent page reports `visible` and `hasFocus() === true` at once (focus emulation, §3.10); a site that correlates tabs through shared storage can see several focused tabs of one account. `serialize-site` (§9.4) reduces simultaneous activity on sites that care.
- **Sealing refusals** (`SESSION_SEALED`, `EVALUATE_DISABLED`, empty cookie values) reveal that the session comes from a template; they do not reveal the mechanism.

---

## 6. Policy and access (D-52)

### 6.1 Who may list and launch

- **Operators** create, edit, record, re-login, restore and delete templates (scopes in §6.2). **Agents** only list and launch them; no tool changes a template.
- A template's grant reuses the vault's rule shapes: `authorized_principals` (empty = any principal; matched with `isPrincipalAuthorized`, `packages/core/src/domain/vault/bindings.ts:93`) and an optional `harnesses` list matched with `checkHarnessRules` (`packages/core/src/domain/vault/harness-rule.ts:39`; matcher `packages/contracts/src/harness/index.ts:473-493`), with D-48's semantics unchanged: no list = all harnesses, an empty list = none, known slugs against the launch harness, custom names exactly against the launch declared name. Gate order: template exists and is not `recording` → principal → harness. The harness is the launching call's resolved identity, which becomes the session's launch harness (`sessions.harness`, D-30); for `list_templates` it is the listing call's.
- The harness list is a **narrowing guard, not a security boundary** (D-48): real separation is one API token per agent with `authorized_principals`. The editor shows D-48's one-line note and warnings.
- A refusal is indistinguishable from absence: `launch_session` answers `TEMPLATE_NOT_FOUND` with the same message and details as for an unknown name and `list_templates` leaves the template out (D-09, D-14). The operator sees the real reason in the access tester (`POST /templates/{id}/access/resolve`, §11.1) and in one `info` log line per refused launch (`template launch refused`, with `template_id`, `reason: 'principal_not_allowed'|'harness_not_allowed'|'recording'`), never in anything the agent receives.
- Session ownership is unchanged: a virtual session is owned by the principal that launched it (D-09); the template's owner is a different principal.
- `AuthorizationRule`, `isPrincipalAuthorized`, `checkHarnessRules` and `normalizeHarnessList` move from `domain/vault` to a shared `domain/policies/access-rule.ts` (T1); the vault imports them from there, with no behaviour change.
- New templates default to **any principal, all harnesses**: under `auth=off` every agent is `local` anyway. The wizard shows the choice explicitly ("All agents of this hive").

### 6.2 Scopes

Five scopes join the 19 of 03 §3.5 (`packages/contracts/src/enums/scope.ts:5-25`); operators hold all of them (`OPERATOR_SCOPES`, `packages/core/src/domain/auth/scopes.ts:10`); agents keep `mcp:tools` only.

| Scope | Grants |
|---|---|
| `templates:read` | list and read templates, sites, health, probes, versions, hosts; the `templates` WS topic |
| `templates:write` | create, edit, delete, disable, restore, pin versions, start/stop/restart hosts, close parked pages |
| `templates:login` | start a recording, re-login, open host windows on the BrowserHive machine, link vault bindings for auto-relogin; separate because it drives a signed-in browser and sees the account |
| `sitepacks:read` | read packs, diffs, change history, registry status; the `site-packs` WS topic |
| `sitepacks:write` | approve, reject, pin, enable and disable packs, import packs, run an update check |

### 6.3 Capacity and admission (D-56)

- **Browser slots.** `maxSessions` (D-21) bounds browsers: each exclusive session uses one slot and each **running host** uses one slot, whatever its number of virtual sessions. Admission compares `exclusive sessions + running hosts` with the effective cap (`CapAdmissionPolicy`, `packages/core/src/domain/session/admission.ts:46`); a launch that needs a host start when no slot is free answers `SESSION_LIMIT_REACHED`.
- **Virtual sessions count as sessions** everywhere sessions are counted: `server_status.sessions.count`, `/system.capacity.live`, `browserhive.sessions.active`. `server_status.sessions` gains the additive key `browsers` (exclusive sessions + running hosts), the number `limit` applies to; `count` may therefore exceed `limit`.
- **Template cap.** At most `max_concurrent` (default 5, range 1–20) live virtual sessions per template, maintenance sessions excluded. The effective cap is `min(max_concurrent, min over the enabled sites' pack concurrency.max_sessions)`, further scaled by `ramp-up` (§9.4). At the cap: `TEMPLATE_BUSY` (`retryable: backoff`, `details {template, in_use, cap, limit_kind: 'sessions'}`).
- **Pages per host.** At most `templateMaxPagesPerHost` (default 40, range 2–200) pages per host, sentinel and parked pages included: a launch or `new_tab` beyond it answers `TEMPLATE_BUSY` with `limit_kind: 'pages'`.
- **Admission order** for a virtual session, each step failing typed: access (§6.1; an unknown, unauthorized or still-`recording` template is `TEMPLATE_NOT_FOUND`) → template not `disabled` (else `TEMPLATE_DISABLED`) → host not `draining`/`crashed` (`TEMPLATE_UNAVAILABLE`) and not `failed` (`TEMPLATE_DISABLED`) → template cap and pages cap → strategies' `admit` hooks (`launch-spacing`, `active-hours`, §9.4) → health (§8.2) → browser slot when the host must start.
- Memory planning (measured, headless, Wikipedia pages): one extra page in a shared browser costs about 80–100 MB PSS against about 210–230 MB for an extra browser; 10 sessions in one browser about 1.3 GB against 2.3 GB as 10 browsers. The 1.5 GiB-per-slot budget of D-21 therefore covers a host with its default cap.

---

## 7. Recording workflow

Recording is how an operator creates a template's sign-ins: a real, headed window on **the machine running BrowserHive**, driven by hand with full input fidelity (paste, password managers, IME, OAuth popups, passkeys on that machine). Recording through the dashboard's live view is deferred (§16), because live-view input lacks clipboard, IME and tab switching (04 §16).

### 7.1 Dashboard

`/templates/new` is a five-step wizard (§11.4):

1. **Name**: name (with the agent-facing grammar), display name, description.
2. **Sites**: search the site catalog (every pack, `GET /site-packs`) or add any domain. Each chosen site shows the pack's title, its terms clause and write policy (§9.3), "a human must sign in" for `human_only` sites, `shares_login_with` groupings ("Glassdoor uses the Indeed login") and its requirements (Chrome, headed, proxy recommended).
3. **Identity and network**: channel (Chrome pre-selected when a pack asks for it and Chrome is installed), stealth level, fingerprint, headless (warned), proxy (server, username, password **environment variable name**), locale and timezone (pre-filled from the host; required with a proxy).
4. **Access**: who may use it (principals, harnesses with D-48's picker), concurrency cap, sealing (all sealed by default; "Allow evaluate" and the other unseal flags as checkboxes, each with its consequence).
5. **Sign in**: "Open browser on <host name>" starts the host headed and opens one window with one tab per site at its pack's sign-in URL (a generic site opens `https://<site>/`). The operator signs in. Every 5 s BrowserHive checks each site's sign-in cookies by name (no navigation); when a site's cookies appear it runs that site's probe (§8.1) and shows a tick per site: "Signed in", "Signed out", "Check needed" (challenged, with the reason), "Couldn't tell" (inconclusive). **Finish** runs every probe once more, writes version 1 (`reason: 'recording'`) and sets the template `ready`. A site that is not signed in at Finish is kept, marked signed out, and offered for re-login.

The recording window belongs to a maintenance session owned by the operator; closing the browser window by hand cancels nothing (the host keeps the sentinel), and "Cancel" closes the maintenance session and leaves the template in `recording`. Without a display (§3.11) step 5 says so and shows the CLI command to run on the BrowserHive machine (§7.2), with the Xvfb hint for servers.

### 7.2 CLI

```
browserhive templates create job-hunt --sites linkedin.com,indeed.com [--channel chrome] [--display "Job hunt"]
    [--description <text>] [--proxy http://host:port --proxyUser <name> --proxyPasswordEnv <ENV>]
    [--locale en-CA --timezone America/Toronto] [--cap 5] [--headless] [--no-login] [--timeout 30m]
```

The command creates the template over the REST API (the server must run with `--admin`), starts recording, prints one line per site and updates it as probes finish (`linkedin.com  ✓ signed in`), and finishes when every site is signed in, when the operator presses Enter ("finish now"), or at `--timeout` (default `30m`; the template stays `recording` and `browserhive templates finish job-hunt` completes it later). `--no-login` creates the template and exits without opening a window.

### 7.3 Google and other human-only sign-ins

Google "may stop sign-ins from browsers that are being controlled through software automation". Packs mark such sites `human_only: true` (§9.2): BrowserHive never fills their sign-in form (no auto-relogin, `vault_fill` refused there, §5.5), and the wizard tells the operator to sign in by hand in the recording window, which is a normal headed Chrome window on their desktop.

---

## 8. Health and re-login (PR T2)

### 8.1 Probes

A probe answers "is the host signed in to this site?" without reading a cookie value. It runs in a page of the host's `maintenance` session (minimized on a headed host), never in an agent's window, and only ever issues `GET` navigations to the site's own probe path; during a probe a guard aborts any document request that leaves the pack's `domains` (§9.10).

1. **Cookie pre-check** (no navigation): the host context's cookies for the pack's domains, names only. When the pack lists `cookie_names` and none of them is present and unexpired → `signed_out`, reason `cookies_absent`.
2. **Navigation** to `https://<probe.host><probe.path>` (`waitUntil: 'domcontentloaded'`, timeout 20 s), then, in this order:
   - a challenge matches (§9.5) → `challenged`, reason `challenge:<kind>`;
   - the final URL matches a `signed_out_redirects` glob → `signed_out`, reason `redirect`;
   - the `signed_out_marker` selector is present → `signed_out`, reason `marker`;
   - the `landmark` selector is present → `signed_in`, reason `landmark`;
   - `kind: 'redirect'` and the final URL is still on the probe host and path → `signed_in`, reason `no_redirect`;
   - otherwise → `inconclusive`, reason `timeout`, `network`, `http_<status>` (≥ 500) or `no_signal`.
3. A generic site (no pack) is probed by step 1 with the cookies seen at recording: no sign-in cookie left → `signed_out`, else `inconclusive` (reason `no_pack`).

Selectors are checked with `page.locator('css=' + selector).count()` and texts with `page.getByText(text)`: queried, never evaluated (§9.10). **A challenged probe is never reported as signed out**, and neither `challenged` nor `inconclusive` ever starts a re-login: logging in again into an anti-abuse checkpoint is the account-safety failure this design avoids.

### 8.2 Before a launch

When `prelaunch_check` is on (default), a launch first probes every enabled site whose last probe is older than 15 min, with a total budget of 10 s (the remaining sites count as `inconclusive`). Then:

- every enabled site is `signed_out` or `challenged` → `TEMPLATE_NEEDS_LOGIN` (`retryable: after_operator`, `details {template, sites[]}`), and the re-login notification is produced (§8.6);
- otherwise the launch proceeds; the session's `template.sites` report each site's status, and a `TEMPLATE_SITE_SIGNED_OUT` warning (10 §1.1) lists signed-out sites on the session's dashboard.

### 8.3 Schedule

- Every template's sites are probed every `health_interval` (per template; default `templateHealthInterval` = `6h`; range 30 min to 7 d) with ±10 % jitter; a pack's `keeper.interval_hours` raises the floor for its site (a probe is traffic).
- Sites of one template are probed one after the other with a random 5–20 s gap; at most 2 hosts probe at the same time; a host that is stopped is started for the probe and stopped again by the idle rule (§3.2); when no browser slot is free for that start (§6.3), the probe is skipped and retried at the next interval.
- Every site is probed after each host start, after a restore, and when an attention request on one of the template's virtual sessions resolves (the operator may have signed in through takeover, §8.4).
- Three consecutive `inconclusive` results show a warning on the template page ("BrowserHive couldn't tell whether LinkedIn is signed in"); no notification.

### 8.4 Re-login

| Path | Who | How |
|---|---|---|
| **Host window** (default) | operator at the BrowserHive machine | dashboard **Re-login**, `browserhive templates login <name> --site <site>`, or the notification's Re-login action: the host starts headed if needed and opens a maintenance window at the site's sign-in URL on that machine's desktop; the cookie pre-check runs every 5 s and the probe when cookies change, for up to 30 min; on `signed_in` a checkpoint is written (`reason: 'relogin'`) and the notification resolves |
| **Attention** | operator anywhere | an agent in a virtual session that meets a sign-in page calls `request_attention` (takeover); the operator signs in through the live view of that session's page (with the live-view input limits of 04 §16); the jar is shared, so the template is signed in; the resolution triggers a probe (§8.3) |
| **Vault auto-relogin** | BrowserHive | only for a site with `vault_handle` and `auto_relogin` and a pack that is not `human_only`: on a `signed_out` probe, a maintenance session (owner: the template's owner) opens the sign-in URL and the vault broker fills it with the linked binding (`form` selectors, §2.3). The link is the operator's authorization: gates 2–2c (principal, slug, harness) are satisfied by the link, gates 1, 3, 4 and 5 run as for any fill (02 §3.13), `dashboard_confirm` asks the operator on the maintenance session, and the fill writes its one `vault_access` row on that session. One attempt per sign-out; a second `signed_out` within 24 h is not retried automatically and produces `template.relogin_failed` |

**Vault auto-relogin happens only into the host, never per agent session**: an agent's own `vault_fill` keeps the normal gates, and never runs for `human_only` sites.

### 8.5 Versions in health

Every successful re-login and every finished recording writes a version (§3.9); the template page lists versions with their reason, size, per-domain summary and the sign-in state they were taken in, and offers Restore and Pin (§3.12). A restore that brings a site back is confirmed by the probe that follows it.

### 8.6 Notifications

New kinds join the open `NotificationKind` set (`packages/contracts/src/enums/notification-kind.ts:8-22`, D-32); the exhaustive maps `KIND_CATEGORY`, `KIND_SEVERITY`, `KIND_LABEL` and `KIND_TYPE` (`packages/contracts/src/notifications/taxonomy.ts:10`, `:27`, `:44`, `:69`) get one entry each, and the producer table of 03 §9.1 one row each.

| Kind | Produced on | Category · severity · state | In-app type | Thread | Actions |
|---|---|---|---|---|---|
| `template.signed_out` | a site's state becomes `signed_out` | needs-you · warn · open → `resolved` when it is `signed_in` again, `final` when the site or template is removed | `attention` | `template:<template_id>:<identity provider site>` | act `template.relogin` ("Re-login on <host name>"), open `/templates/<id>?site=<site>` |
| `template.challenged` | a probe or a session hits a challenge on a site | needs-you · warn · open → `resolved` on the next `signed_in` probe | `attention` | `template:<template_id>:<site>` (the same thread as a sign-out: one message per site) | open `/templates/<id>?site=<site>`; for a session challenge also `/sessions/<id>?live=1&takeover=1` |
| `template.relogin_failed` | auto-relogin failed, or a host-window re-login timed out | problems · warn · final | `error` | `template:<template_id>:<site>` | open `/templates/<id>?site=<site>` |
| `template.host_failed` | a host reaches `failed` | problems · error · open → `resolved` when it runs again | `error` | `template-host:<template_id>` | open `/templates/<id>` |
| `site.write_confirm` (T3) | a write needs confirmation (§9.3) | needs-you · warn · open → `resolved` / `expired` / `final` | `attention` | `site-confirm:<request_id>` | act `site.confirm.resolve` (approve / deny), open `/attention` |
| `site_packs.update` (T4) | updates wait for approval (§10.6) | system · info · open → `resolved` when none is pending | `system` | `site-packs:updates` | open `/site-packs?tab=updates` |

`template.relogin` and `site.confirm.resolve` join the open `NotificationCommandOp` set (D-41); they run through the same services and scopes as the dashboard (`templates:login`, `attention:resolve`). The title of a sign-out reads "Job Hunt: LinkedIn signed out"; its summary names the sites the identity provider covers.

---

## 9. Site packs (D-54; local in PR T3, remote in PR T4)

### 9.1 Purpose

A site pack makes a templated session behave on one site the way that site expects a person to behave, so the account holds up against the site's detection of automation, parallel logins, session sharing and tracking, and so the template stays healthy and signed in. A pack carries:

- how to sign in and how to tell, without reading a cookie value, whether the browser is signed in (§8.1);
- which requests and controls end or endanger the sign-in (logout, account and security pages, destructive actions) and must be blocked, confirmed or flagged (§9.3);
- which pages are challenges that need a human (§9.5);
- how many concurrent sessions and how fast the site tolerates, labelled official or vendor guidance with a source (§9.2);
- the browser, headedness, device binding and geo/timezone/locale consistency the site expects;
- the site's terms clause on automation as data the operator uses to choose a write policy;
- per-site stealth and behaviour strategies, selected from the closed set compiled into the binary (§9.4).

A pack is **data only**. It never carries code, scripts, launch arguments, executable paths, proxy settings, vault rules or any field whose value BrowserHive sends anywhere. A pack applies to template sessions only in this program; applying packs to every session, and to stealth defaults, is deferred (§16).

### 9.2 Schema (`packages/contracts/src/site-packs/schema.ts`)

zod, `.strict()` everywhere: an unknown key fails the pack version, so a new field needs a `min_client` bump and the registry carries several versions per pack (§10.1). One serialized pack is at most 64 KiB.

```ts
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const RegistrableDomain = z.string().min(4).max(253).regex(DOMAIN_RE);   // refine: getDomain(d) === d (kernel/url.ts:59)
const Host = z.string().min(4).max(253).regex(DOMAIN_RE);                // refine at pack level: getDomain(host) ∈ domains
const ScopedPath = z.string().min(1).max(200).regex(/^\/[A-Za-z0-9\-._~\/%]*$/);  // a path: no scheme, query or fragment
const ScopedUrl = z.object({ host: Host, path: ScopedPath }).strict();   // always https://<host><path>
const UrlGlob = z.string().min(1).max(300);       // spec 11 §5 grammar ('*', '?' only, no regex, no scheme);
                                                   // refine: its host part's registrable domain is literal and ∈ domains
const CssSelector = z.string().min(1).max(200);   // refine: parses as at most 4 CSS selectors; no engine prefix
                                                   // (`xpath=`, `text=`, `css=`, `internal:`), no `>>`, at most one `:has(`
const Text = z.string().min(2).max(120);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const Method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ResourceType = z.enum(['document', 'xhr', 'fetch', 'other']);
const Source = z.object({ url: z.string().url().max(500).startsWith('https://'), kind: z.enum(['official', 'vendor', 'community', 'observed']) }).strict();
const Action = z.enum(['block', 'confirm', 'warn', 'write_policy']);
const GuardKind = z.enum(['logout', 'account', 'destructive', 'write']);

const Guard = z.object({
  id: Id, kind: GuardKind,
  match: z.object({
    url: UrlGlob,
    methods: z.array(Method).min(1).max(5).optional(),              // absent = every method
    resource_types: z.array(ResourceType).min(1).max(4).optional(), // absent = document, xhr, fetch
  }).strict(),
  action: Action,                                                   // 'write_policy' only when kind = 'write'
}).strict();

const ElementGuard = z.object({
  id: Id, kind: GuardKind,
  page: UrlGlob,                                                    // pages where the control is guarded
  target: z.union([
    z.object({ selector: CssSelector }).strict(),
    z.object({ role: z.enum(['button', 'link', 'menuitem']), name: Text }).strict(),
  ]),
  action: Action,
}).strict();

const Challenge = z.object({
  id: Id, kind: z.enum(['checkpoint', 'captcha', 'reauth', 'locked', 'rejected']),
  match: z.object({                                                 // refine: at least one member
    url: UrlGlob.optional(),
    frame: z.enum(['cloudflare', 'recaptcha', 'hcaptcha', 'arkose', 'datadome']).optional(),  // CHALLENGE_PROVIDERS (§9.5)
    title_contains: Text.optional(), landmark: CssSelector.optional(), text: Text.optional(),
  }).strict(),
  action: z.enum(['attention', 'stop']),
}).strict();

const PaceRule = z.object({
  id: Id, guard: Id,                                                // refine: names a guard of kind 'write' in this pack
  per: z.enum(['minute', 'hour', 'day', 'week']),
  limit: z.number().int().min(1),                                   // refine: ≤ PACE_CEILING[per] (§9.10)
  kind: z.enum(['official', 'vendor']), source: Source,
}).strict();

export const SitePackV1 = z.object({
  schema: z.literal(1),
  id: RegistrableDomain,                                            // the pack's identity: linkedin.com
  version: z.number().int().min(1).max(1_000_000),                  // strictly increasing per pack
  min_client: SemVer, max_client: SemVer.optional(),
  title: z.string().min(1).max(60), description: z.string().max(500).optional(),
  domains: z.array(RegistrableDomain).min(1).max(8),                // refine: domains[0] === id, unique
  identity_provider: RegistrableDomain.optional(),                  // the pack whose sign-in this site uses (youtube.com → google.com)
  shares_login_with: z.array(RegistrableDomain).max(4).default([]),
  sign_in: z.object({                                               // required unless identity_provider is set
    url: ScopedUrl,
    human_only: z.boolean(),                                        // true: never filled by the vault (§7.3)
    form: z.object({ username: CssSelector, password: CssSelector, submit: CssSelector.optional(), next: CssSelector.optional() }).strict().optional(),  // refused with human_only
  }).strict().optional(),
  signed_in: z.object({
    probe: ScopedUrl,
    kind: z.enum(['redirect', 'landmark', 'either']),               // refine: 'redirect' needs signed_out_redirects; 'landmark' needs landmark or signed_out_marker
    signed_out_redirects: z.array(UrlGlob).max(8).default([]),
    landmark: CssSelector.optional(),
    signed_out_marker: CssSelector.optional(),
    cookie_names: z.array(z.string().min(1).max(64).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)).max(8).default([]),   // presence only
    session_lifetime_days: z.number().int().min(1).max(730).optional(),
  }).strict(),
  guards: z.array(Guard).max(64).default([]),
  element_guards: z.array(ElementGuard).max(16).default([]),
  write_policy: z.object({
    default: z.enum(['allow', 'warn', 'confirm']),
    stance: z.enum(['prohibited', 'restricted', 'writes_restricted', 'allowed']),   // the terms' position on automation
    clause: z.object({ quote: z.string().min(1).max(300), url: z.string().url().max(500).startsWith('https://'), checked: IsoDate }).strict().optional(),
  }).strict(),
  challenges: z.array(Challenge).max(32).default([]),
  concurrency: z.object({ max_sessions: z.number().int().min(1).max(20), source: Source }).strict().optional(),
  pacing: z.object({ rules: z.array(PaceRule).max(16).default([]), min_launch_gap_s: z.number().int().min(0).max(3600).default(0) }).strict().optional(),
  browser: z.object({ channel: z.enum(['chrome', 'edge', 'any']).default('any'), headed: z.enum(['required', 'preferred', 'any']).default('any') }).strict().default({}),
  device_binding: z.array(z.object({ platform: z.enum(['windows', 'macos', 'linux']), mechanism: z.enum(['dbsc', 'ip', 'device_cookie']), since: z.string().max(40).optional(), source: Source }).strict()).max(4).default([]),
  consistency: z.object({ pin_geo: z.boolean().default(true), pin_timezone: z.boolean().default(true), pin_locale: z.boolean().default(true), proxy: z.enum(['recommended', 'any']).default('any') }).strict().default({}),
  strategies: z.array(z.object({ id: StrategyId, params: z.record(z.string().max(40), z.union([z.number(), z.boolean(), z.string().max(200)])).default({}) }).strict()).max(8).default([]),
  keeper: z.object({ interval_hours: z.number().int().min(6).max(168), path: ScopedPath.optional() }).strict().optional(),
  verified: z.record(z.enum(['sign_in', 'signed_in', 'guards', 'element_guards', 'write_policy', 'challenges', 'concurrency', 'pacing', 'browser', 'device_binding', 'consistency', 'strategies']), IsoDate).default({}),
  sources: z.array(Source).max(10).default([]),                     // display only, never fetched
}).strict();
```

`StrategyId` is the closed enum of §9.4; each strategy validates its own `params`. The pack-level refinements are listed in §9.10; the schema file exports them as one `refinePack()` used by the registry, the CLI `sitepacks verify`, the website build and the tests.

### 9.3 Guards and write policies

Guards are enforced in two places, both pure matching over the pack's data with the spec 11 §5 glob matcher (`parseBlocklist`, `blocklistComparisonForms`, `matchBlocklist`, `packages/core/src/domain/policies/blocklist.ts:89`, `:139`, `:165`):

1. **The request guard**, the second `InterceptionChain` handler (PR T0 builds the method-aware mechanism; T3 feeds it pack rules). It matches every request of a host by method, URL and resource type; the first matching guard of the request's site decides. This closes today's gap: the blocklist aborts document loads only and cannot match a method (`packages/core/src/infra/browsers/blocklist-route.ts:76`), so `linkedin.com/m/logout/` loaded unblocked and a `fetch` or form `POST` logout passes.
2. **The tool layer**, before the browser is touched: `navigate` and `new_tab(url)` check `GET` document guards (as the blocklist's `urlBlocklist` policy does, 11 §5), and `click`, `press_key` (with a selector and `Enter` or `Space`) check element guards with `locator(<agent selector>).and(<guard locator>).count() > 0`, where the guard locator is `locator('css=' + selector)` or `getByRole(role, {name})`: queried, never evaluated.

| Effective action | Network path | Tool path |
|---|---|---|
| `block` | `route.abort('blockedbyclient')`; audit row | `URL_BLOCKED` with `pattern: '<pack id>#<guard id>'` (navigation) or `SITE_ACTION_BLOCKED` (element) |
| `confirm` | the request is **held** (the route handler awaits) and a `security_intercept` request with `reason: 'write_confirm'` opens on the owning session (§9.5); approve → `route.continue()`, deny or 10 min without an answer (`WRITE_CONFIRM_TIMEOUT_MS = 600000`) → `route.abort('blockedbyclient')`. A host-owned request (service worker, parked page) cannot be confirmed and is blocked | the tool answers `SITE_OPERATOR_PENDING` with the request id; an approval grants that session a one-time pass for the same guard and URL for 10 min |
| `warn` | `route.fallback()`; audit row; `SITE_GUARD_WARNED` session warning; counted | proceed; audit row |
| `write_policy` | the site's effective write policy: the template site's `write_policy` override, else the pack's `write_policy.default`; mapped to allow (`route.fallback()`), warn or confirm as above | the same mapping |

- Every guard decision writes one `site_guard_hits` row (§9.9) with the guard, action, session (or `NULL` for host-owned requests), method, sanitized URL and, for confirmations, the request id.
- **Terms clauses are data.** `write_policy.clause` is shown verbatim, with its `checked` date and link, in the wizard, the template's site card and the pack page; `stance` is shown as a label ("The site's terms prohibit automated access"). The operator decides the write policy; the clause has no other effect.
- Write guards (`kind: 'write'`) are also what `pace-writes` counts (§9.4).
- A `human_only` site: the vault refuses to fill it (`vault_fill` returns `blocked`, `not_authorized`; the audit row's reason is `human_only_site`), and auto-relogin cannot be enabled for it.

### 9.4 Strategies (the closed set compiled into the binary)

A strategy is code in `packages/core/src/infra/site-packs/strategies/` registered in a compile-time exhaustive map (`STRATEGIES: {[K in StrategyId]: SiteStrategy}`, the pattern of `CHANNEL_KIND_SPECS`). A pack selects strategies by id and passes parameters that the strategy's own schema validates and **clamps to bounds fixed in the binary**; a pack version naming an unknown id is skipped (`unknown_strategy`), so an older binary keeps its previous version. The always-on **data interpreter** (probes, guards, challenges, write policies, concurrency, consistency checks) is not a strategy and needs no selection.

| `StrategyId` | Hooks | Parameters (default; bounds) | Behaviour |
|---|---|---|---|
| `pace-writes` | request guard | none (reads `pacing.rules`) | One token bucket per (template, rule): the account's budget, shared by every session of the template. A matching write over budget is held until the next token when that is ≤ 60 s away (plus 0–20 % jitter), else aborted with an audit row (`action: 'paced'`) and a `SITE_PACED` session warning |
| `launch-spacing` | admit | `min_gap_s` (pack `pacing.min_launch_gap_s`; 0–3600), `jitter_pct` (20; 0–50) | Consecutive virtual-session launches on the template are spaced; a launch waits up to 30 s for its turn, beyond that it answers `TEMPLATE_BUSY` with `retry_after_ms` |
| `ramp-up` | admit, request guard | `days` (14; 1–90), `start_fraction` (0.3; 0.1–1) | For a template younger than `days`, the cap and every `pace-writes` limit are multiplied by `start_fraction + (1 − start_fraction) × age_days / days`, rounded up |
| `serialize-site` | before action | `max_parallel` (1; 1–5) | At most `max_parallel` sessions of the template run an interaction or navigation tool on the site's pages at once; others wait (FIFO) up to 30 s, then answer `TEMPLATE_BUSY` (`limit_kind: 'site_actions'`). One person, many tabs, one at a time |
| `human-dwell` | before action | `min_ms` (600; 0–10000), `max_ms` (2500; `min_ms`–20000) | Before an interaction or navigation tool on the site's pages, the session waits until a random dwell in `[min_ms, max_ms]` has passed since its previous action on that site |
| `humanize-input` | before action | none | Forces humanized pointer and typing (02 §7) for the site's pages whatever the session's `humanize`; ignored with a template warning when the template's stealth is `off` |
| `entry-warmup` | before action | `path` (`/`; a `ScopedPath` on the pack's first domain's `www.` host or the probe host), `dwell_ms` (2000; 500–10000) | A session's first navigation to the site that is a deep link first loads `https://<host><path>` and dwells, so the account does not arrive cold on a deep page |
| `keep-alive` | keeper | `interval_h` (pack `keeper.interval_hours`, else 24; 6–168) | A maintenance page visits the keeper path (else the probe path) with `GET` at the interval ± 20 %, skipped when a virtual session loaded the site within the interval; rolling cookies stay fresh. Doubles as a probe |
| `active-hours` | admit | `start_hour` (8; 0–23), `end_hour` (22; 0–23), `weekdays_only` (false) | Launches outside the window, in the template's pinned timezone, answer `TEMPLATE_BUSY` with `retry_after_ms` to its start; running sessions continue |
| `device-bound-session` | request guard (observe only) | none | Watches in-scope responses for `Sec-Session-Registration` / `Sec-Session-Id` headers (DBSC) and marks the template site `device_bound` (shown as a badge; blocks future export and serial checkout, §16); never changes a request |

```ts
// packages/core/src/ports/site-strategy.ts
interface SiteStrategy<P> {
  readonly id: StrategyId;
  readonly params: z.ZodType<P>;                                     // clamps to the binary's bounds
  readonly hooks: Partial<{
    admit(ctx: TemplateAdmitContext, params: P): Promise<AdmitDecision>;            // proceed | wait(ms) | refuse(TEMPLATE_BUSY details)
    beforeAction(ctx: SiteActionContext, params: P): Promise<void>;                 // may wait; may throw TEMPLATE_BUSY
    onRequest(ctx: SiteRequestContext, params: P): Promise<RequestDecision>;        // pass | hold(until) | abort(reason) | observe
    keeper(ctx: KeeperContext, params: P): KeeperPlan;
  }>;
}
```

### 9.5 Challenges

- **Detection** (fail-open) runs on every page of a host whose URL is on a pack's domains, and the built-in defaults on every page of a host: a main-frame navigation whose URL matches a challenge `url` glob; a frame attached from a provider of `CHALLENGE_PROVIDERS` (`cloudflare`: `challenges.cloudflare.com`; `recaptcha`: `www.google.com/recaptcha/*`, `www.recaptcha.net/recaptcha/*`; `hcaptcha`: `*.hcaptcha.com`; `arkose`: `*.arkoselabs.com`; `datadome`: `*.captcha-delivery.com`); after `domcontentloaded`, `page.title()` containing `title_contains`, a `landmark` selector present, or `text` present (`getByText`). The built-in defaults (`DEFAULT_CHALLENGES`) match the Cloudflare interstitial ("Just a moment", "Verify you are human") and every provider frame, with `kind: 'captcha'`, `action: 'attention'`.
- **In an agent's virtual session**, a match opens a `security_intercept` operator request on that session (D-15: the reserved kind, built by migration v9, §9.9) with `mode: 'takeover'`, `reason` "<Site title> security check" and `options {reason: 'challenge', site, challenge, kind, action, page_url}`. The lease pauses (D-15); the template site's health becomes `challenged`; the `template.challenged` notification opens or grows. Until the request settles, every tool on the session except `close_session`, `list_sessions`, `server_status`, `session_info`, `list_tabs`, `screenshot`, `list_templates`, `get_attention_result`, `list_saved_auths` and `vault_list_available` answers `SITE_OPERATOR_PENDING` (`details {session_id, site, request_id, reason}`); the agent may wait with `get_attention_result(request_id)`.
- **Resolving.** The operator takes over in the live view (operator input is permitted while a `takeover`-mode `attention` **or** `security_intercept` request is open, extending `AttentionService.isInputPermitted`, `packages/core/src/app/attention/attention-service.ts:180-182`) or solves it in the host window, then resolves or rejects it on `/attention` (`POST /attention/{request_id}/resolve`, `attention:resolve`); `get_attention_result` returns the outcome to the owning principal (today it answers only `attention` rows, `attention-service.ts:122`). A resolution triggers a probe of the site.
- **`stop`** (terminal states such as Google's "Couldn't sign you in" or Instagram's suspension, where retrying makes things worse): as above, and additionally every agent navigation to the site answers `URL_BLOCKED` with `pattern: '<pack id>#stop'` until the operator clears the site on the template page.
- **In a maintenance session or a probe** a match only sets the probe's outcome (`challenged`); no request opens.
- **Bounds.** At most one open challenge request per session (further matches on that session attach to it), at most one new one per session per 5 min, at most 10 open `security_intercept` requests per template (beyond that, sessions are held with the newest open request's id); notifications are grouped per template and site.

### 9.6 Ports, the registry service and hook points

```ts
// packages/core/src/ports/site-pack-source.ts
interface SitePackSource {
  readonly id: 'bundled' | 'remote' | 'local' | 'import';
  readonly trust: 'publisher' | 'operator';            // bundled/remote/import: publisher (signed); local: operator
  load(signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>>;   // already verified and schema-checked
}
// packages/core/src/app/site-packs/registry.ts
class SitePackRegistry {
  effectiveFor(hostOrDomain: string): EffectivePack | null;   // getDomain() then the owning pack
  list(): readonly SitePackView[]; get(packId): SitePackView | null;
  pending(): readonly PendingUpdate[];                         // classified diffs awaiting a decision (§9.7)
  approve(packId, version, by); reject(packId, version, by); pin(packId, version | null, by); setEnabled(packId, enabled, by);
  reload(): Promise<RegistryStats>;                            // atomic swap; a failed load keeps the previous set (D-22 pattern)
  stats(): RegistryStats;                                      // per source: loaded, skipped [{pack, version, reason}], last load
}
```

- **Precedence.** For one pack id: a **local** pack (operator trust, `sitePacksDir`, unsigned) wins; else the **approved** version from the registry or an import; else the **bundled** version shipped in the release. Installing a release approves its bundled versions, except that a bundled version adding a domain to a pack a template uses waits for approval like any scope expansion (§9.7).
- **Matching by eTLD+1.** A host belongs to the pack whose `domains` contain `getDomain(host)` (`packages/core/src/kernel/url.ts:59`, the vault's origin semantics). A registrable domain belongs to at most one pack: a pack version claiming a domain another pack of higher precedence owns is skipped (`domain_overlap`). Subdomain rules use host globs inside the pack's domains.
- **Hook points:**

| Event | Hook | Where |
|---|---|---|
| Template creation and site add | requirements (channel, headed, proxy, consistency), the clause and write policy shown, `human_only` | `TemplateService.create` / wizard step 2 |
| Probe and keep-alive | `signed_in` data; `keep-alive` | the health scheduler (§8.3) |
| Before navigation and element actions | `GET` document guards, element guards, `serialize-site`, `human-dwell`, `humanize-input`, `entry-warmup` | the tool dispatcher's policies for template sessions (02 §2.3) |
| Every request of a host | the request guard: guards, write policy, `pace-writes`, `ramp-up`, `device-bound-session` | `InterceptionChain` handler #2 (§3.8) |
| Challenge detected | a `security_intercept` operator request (§9.5) | `OperatorRequestBroker` (D-15) |
| Admission of a virtual session | `concurrency`, `launch-spacing`, `active-hours`, `ramp-up` | a decorating `AdmissionPolicy` (`packages/core/src/domain/session/admission.ts:24`) |

- `SitePackRegistry` publishes `site-packs.changed` and `site-packs.status` on the bus (§11.3) and records `SITE_PACKS_STALE` / `SITE_PACKS_FETCH_FAILED` degradations (10 §3).
- `sitePacks=false` turns the whole layer off: templates use generic sites (cookie-presence probes, no guards, no strategies), the catalog shows only domains, and no update check runs.

### 9.7 Tightening and loosening

Every change from the approved version to a candidate is classified field by field in the binary (`classifyPackChange`, unit-tested per field). The candidate's class is the strongest of its fields: **loosening** > **tightening** > **neutral**.

| Field | Tightening | Loosening | Neutral |
|---|---|---|---|
| `domains` | a domain removed | **a domain added** (always needs approval) | |
| `identity_provider`, `shares_login_with` | | any change | |
| `sign_in.url`, `sign_in.form` | | any change | |
| `sign_in.human_only` | `false → true` | `true → false` | |
| `signed_in.*` | | any change (a wrong probe hides a sign-out or loops re-login prompts) | |
| `guards`, `element_guards` | a guard added; an action made stricter (`warn` < `write_policy` < `confirm` < `block`) | a guard removed; an action made laxer; a `match` or `target` changed | |
| `write_policy.default` | stricter (`allow` < `warn` < `confirm`) | laxer | `stance`, `clause` |
| `challenges` | a challenge added; `attention → stop` | a challenge removed or its match changed; `stop → attention` | |
| `concurrency.max_sessions`, `pacing.rules[].limit` | lowered; a rule added | raised; a rule removed | `source` |
| `pacing.min_launch_gap_s`, `keeper.interval_hours` | raised | lowered | |
| `browser`, `consistency` | `headed` or `proxy` made stricter | made laxer; `channel` changed | |
| `device_binding` | an entry added | an entry removed | |
| `strategies` | a strategy added; a parameter moved toward its safe bound (each strategy declares the direction) | a strategy removed; a parameter moved away | |
| `title`, `description`, `verified`, `sources`, `min_client`, `max_client` | | | any change |

With `sitePacksAutoUpdate=true`, tightening and neutral candidates apply automatically; **loosening candidates and new domains always wait for an operator's approval**, with auto-update on or off. With the default `sitePacksAutoUpdate=false`, every candidate waits (§10.6). A revoked approved version (`revoked: true` in the index, §10.1) falls back to the previous approved version at once and is listed as a decision.

### 9.8 Bundled packs

The first release with T3 bundles the packs drafted in the site catalog research (`scratchpad/session-templates/06-site-catalog.md`). **Every field marked unverified there MUST be confirmed against a live signed-in session before it ships**; a field that cannot be confirmed is left out, and the pack's `verified` dates record what was checked.

| Pack id | `domains` | Identity provider | Probe | `human_only` | Default write policy | Strategies |
|---|---|---|---|---|---|---|
| `google.com` | `google.com` | | `myaccount.google.com/`, `redirect` (signed out → `www.google.com/account/about/`) | `true` | `allow` (account pages blocked) | `keep-alive`, `device-bound-session` |
| `youtube.com` | `youtube.com` | `google.com` | `www.youtube.com/feed/history`, `landmark` (signed-out marker: the "Sign in" link) | (provider's) | `allow`; history-clearing controls blocked | `keep-alive` |
| `linkedin.com` | `linkedin.com`, `licdn.com` | | `www.linkedin.com/feed/`, `redirect` (`/uas/login`, `/authwall`) | `false` | `confirm` (invitations, messages, posts) | `serialize-site`, `human-dwell`, `launch-spacing`, `ramp-up`, `pace-writes` |
| `reddit.com` | `reddit.com`, `redd.it` | | `www.reddit.com/settings/account`, `either` | `false` | `warn` | `human-dwell` |
| `facebook.com` | `facebook.com`, `fbcdn.net` | | `www.facebook.com/settings`, `redirect` (`/login.php`) | `false` | `warn` | `serialize-site`, `human-dwell` |
| `instagram.com` | `instagram.com`, `cdninstagram.com` | | `www.instagram.com/accounts/edit/`, `redirect` (`/accounts/login`) | `false` | `warn` | `serialize-site`, `human-dwell` |
| `x.com` | `x.com`, `twitter.com`, `twimg.com` | | `x.com/settings/account`, `redirect` (`/i/jf/onboarding/web`, `/i/flow/login`, `/login`) | `false` | `confirm` (posts, replies, DMs, follows, likes) | `serialize-site`, `human-dwell`, `pace-writes` |
| `github.com` | `github.com` | | `github.com/settings/profile`, `redirect` (`/login`) | `false` | `allow` (sudo prompts are challenges) | |
| `indeed.com` | `indeed.com` | | `www.indeed.com/myjobs`, `redirect` (`secure.indeed.com/auth`) | `false` | `confirm` (Indeed Apply submit, terms §A.3.5) | `human-dwell` |
| `glassdoor.com` | `glassdoor.com` | `indeed.com` | `www.glassdoor.com/member/profile/index.htm`, `redirect` (`/member/profile/login`) | (provider's) | `warn` | `human-dwell` |
| `microsoft.com` | `microsoft.com`, `live.com`, `microsoftonline.com` | | `account.microsoft.com/`, `redirect` (`login.live.com`, `login.microsoftonline.com`) | `false` | `allow` (`account.microsoft.com/security*` guarded: probing it forces a fresh sign-in) | `keep-alive` |

Logout guards (`block`) and account, security and deletion pages (`block`, or `confirm` where a page is also the probe: Reddit's `/settings/account` is probed with `GET` and guarded for form posts only) follow the catalog's lists. Pacing rules ship only with their source and kind: X's numbers are official technical caps (`help.x.com/en/rules-and-policies/x-limits`), LinkedIn's are vendor guidance.

### 9.9 Database (migration `0009-site-packs`, schema v9, PR T3)

`compatible: false`: `operator_requests.kind` has a CHECK constraint (`packages/core/src/infra/persistence/migrations/0001-initial.ts:267`), so adding `security_intercept` rebuilds the table (`foreign_keys=OFF` around the rebuild, D-04) and raises `meta.min_reader_version` to 9. A binary older than v9 refuses the database with `DB_NEWER_THAN_BINARY`, naming the pre-upgrade backup (D-04); the release notes of the T3 release say so.

```sql
-- v9 (0009-site-packs): site packs (spec 13 §9, D-54) and the security_intercept operator request (D-15)
-- operator_requests is rebuilt with the same columns, indexes and data, plus:
--   kind CHECK (kind IN ('attention','vault_confirm','security_intercept'))
--   template_id TEXT                                     -- the template a security_intercept request belongs to; NULL otherwise
CREATE TABLE site_pack_state (                           -- configuration class: never pruned
  pack_id TEXT PRIMARY KEY,
  approved_version INTEGER, approved_sha256 TEXT,
  source TEXT NOT NULL CHECK (source IN ('bundled','remote','import','local')),
  pinned_version INTEGER,                                -- NULL = follow approvals
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  approved_domains_json TEXT NOT NULL DEFAULT '[]',      -- the scope the operator approved
  approved_by TEXT, approved_at INTEGER, updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE site_pack_changes (                         -- audit class: every candidate and decision
  seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
  pack_id TEXT NOT NULL, from_version INTEGER, to_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled','remote','import','local')),
  classification TEXT NOT NULL CHECK (classification IN ('tightening','loosening','neutral','new_pack','revoked')),
  new_domains_json TEXT NOT NULL DEFAULT '[]',
  diff_json TEXT NOT NULL,                               -- [{path, from, to, class}]
  decision TEXT NOT NULL CHECK (decision IN ('pending','auto','approved','rejected','superseded','reverted')),
  decided_by TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX idx_site_pack_changes_pack ON site_pack_changes(pack_id, seq);
CREATE INDEX idx_site_pack_changes_pending ON site_pack_changes(created_at) WHERE decision = 'pending';
CREATE TABLE site_guard_hits (                           -- audit class
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,   -- NULL for host-owned requests
  template_id TEXT, pack_id TEXT NOT NULL, guard_id TEXT NOT NULL,
  guard_kind TEXT NOT NULL CHECK (guard_kind IN ('logout','account','destructive','write','stop')),
  action TEXT NOT NULL CHECK (action IN ('block','confirm','warn','paced','held')),
  outcome TEXT CHECK (outcome IN ('approved','denied','timeout')),     -- confirmations only
  source TEXT NOT NULL CHECK (source IN ('tool','request','element')),
  method TEXT, url TEXT NOT NULL,                        -- sanitized (D-20)
  request_id TEXT, tool TEXT, ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_site_guard_hits_ts ON site_guard_hits(ts, event_id);
CREATE INDEX idx_site_guard_hits_session ON site_guard_hits(session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX idx_site_guard_hits_template ON site_guard_hits(template_id, ts);
```

The registry client's rollback floors (highest `keys.json` and `index.json` versions seen, §10.3) are stored in the `meta` table (`site_packs.keys_version`, `site_packs.index_version`), so no further migration is needed for T4.

### 9.10 Constraints that make malicious data harmless

A remote registry adds a third principal, the publisher, trusted less than the operator. The schema and the binary bound what a compromised publisher (a stolen online key, a malicious merge, a hijacked site) could do:

| Field | Abuse if unconstrained | Constraint |
|---|---|---|
| `sign_in.url` (opened in a window where the operator types a password) | point it at a look-alike domain: phishing | a `ScopedUrl` (`https`, host inside the pack's `domains`, path only, no query); shown in full in the dashboard before the window opens; any change is loosening |
| `domains` | widen a pack so its other rules can target any site | each new domain needs the operator's approval, even with auto-update on; overlapping domains are refused |
| probe and keeper paths (navigated automatically in every template) | a logout endpoint, a deletion `GET`, or an open redirect inside the domains | path only, no query; must not match the pack's own logout or account guards; during probes and keeper visits a guard aborts every document request leaving the pack's domains (fail-closed) |
| `guards` | block password or security pages, or whole sites: denial of the agent's work; hide warning pages | glob grammar only, hosts inside the pack's domains, at most 64; shown in the diff; removals are loosening |
| `challenges` | match everything (notification storm) or nothing (agents keep hammering a checkpoint) | per-session and per-template request bounds (§9.5); removing a challenge is loosening |
| `signed_in` | always signed in (hides expiry) or always signed out (re-login loops) | cookie **names** only, never values; selectors queried, never evaluated; re-login never starts on `challenged` or `inconclusive`; any change is loosening |
| numbers (`concurrency`, `pacing`, `min_launch_gap_s`, keeper interval, strategy parameters) | raise caps until accounts are banned; set to 0 for denial of service | floors and ceilings in the binary: `max_sessions` 1–20 and never above the template's `max_concurrent`; `PACE_CEILING` = 60/minute, 1000/hour, 10000/day, 50000/week; keeper 6–168 h; strategy bounds of §9.4; raising is loosening |
| selectors | script execution, engine escapes, CPU exhaustion | plain CSS ≤ 200 characters, at most 4 selectors per list, one `:has(`, no engine prefix or `>>`; only ever passed to `locator('css=…')` |
| any string | XSS in the dashboard, oversized payloads | rendered as text only; per-field length caps; 64 KiB per pack, 256 KiB per index (the endless-data defence) |
| strategy ids | reference behaviour the binary does not have | only ids compiled into this binary; an unknown id skips the pack version |

There is **no exfiltration channel by construction**: no pack field is ever sent anywhere, the fetch carries no data about the install (§10.4), and every URL a pack can make the browser load is inside its approved domains.

---

## 10. Registry delivery (D-55, PR T4)

### 10.1 Layout on browserhive.ai

```
https://browserhive.ai/registry/v1/
  keys.json            {schema: 1, version, expires, index_floor?, online: [{key_id, public_key, not_after}]}
  keys.json.sig        Ed25519 signature of keys.json by a root key
  index.json           {schema: 1, version, issued_at, expires, packs: [{id, versions: [{v, min_client, max_client?, sha256, size, path, revoked?}]}]}
  index.json.sig       Ed25519 signature of index.json by an online key
  packs/<id>/<sha256>.json   one pack version, content-addressed, immutable
```

The schema major is in the path (`/v1/`); a client that finds nothing it can parse keeps what it has. `path` is relative to `registry/v1/` and MUST equal `packs/<id>/<sha256>.json`. Pack files are trusted only through the index's `sha256` and `size` (the mix-and-match defence).

### 10.2 Signing (TUF-lite)

- **Ed25519**, verified with `node:crypto` `verify(null, bytes, publicKey, signature)` over the exact file bytes (no canonicalisation on the client; producers write canonical JSON with sorted keys only so diffs stay stable). A unit test proves Bun's `node:crypto` verifies Ed25519 before anything relies on it.
- **Root keys**: two Ed25519 keys held offline by the owner, threshold 1 of 2 (one may be lost), pinned in the binary (`packages/core/src/infra/site-packs/trust-root.ts`) and published in the repository (`registry/keys/root-1.pub`, `root-2.pub`). They sign only `keys.json`. Replacing a root key requires a release.
- **Online key**: one Ed25519 key in an approval-gated CI environment (§10.7), listed in `keys.json` with `not_after` at most 90 days after it was added. It signs `index.json`. A stolen online key is revoked by a new root-signed `keys.json`, without a release.
- **Freshness**: `index.json.expires` is at most 14 days after `issued_at`; CI re-signs the same content every week with a new `version` and `expires` (the TUF timestamp role). `keys.json.expires` is at most 400 days ahead.
- **Pull-request previews** sign with a test key that release binaries do not trust. Tests inject a test trust root through the programmatic API (`createServer({ sitePacksTrustRoot })`); there is no configuration key, flag or environment variable that weakens verification.

### 10.3 Client verification

1. `keys.json`: the signature verifies against a pinned root key; `version ≥` the stored `site_packs.keys_version`; not expired. Accept → store the version. When it carries `index_floor`, the stored index floor is reset to it (the only way to lower the floor after a fast-forward attack).
2. `index.json`: ≤ 256 KiB; signed by an online key of the accepted `keys.json` whose `not_after` is later than `issued_at`; `version >` the stored `site_packs.index_version` and `≤` it + 100 000 (fast-forward bound); `now < expires`. Accept → store the version and keep the file as the last good index.
3. Each pack version the client does not hold: `size` and `sha256` match the index, ≤ 64 KiB, parses with `SitePackV1` and `refinePack()`, `min_client ≤` this binary `≤ max_client`. The highest acceptable non-revoked version per pack is the candidate.
4. An expired index is never used for new content: the last good index stays in force and the `SITE_PACKS_STALE` degradation (warn) is recorded until a fresh one verifies. A verification failure keeps everything as it was and is recorded in `site_pack_changes` only when a candidate was involved; three consecutive failed checks record `SITE_PACKS_FETCH_FAILED` (warn).

### 10.4 Polling and request hygiene

- When `sitePacksUpdateCheck` is on (default) and at least one template exists, the client checks 5 minutes after boot, then every 24 h ± 2 h, and when the first template is created; the operator can check at any time (`POST /site-packs/check`, `browserhive sitepacks check`). With no template there is nothing to keep fresh and no request is made.
- Requests: HTTPS only to `sitePacksUrl`; conditional `GET` with `If-None-Match` (browserhive.ai's static hosting answers `304` with strong ETags); `User-Agent: BrowserHive` with no version and no install identifier; no cookies, no query string, no request body; 5 s connect and 30 s total timeout.
- **Whole catalog.** The client fetches `keys.json`, `index.json` and every pack version listed that it does not hold, not only the packs its templates use, so the requests never reveal which sites the operator uses. The registry learns the requester's IP address and timing, nothing else; `docs/guide/security.md` says so.

### 10.5 Manual download, import and air-gapped hosts

- `sitePacksUpdateCheck=false` stops every request; bundled and local packs still work.
- `browserhive sitepacks export <dir>` (on a connected host) writes the verified signed layout of §10.1; `browserhive sitepacks import <dir|file>` (or `POST /site-packs/import`, ≤ 1 MiB) verifies it with the pinned keys exactly as a fetch would and queues its candidates for approval.
- A folder of operator packs (`sitePacksDir`, default `<data-dir>/site-packs/local`; unsigned JSON files, one pack each, validated with the same schema) overrides every other source (operator trust). The registry reloads it on `POST /site-packs/reload` and at boot; a pack that fails validation is skipped with its reason on the Site packs page.

### 10.6 The update experience

- **Approval by default.** A verified candidate becomes a pending update with its classified diff (§9.7). Nothing changes until the operator decides, unless `sitePacksAutoUpdate=true` and the candidate is tightening or neutral.
- **Dashboard**: a banner on the Templates and Site packs pages ("3 site pack updates are waiting — 1 loosens rules"), and the Site packs page's Updates tab with one card per pack: from and to versions, the classification chip, a field-level diff (loosening fields and new domains highlighted, each with the old and new value as text), the sources and verified dates, and **Approve**, **Reject** and **Pin current version**. Approving a pack updates the `pack_version` of every template site using it and records an `operator_actions` row and a `site_pack_changes` decision.
- **CLI**: `browserhive sitepacks list` marks pending updates; `diff <id>` prints the diff; `approve <id>` / `reject <id>` decide.
- **Notification**: `site_packs.update` (§8.6) while updates wait; revised to `resolved` when none is left.
- **Pins**: a pinned pack ignores newer versions (they are listed as "pinned at v7, v9 available"); a revoked pinned version is still reverted.

### 10.7 Publishing (CI)

- **Source of truth**: a top-level `registry/` folder in the repository (`registry/packs/<id>.json`, canonical JSON; `registry/keys/root-1.pub`, `root-2.pub`), reviewed like code (CODEOWNERS: the owner).
- **Pull requests** touching `registry/**` run the `registry-check` job in `ci.yml`: schema and `refinePack()` for every pack, version strictly greater than on `main` for changed packs, globs parsed with the spec 11 grammar, size caps, and a tighten/loosen report per pack in the job summary. `packages/contracts/test/site-packs/registry.test.ts` runs the same checks in `bun test`.
- **Merge to `main`**: `website.yml` builds `dist/registry/v1/` (content-addressed pack files and an unsigned `index.json`) as an artefact; a `registry-sign` job in the GitHub environment `registry-signing` (required reviewer: the owner; secret `REGISTRY_ONLINE_KEY`, separate from `CLOUDFLARE_API_TOKEN`) rebuilds from the commit, checks the artefact is identical, signs `index.json` and attests the build (`actions/attest-build-provenance`); the existing deploy job uploads the signed files.
- **Weekly** (`registry-resign.yml`, a scheduled workflow in the same environment): re-sign the current content with a new `version` and `expires`. A missed re-sign makes installs report `SITE_PACKS_STALE` after 14 days; nothing stops working.
- **Root operations** (adding or rotating the online key, writing `keys.json`) run offline with `bun scripts/registry-keys.ts` on the owner's machine.

### 10.8 Website hosting change (part of T4)

browserhive.ai is a static Cloudflare Workers assets site (`website/wrangler.jsonc`); it needs one deploy change, delivered in T4: the build copies the signed registry output into `website/dist/registry/v1/`, and `website/public/_headers` gains `/registry/v1/packs/*` → `Cache-Control: public, max-age=31536000, immutable` and `/registry/v1/*.json`, `/registry/v1/*.sig` → `Cache-Control: public, max-age=0, must-revalidate`, all with `Access-Control-Allow-Origin: *`. No server code runs; D-33 stands.

### 10.9 Bundled snapshot

- T3 bundles `registry/packs/*.json` into `packages/browserhive/dist/site-packs/packs/` at build time, with a generated `index.json`; their integrity is the release's (npm provenance, D-18).
- From T4, the release workflow runs `bun scripts/snapshot-registry.ts` before publishing: it downloads the live signed files, verifies them with the pinned keys and writes the verified layout of §10.1 to `packages/browserhive/dist/site-packs/` (covered by `"files": ["dist"]`, `packages/browserhive/package.json:31-35`). The snapshot sets the initial rollback floors of a fresh install. A snapshot that does not verify fails the release.

---

## 11. Surfaces

### 11.1 REST (`/api/v1`, admin only)

Conventions of 03 §4–§5 apply (snake_case, problem+json, `Page<T>`, cursors, `If-Match`, weak ETags). Every route below is operator-only (**S**: operator session or operator bearer). Contracts live in `packages/contracts/src/http/templates.ts` and `packages/contracts/src/http/site-packs.ts`, entries in `packages/contracts/src/http/endpoints.ts` (`ep(name, method, path, scope)`), routes in `core/src/interface/http/routes/templates.ts` and `routes/site-packs.ts` through `defineRoute` (03 §1.2).

**Templates (T1, T2)**

`TemplateSummary` = `template_id, name, display_name, status, channel, headless, sites: [{site_id, title, health_state, checked_at}], host: {state, since, pages, rss_bytes?}, in_use, cap, current_version, last_used_at, sealed, identity_drift?: {from, to}`. `Template` = §2.1 (with `proxy.password_env`, never a value). `HostView` = `{state, since, started_at, restarts, last_error?, pages, parked_pages, rss_bytes?, recycle_at?}`.

| Method | Path | Scope | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/templates` | `templates:read` | filters `status[]`, `host_state[]`, `site`, `q`; sort `name\|created_at\|last_used_at\|in_use` | `Page<TemplateSummary>` + `facets {status, host_state, health}` | — |
| POST | `/templates` | `templates:write` | `TemplateInput {name, display_name?, description?, sites: [{site_id, write_policy?}] (1–16), channel?, headless?, stealth?, fingerprint?, humanize?, proxy?: {server, bypass?, username?, password_env?, label?}, locale?, timezone_id?, geolocation?: {latitude, longitude, accuracy?}, agent_windows?, policy?: {authorized_principals?, harnesses?: string[]\|null, max_concurrent?, unseal?, health_interval_ms?, prelaunch_check?}}` | 201 `{template}` (`status: 'recording'`) | 400 `VALIDATION_FAILED` (an inline proxy credential, `locale`/`timezone_id` missing with a proxy, `headless` with a `headed: 'required'` pack, `ignoreDefaultArgs`), 409 `TEMPLATE_NAME_TAKEN` |
| GET | `/templates/{template_id}` | `templates:read` | — | `{template, host: HostView, sites: TemplateSiteView[], sessions_live, parked_pages: [{target_id, url, title, opened_at}], now}` | 404 `TEMPLATE_NOT_FOUND` |
| PATCH | `/templates/{template_id}` | `templates:write` | any `TemplateInput` field except the frozen identity + `If-Match`; `proxy` or `channel` needs `confirm_identity_change: true`; `harnesses: null` clears (D-48) | `{template}` | 400, 404, 409 `CONFLICT`, 409 `TEMPLATE_NAME_TAKEN` |
| DELETE | `/templates/{template_id}` | `templates:write` | `?force=true` closes live virtual sessions (`closed_reason: 'operator'`) | `{ok, closed_sessions, deleted_bytes}`; stops the host, deletes `templates/<id>/`; the dialog says that deleting does not sign out at the sites | 404, 409 `TEMPLATE_IN_USE` |
| POST | `/templates/{template_id}/disable`, `/enable` | `templates:write` | — | `{template}` | 404 |
| PUT | `/templates/{template_id}/sites/{site_id}` | `templates:write` (`templates:login` for `vault_handle`, `auto_relogin`) | `{enabled?, write_policy?: 'allow'\|'warn'\|'confirm'\|null, vault_handle?: string\|null, auto_relogin?, form?}`; adds the site when absent | `{site: TemplateSiteView}` | 400 (`auto_relogin` on a `human_only` site or without a binding), 404 |
| DELETE | `/templates/{template_id}/sites/{site_id}` | `templates:write` | — | `{ok}` | 404, 409 `CONFLICT` (the last site) |
| POST | `/templates/{template_id}/recording` | `templates:login` | `{sites?: string[]}` | `{session_id, host: HostView}` (the maintenance session) | 404, 409 `TEMPLATE_DISABLED`, 429 `SESSION_LIMIT_REACHED` |
| POST | `/templates/{template_id}/recording/finish` | `templates:login` | — | `{template, version}` | 404, 409 `CONFLICT` (not recording) |
| DELETE | `/templates/{template_id}/recording` | `templates:login` | — | `{ok}` (closes the maintenance session; status stays `recording`) | 404 |
| POST | `/templates/{template_id}/relogin` | `templates:login` | `{site_id, method: 'window'\|'vault'}` | `{session_id}` | 400 (`vault` without a linked binding or on a `human_only` site), 404, 409 `TEMPLATE_DISABLED` |
| POST | `/templates/{template_id}/probe` | `templates:write` | `{site_ids?: string[]}` | `{results: [{site_id, outcome, reason, duration_ms}]}` (waits, at most 120 s) | 404, 409 `TEMPLATE_DISABLED` |
| GET | `/templates/{template_id}/probes` | `templates:read` | filters `site_id`, `outcome[]`, `trigger[]`, `since`, `until`; cursor | `Page<ProbeRow>` | 404 |
| POST | `/templates/{template_id}/host/start`, `/stop`, `/restart` | `templates:write` | — | `{host}` (`restart` clears `failed`) | 404, 409 `TEMPLATE_DISABLED` |
| POST | `/templates/{template_id}/host/pages/{target_id}/close` | `templates:write` | — | `{ok}` (parked pages only) | 404 |
| POST | `/templates/{template_id}/checkpoint` | `templates:write` | — | `{version: number\|null}` (`null`: unchanged since the current version) | 404, 409 (host not running) |
| GET | `/templates/{template_id}/versions` | `templates:read` | cursor | `Page<TemplateVersionRow>` (`version, reason, restored_from, size_bytes, summary, pinned, readable, created_by, created_at`) | 404 |
| POST | `/templates/{template_id}/versions/{version}/restore` | `templates:write` | — | `{version}` (the new version) | 404 `TEMPLATE_VERSION_NOT_FOUND`, 409 `TEMPLATE_DISABLED` (`key_unavailable`) |
| PATCH | `/templates/{template_id}/versions/{version}` | `templates:write` | `{pinned: boolean}` | `{version: TemplateVersionRow}` | 404 |
| POST | `/templates/{template_id}/access/resolve` | `templates:read` | `{principal?, harness?, harness_declared?}` | `{allowed, reason?: 'principal_not_allowed'\|'harness_not_allowed', rule?}` (the D-48 tester, applied to the template rule) | 400, 404 |
| POST | `/templates/{template_id}/data-dir/reveal` | `templates:write` | — | as `POST /sessions/{id}/data-dir/reveal` (03 §4.2) | 404 |

`GET /sessions` gains the filter `template[]` (template ids), `maintenance` (`exclude`, the default, \| `include` \| `only`), the facet `templates` and the sort key `template`; `SessionSummary` gains `template?: {template_id, name, version, mode: 'live'\|'maintenance'}` and `sealed?: boolean` (present for template sessions only). `GET /sessions/{id}/timeline` gains the kind `guard` (rows of `site_guard_hits`, T3). Rate limits (03 §2): `/templates/{id}/probe` and `/templates/{id}/recording` 6/min, `/site-packs/check` 6/min.

**Site packs (T3, T4)**

`SitePackView` = `pack_id, title, domains, source, approved_version, available_version, pinned_version, enabled, pending: {to_version, classification, new_domains}\|null, used_by: [template_id], human_only, write_policy_default, stance, verified, skipped?: {version, reason}`. `RegistryStatus` = `update_check, auto_update, url, last_check_at, last_ok_at, last_outcome, index_version, index_expires_at, stale, keys_version, bundled: {version, built_at}, local: {dir, count}, skipped: [{pack_id, version, source, reason}]`.

| Method | Path | Scope | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/site-packs` | `sitepacks:read` | `q`, `source[]`, `pending` | `{data: SitePackView[], status: RegistryStatus, pending_count, now}` | — |
| GET | `/site-packs/{pack_id}` | `sitepacks:read` | — | `{view: SitePackView, pack: SitePackV1, versions: [{version, source, sha256, state}]}` | 404 `SITE_PACK_NOT_FOUND` |
| GET | `/site-packs/{pack_id}/diff` | `sitepacks:read` | `to`, `from?` (default: approved) | `{from, to, classification, new_domains, changes: [{path, from, to, class}]}` | 404 |
| POST | `/site-packs/{pack_id}/approve`, `/reject` | `sitepacks:write` | `{version}` | `{view}` | 404, 409 `SITE_PACK_UPDATE_NOT_PENDING` |
| PUT | `/site-packs/{pack_id}/pin` | `sitepacks:write` | `{version: number\|null}` | `{view}` | 400, 404 |
| PUT | `/site-packs/{pack_id}/enabled` | `sitepacks:write` | `{enabled}` | `{view}` | 404 |
| POST | `/site-packs/check` | `sitepacks:write` | — | `{outcome: 'updated'\|'not_modified'\|'failed'\|'disabled', checked_at, candidates, error?: {code, message}}` | — |
| POST | `/site-packs/reload` | `sitepacks:write` | — | `{stats}` | — |
| POST | `/site-packs/import` | `sitepacks:write` | a signed layout (`{files: {"<path>": "<base64>"}}`) or one unsigned pack (stored in `sitePacksDir`, operator trust); ≤ 1 MiB | `{imported: [{pack_id, version, classification, decision}], pending}` | 400 `SITE_PACK_INVALID`, 413 |
| GET | `/site-packs/changes` | `sitepacks:read` | `pack_id`, `decision[]`, `since`, `until`, cursor | `Page<SitePackChangeRow>` | — |
| GET | `/site-packs/strategies` | `sitepacks:read` | — | `{data: [{id, title, description, hooks, params: [{name, type, default, min, max}]}]}` | — |
| GET | `/site-guard-hits` | `sitepacks:read` | `template_id`, `session_id`, `pack_id`, `action[]`, `since`, `until`, cursor | `Page<SiteGuardHitRow>` | — |

`/attention` lists `security_intercept` requests beside attention requests (`OperatorRequestRow.kind` gains `'security_intercept'` and `options` carries `reason`, `site`, `challenge` or `guard`); `POST /attention/{request_id}/resolve` decides them (`resolve` = approve, `reject` = deny).

### 11.2 OpenAPI

Generated as today (`bun run gen:openapi`, `scripts/gen-openapi.ts`), checked by the OpenAPI golden; every new route has a problem+json response and every list route the shared `Page<T>` envelope (09 §3.1). The auth-matrix and list-golden tests gain the new routes.

### 11.3 WebSocket topics and bus events

| Topic | Scope | Event types → payload |
|---|---|---|
| `templates` | `templates:read` | `template.changed {template: TemplateSummary}`, `template.removed {template_id}`, `template.host {template_id, host: HostView}`, `template.health {template_id, site: TemplateSiteView}`, `template.version {template_id, version: TemplateVersionRow}` |
| `site-packs` | `sitepacks:read` | `site_pack.changed {view: SitePackView}`, `site_pack.pending {pack_id, to_version, classification}`, `site_packs.status {status: RegistryStatus}` |

`WS_STATIC_TOPICS` (`packages/contracts/src/ws/topics.ts:6-18`) gains both. Session events are unchanged; template sessions' `SessionSummary` carries `template`. Bus events: `template.created`, `template.updated`, `template.deleted`, `template.host.changed`, `template.health.changed`, `template.probe.completed`, `template.version.created`, `site_pack.changed`, `site_packs.checked`, `site_guard.hit`, plus the broker's existing `attention.*` events for `security_intercept` requests (`kind` in the payload).

### 11.4 Dashboard

Routes (file-based, 04 §3): `_auth/templates.tsx`, `templates_.new.tsx`, `templates_.$id.tsx`, `site-packs.tsx`, `site-packs_.$id.tsx`; features `src/features/templates/` and `src/features/site-packs/`, reusing `features/vault/harnesses` (`HarnessRuleField`). Navigation (04 §6.1): **Templates** (order 25, badge: the number of sites that need a sign-in) and **Site packs** (order 26, badge: pending updates). Doc links go through `lib/links.ts`. Every page is checked in a real Chrome at 390, 768, 1280 and 1920 px (04 §1).

- **`/templates`**: header with **New template**; the pending-updates banner (§10.6); a table (cards under 768 px) of Template (display name, `name` in mono), Sites (one chip per site with its health dot: signed in, signed out, check needed, couldn't tell, not checked), Host (state dot and pages), Sessions (`in_use / cap`), Last used, and a kebab (Open, Re-login…, Restart host, Disable, Delete…). Empty state: what a template is, the three steps, **New template**.
- **`/templates/new`**: the wizard of §7.1, one step per screen, with Back/Next, the site catalog as a searchable grid of pack cards (title, domains, `human_only`, write policy, terms stance) plus "Add another site", and the sign-in step showing per-site ticks live over the `templates` topic.
- **`/templates/$id`**: header (display name, status pill, host state with Start/Stop/Restart, **Re-login** menu per site, Disable, Delete…). Tabs (`?tab=`): **Sites** (default; a card per identity provider group: health with reason and last check, **Check now**, **Re-login**, write policy select with the pack's clause and stance, linked vault binding and auto-relogin switch, guard and challenge counts, `device_bound` badge), **Sessions** (live and recent virtual sessions of the template, maintenance sessions marked "BrowserHive"; parked pages with Close), **Versions** (reason, size, per-domain summary, readable, Restore…, Pin), **Access** (principals, Harnesses field with D-48's note and warnings, cap, sealing switches each with its consequence, the access tester), **Settings** (the pinned identity read-only, the identity-drift banner, proxy with "this may sign you out" confirmation, channel, headless warning, agent windows, health interval, pre-launch check, data-directory reveal), **Activity** (probes and site-guard hits, filterable).
- **`/site-packs`**: tabs **Catalog** (pack, domains, source, approved version, used by, verified, enabled switch; skipped versions with reasons), **Updates** (one card per pending update: classification chip, diff with loosening fields and new domains highlighted, Approve / Reject / Pin), **History** (`site_pack_changes`); a **Registry** card (update check on/off with the configuration key that controls it, URL, last check and outcome, index version and expiry, stale warning, **Check now**, **Import…**).
- **`/site-packs/$id`**: every section of the pack as readable text (sign-in URL in full, probe, guards table with methods, challenges, pacing with official/vendor labels and sources, strategies with their parameters, terms clause with its date and link, verified dates, sources), versions and history.
- **Elsewhere**: the session page shows a "Template: <display name>" badge and a "sealed" pill, explains on the Files tab that tracing is off for template sessions, and shows the template's identity; `/sessions` gains the Template facet chip and "· <template>" on the session line; `/attention` labels `security_intercept` requests "Site check" or "Write approval"; `/system` lists running hosts in Capacity.

### 11.5 CLI

Every command talks to a running server over the REST API with `--url` (default `http://127.0.0.1:<port>` from the resolved configuration), `--token` (an operator bearer with the scopes the command needs) or `--cookie`, like `channels` (08 §7.1); `--json` everywhere. Exit codes: 0 success; 1 failure (server unreachable or an API error, printed `[CODE] message`); 2 completed with attention needed (`templates probe` with a site not signed in, `sitepacks check` with updates pending, `templates create` finishing with a site not signed in); 64 usage error.

```
browserhive templates list
browserhive templates show <name>
browserhive templates create <name> --sites <site,…> [--display <text>] [--description <text>] [--channel <chromium|chrome|edge>]
                              [--headless] [--stealth <off|standard|max>] [--proxy <url> --proxyUser <name> --proxyPasswordEnv <ENV>]
                              [--locale <tag> --timezone <iana>] [--cap <1-20>] [--no-login] [--timeout <duration>]
browserhive templates finish <name>
browserhive templates login <name> --site <site> [--method window|vault] [--timeout <duration>]
browserhive templates probe <name> [--site <site>]
browserhive templates versions <name>
browserhive templates restore <name> <version> [--yes]
browserhive templates host <name> start|stop|restart
browserhive templates disable|enable <name>
browserhive templates rm <name> [--force] [--yes]
browserhive sitepacks list | show <id> | check | diff <id> [--to <version>]
browserhive sitepacks approve <id> [--version <n>] | reject <id> [--version <n>] | pin <id> <version> | unpin <id>
browserhive sitepacks enable <id> | disable <id> | import <dir|file> | export <dir>
browserhive sitepacks verify <path>
```

`templates login` and `templates create` open windows on the machine running the server, wherever the CLI runs. `restore` and `rm` ask for confirmation on a terminal and refuse without one unless `--yes`. `sitepacks verify` is offline: it checks a pack file or a signed layout with the schema and the pinned keys and needs no server. `--timeout` defaults to `30m`.

### 11.6 Configuration keys (08 §5.9)

All boot keys (08 §5); env names are mechanical (`BROWSERHIVE_TEMPLATE_KEY`, …).

| Key | Type | Default | Validation / notes | Consumer |
|---|---|---|---|---|
| `templates` | boolean | `true` | `false`: the `templates` tool pack answers `TOOL_NOT_AVAILABLE`, `launch_session.template` answers `TEMPLATE_NOT_FOUND`, hosts never start | template service |
| `templateKey` | string · **secret** | — | base64 of exactly 32 bytes; absent → `<data-dir>/admin/template.key` (§2.4) | template state store |
| `templateHostIdleTimeout` | duration | `1h` | `0` = never stop an idle host | host supervisor |
| `templateMaxPagesPerHost` | integer 2–200 | `40` | §6.3 | admission |
| `templateHealthInterval` | duration `30m`–`7d` | `6h` | default for new templates | health scheduler |
| `templateCheckpointInterval` | duration ≥ `1m` | `15m` | §3.9 | host supervisor |
| `templateVersionsKeep` | integer 1–100 | `10` | pinned versions are kept in addition | template state store |
| `templateRecycleAfter` | duration ≥ `1h` | `24h` | §3.2 | host supervisor |
| `templateRecycleRss` | bytes ≥ `512MiB` | `3GiB` | §3.2 | host supervisor |
| `templateDrainTimeout` | duration `1m`–`2h` | `15m` | §3.2 | host supervisor |
| `sitePacks` | boolean | `true` | `false`: no pack data is used and no update check runs (§9.6) | site-pack registry |
| `sitePacksUpdateCheck` | boolean | `true` | the only default outbound request (D-55); `false` for air-gapped or opted-out hosts | registry client |
| `sitePacksAutoUpdate` | boolean | `false` | `true`: tightening and neutral updates apply without approval; loosening and new domains still wait | site-pack registry |
| `sitePacksUrl` | url | `https://browserhive.ai/registry/v1/` | `https:` only; a mirror must serve the same signed files | registry client |
| `sitePacksDir` | path | `<data-dir>/site-packs/local` | operator packs (§10.5) | site-pack registry |

`persistence=blueprint` and the key `profiles` stay reserved (08 §5.4): templates are not a persistence mode.

### 11.7 Metrics and spans

Instruments (rows join the catalogue of 10 §7 with the PR that records them; the guard test of 09 §3.2 keeps the two equal):

| Instrument | Type | Unit | Attributes | Recorded | PR |
|---|---|---|---|---|---|
| `browserhive.template.hosts` | gauge (observable) | `{host}` | `state` (`starting`, `running`, `draining`, `crashed`, `failed`) | hosts per state at each export | T1 |
| `browserhive.template.checkpoints` | counter | `{checkpoint}` | `reason` (`recording`, `checkpoint`, `relogin`, `shutdown`, `restore`) | once per written version | T1 |
| `browserhive.template.probes` | counter | `{probe}` | `outcome` (`signed_in`, `signed_out`, `challenged`, `inconclusive`), `trigger` (`schedule`, `prelaunch`, `recording`, `relogin`, `manual`, `host_start`, `attention`) | once per probe | T2 |
| `browserhive.template.relogins` | counter | `{relogin}` | `method` (`window`, `vault`, `attention`), `outcome` (`signed_in`, `failed`, `timeout`) | once per finished re-login | T2 |
| `browserhive.site_guard.hits` | counter | `{hit}` | `action` (`block`, `confirm`, `warn`, `paced`, `held`), `kind` (`logout`, `account`, `destructive`, `write`, `stop`) | once per `site_guard.hit` | T3 |
| `browserhive.site_challenges` | counter | `{challenge}` | `kind` (`checkpoint`, `captcha`, `reauth`, `locked`, `rejected`) | once per detected challenge | T3 |
| `browserhive.site_packs.checks` | counter | `{check}` | `outcome` (`updated`, `not_modified`, `failed`, `stale`) | once per update check | T4 |

Changes to existing instruments (T1): `browserhive.sessions.active` and `browserhive.session.launch.duration` gain the attribute `mode` (`exclusive`, `virtual`, `maintenance`); `browserhive.browser.rss_bytes` reports one series per running host with the attribute `template_id` and none per virtual session (a host's sessions share its process tree). Pack ids, site ids and template names are never metric attributes.

Spans (10 §6): `template.host.start` (`browserhive.template_id`, `browserhive.channel`, `browserhive.headless`), `template.host.stop` (`browserhive.reason`), `template.attach` (child of `session.launch` for a virtual session), `template.probe` (`browserhive.site`, `browserhive.outcome`), `template.checkpoint` (`browserhive.version`), `template.restore`, `site_packs.check` (`browserhive.outcome`, `browserhive.index_version`); `site_guard.decide` only under `--otelVerbose`.

### 11.8 Audit

`operator_actions` rows (03 §7, audit class), `resource_kind` `template` or `site_pack`: `template.create`, `template.update` (with the changed field names; `unseal` and `access` changes named explicitly), `template.delete`, `template.disable`, `template.enable`, `template.record.start`, `template.record.finish`, `template.record.cancel`, `template.relogin`, `template.probe`, `template.host.start`, `template.host.stop`, `template.host.restart`, `template.page.close`, `template.checkpoint`, `template.version.restore`, `template.version.pin`, `sitepack.approve`, `sitepack.reject`, `sitepack.pin`, `sitepack.enable`, `sitepack.disable`, `sitepack.import`, `sitepack.check`. Automatic decisions (auto-update, revocations) are `site_pack_changes` rows with `decided_by: 'browserhive'`. Guard decisions are `site_guard_hits` rows (§9.9); vault auto-relogin fills are `vault_access` rows on their maintenance session.

### 11.9 `doctor`

New checks (08 §7.1), each skipped when no template exists unless stated:

| Check | ✓ | ! (warning) | ✗ |
|---|---|---|---|
| `templates data` | `templates/` 0700, version files 0600 | modes broader | `templates/` unreadable |
| `template key` | the key resolves (`templateKey` or the key file, 0600) and every version's `key_id` matches | key file broader than 0600; versions with another `key_id` | versions exist and no key resolves |
| `template display` | every headed template can open a window (`Desktop.hasDesktopEnvironment()`) | — | a headed template and no display; prints the Xvfb, LaunchAgent and interactive-session guidance |
| `template browsers` | every template's channel is installed | identity drift (major changed since creation) | a template's channel is missing (names the install command) |
| `template proxies` | every `password_env` is set | — | a named variable is unset (names it, never a value) |
| `site packs` (always) | the bundled snapshot verifies; status of the update check | update check on: "checks <sitePacksUrl> every 24 h; sends nothing about this install"; stale index; pending updates; skipped packs | the bundled snapshot does not verify |

### 11.10 Retention, purge, backups and init

| Class (03 §7.1) | Tables / files | Rule |
|---|---|---|
| configuration | `templates`, `template_sites`, `site_pack_state` | never pruned |
| template versions | `template_versions` + `versions/*` | the newest `templateVersionsKeep` plus pinned (§3.9) |
| telemetry | `template_probes` | `retentionDays` |
| audit | `site_pack_changes`, `site_guard_hits` | `auditRetentionDays`; never byte-pruned |
| artifacts | `templates/<id>/` | deleted with the template |

- `purge`: `templates` (signed-in browsers: "Session templates (signed-in browsers and their versions)") and `site-packs` join the `--all` targets (`packages/core/src/app/maintenance/purge.ts:13-15`, `packages/browserhive/src/cli/commands/purge.ts:22-35`); purging the database alone while `templates/` exists warns that the template directories will be orphaned and names `--all`.
- Backups (`db backup`, pre-migration backups) contain the template rows, not the files. Backing up a template means copying `templates/<id>/` together with the key (`admin/template.key` or the `templateKey` value); `docs/guide/templates.md` says so. Encrypted export and import are deferred (§16).
- `init` and boot create `templates/` and `site-packs/` (`DATA_SUBDIRS`, `packages/browserhive/src/composition/data-dir.ts:11`), so `doctor` does not flag them as unrecognised (`packages/browserhive/src/cli/commands/doctor-checks.ts:288`); D-24's layout gains both.

---

## 12. Error registry entries

Registry entries in `packages/contracts/src/errors/codes-session.ts` (tool surface) and `codes-service.ts` (REST), with `title`, `hint`, `cause` and `resolution` prose for `docs/reference/errors.md` (10 §1). Public messages of tool-surface codes are contract once published (10 §1.1).

| Code | HTTP | Category | Retryable | Details | Public message | PR |
|---|---|---|---|---|---|---|
| `TEMPLATE_NOT_FOUND` | 404 | domain | different_args | `{template}` | `No session template named '<name>'. Use list_templates to see the templates you can use.` (identical for unknown, unauthorized and still-recording templates) | T1 |
| `TEMPLATE_BUSY` | 429 | domain | backoff | `{template, in_use, cap, limit_kind: 'sessions'\|'pages'\|'site_actions'\|'schedule', retry_after_ms?}` | `Template '<name>' is at its limit (<in_use> of <cap>). Retry later, or close a session you no longer need.` | T1 |
| `TEMPLATE_NEEDS_LOGIN` | 409 | domain | after_operator | `{template, sites[]}` | `Template '<name>' is signed out of <sites>. The operator has been asked to sign in again; retry after that.` | T2 |
| `TEMPLATE_UNAVAILABLE` | 503 | domain | backoff | `{template, reason: 'starting'\|'restarting'\|'crashed', retry_after_ms}` | `Template '<name>' is restarting its browser. Retry in a few seconds.` | T1 |
| `TEMPLATE_DISABLED` | 409 | domain | after_operator | `{template, reason: 'disabled'\|'host_failed'\|'no_display'\|'proxy_unreachable'\|'key_unavailable'}` | `Template '<name>' cannot be used until the operator fixes it (<reason>).` | T1 |
| `SESSION_SEALED` | 403 | domain | never | `{session_id, tool}` | `<tool> is not available in this session: its sign-ins belong to the operator's session template.` | T1 |
| `SITE_OPERATOR_PENDING` | 409 | domain | after_operator | `{session_id, site, request_id, reason: 'challenge'\|'write_confirm'}` | `<site> is waiting for the operator (<reason>). Wait with get_attention_result('<request_id>'), or close the session.` | T3 |
| `SITE_ACTION_BLOCKED` | 403 | domain | never | `{session_id, site, guard}` | `This action on <site> is blocked by the operator's site rules. Do not retry it.` | T3 |
| `TEMPLATE_NAME_TAKEN` | 409 | domain | different_args | `{name}` | REST only | T1 |
| `TEMPLATE_IN_USE` | 409 | domain | different_args | `{template_id, live_sessions}` | REST only (`?force=true` closes them) | T1 |
| `TEMPLATE_VERSION_NOT_FOUND` | 404 | domain | never | `{template_id, version}` | REST only | T1 |
| `SITE_PACK_NOT_FOUND` | 404 | domain | never | `{pack_id}` | REST only | T3 |
| `SITE_PACK_INVALID` | 400 | domain | different_args | `{source, issues: [{path, message}]}` | REST and CLI | T3 |
| `SITE_PACK_UPDATE_NOT_PENDING` | 409 | domain | never | `{pack_id, version}` | REST only | T4 |
| `TEMPLATE_HOST_FAILED` | — | boot | never | `{template_id, reason, attempts}` (degradation record, 10 §3) | | T1 |
| `TEMPLATE_KEY_MISMATCH` | — | boot | never | `{template_id, versions[]}` (degradation record) | | T1 |
| `SITE_PACKS_STALE` | — | boot | never | `{index_version, expired_at}` (degradation record, warn) | | T4 |
| `SITE_PACKS_FETCH_FAILED` | — | boot | backoff | `{failures, last_error}` (degradation record, warn) | | T4 |
| `TEMPLATE_SITE_SIGNED_OUT`, `SITE_GUARD_WARNED`, `SITE_PACED` | — | warning | — | `{session_id, message, details}` (SessionWarning) | | T2, T3 |

`launch_session` documents `TEMPLATE_NOT_FOUND`, `TEMPLATE_BUSY`, `TEMPLATE_NEEDS_LOGIN`, `TEMPLATE_UNAVAILABLE` and `TEMPLATE_DISABLED`; `new_tab` documents `TEMPLATE_BUSY`; `set_cookies` and `save_storage_state` document `SESSION_SEALED`; page and interaction tools document `SITE_OPERATOR_PENDING`, and `click`/`press_key` `SITE_ACTION_BLOCKED`. Each is a new typed code where a generic failure was possible, so additive (D-12).

---

## 13. Security considerations

- **A template is a bearer credential** that bypasses the password and MFA of every site in it. Agents may use the sign-ins but not read or export them (sealing, §5.4); the operator decides who may launch it (§6.1); every operator action is audited (§11.8).
- **The isolation boundary of live mode is page attribution** (§3.4), not a process. A bug there lets one agent drive another's page; T0 lands the split behind property tests before any template exists (§17).
- **Shared state is shared by design.** One agent's sign-out signs everyone out, and an unsealed agent's `evaluate` can clear storage for all; packs guard logout and account pages, and sealing keeps `evaluate` off by default.
- **The operator is trusted and present.** A headed host's real windows are outside the takeover gate (D-10): whoever sits at that desktop can use them. Hosts run on the operator's machine.
- **At rest**: versions are encrypted; the live profile is protected by file modes only (§2.4).
- **Publisher trust** is bounded by signatures, expiry, rollback floors, the schema's constraints and the operator's approval of loosening changes (§9.10, §10.3); a compromised registry can at worst withhold updates, which shows as `SITE_PACKS_STALE`.
- **Outbound traffic**: one anonymous conditional `GET` of public files every 24 h while templates exist and the check is on; nothing about the install is sent (D-55).

---

## 14. Testing

Conventions of spec 09 apply (colocated `bun test` units with fakes and an injected clock; real-Chromium integration suites in `packages/core/test/integration/`; dashboard component tests with axe; Playwright end-to-end; contract goldens). The suites each PR adds are listed with it in §17. Three are invariants in the sense of 09: **page attribution** (§3.4; property-tested on the fake host model with fast-check, 1 000 cases in the fast suite and 100 000 nightly, and against real Chromium), **sealing** (no cookie value of a template session in any agent-facing result, by a sentinel cookie), and **pack data never executes** (a malicious-pack corpus: every abuse row of §9.10 is a fixture that must be refused or rendered inert).

---

## 15. Non-goals

- Several concurrent copies of one template's cookie jar (fork mode). Concurrent copies sign each other out (Google supersedes a copied snapshot in about 10 minutes; refresh-token rotation with reuse detection revokes the whole family, RFC 9700 §4.14.2) and device-bound sessions cannot be copied at all.
- Code delivered through packs or the registry (scripts, selectors evaluated as script, launch arguments, regular expressions).
- Sending anything about an install to browserhive.ai: no telemetry, no install id, no per-site requests.
- Agents creating, changing or exporting templates.
- Solving challenges automatically: a challenge is handed to a human.

## 16. Deferred

| Item | Why deferred | Seam that keeps it open |
|---|---|---|
| Serial checkout (one copy at a time under an exclusive lease, written back on close; for headless servers and isolation) | live mode covers the concurrent case; a lease and write-back are a separate design | `template_mode` is an open set (`serial` reserved); `device_bound` blocks it per site |
| Per-page trace split for virtual sessions | a host tracer records every agent; splitting by `pageId` and redacting vault fills by time needs its own design | `BrowserHost.tracing` is `null` for template hosts |
| Recording and re-login through the dashboard live view | live-view input lacks clipboard, IME and tab switching (04 §16) | the maintenance session already has a live view |
| Packs for exclusive sessions and as stealth defaults | the owner's later step; needs per-session owner resolution everywhere | the request guard and the registry are session-agnostic |
| Encrypted export and import of templates | key handling across machines; `device_bound` sites cannot move | the envelope format of §2.4 carries `key_id` |
| Encrypting saved auth states | separate migration of existing files | `TemplateKeyProvider` |
| A warm pool of hosts, staged pack rollouts, community packs without owner review | not needed for v1 | — |

---

## 17. The PR program

Each PR is its own branch and pull request (spec 07), with a changeset, its tests and its docs; the owner merges between PRs. "Docs" lists hand-written guides; generated references (`bun run gen:docs`, `gen:openapi`, `gen:db-types`) are regenerated in every PR that changes their sources.

### T0 — Prerequisites (three PRs, no template code)

**T0a. Auth-state names are scoped per principal.** *Scope*: today `save_storage_state` and `save_full_profile` never check an existing manifest, so principal B saving a name A uses overwrites A's snapshot and takes ownership (`packages/core/src/app/auth-states/store.ts:139-190`; ownership is checked only on read, `:295-300`). Snapshots of principals other than `local` move to `auth-states/p/<first 16 hex chars of SHA-256(subject)>/<name>.*`; `local` keeps the flat layout; a manifest found in the flat layout with a non-`local` owner is moved into its owner's directory on first access. *Acceptance*: B saving A's name creates B's own snapshot and leaves A's untouched; `list_saved_auths` and restores see only the caller's; existing files keep working. *Tests*: store unit tests for the overwrite, the migration on first access and the no-oracle list; the integration auth-states suite with two principals. *Docs*: `docs/guide/security.md` (auth states), spec 02 §6 (already amended).

**T0b. A method-aware request guard in the interception chain.** *Scope*: `RequestGuard` (pure matcher over `{methods, url glob, resource_types, action}` rules) as `InterceptionChain` handler #2 after the blocklist; per-request owner resolution (`resolveOwner(request)`: the fixed session for exclusive hosts); `route.fallback()` hand-off; fail-closed for blocking decisions, fail-open for observation; the `site_guard_hits` writer behind a port with no rules configured. *Acceptance*: with a test rule, a `POST` form logout, a `fetch` `POST` and a `GET` document are each matched or not by method and resource type; the blocklist behaves byte-for-byte as before; a handler exception aborts documents. *Tests*: matcher table tests; `blocklist-route` regression tests; an integration test against the fixture server (09 §9) with form and `fetch` posts. *Docs*: spec 11 §5 note (already amended).

**T0c. `BrowserHost` / `SessionView` split, no behaviour change.** *Scope*: §3.13; `PlaywrightSessionHandle` becomes an exclusive host plus its one view; every reach-in listed in §3.13 moves behind the view; the page-attribution dispatcher exists with one view per host. *Acceptance*: every existing unit, integration and end-to-end suite passes unchanged; no tool imports `BrowserContext`; `isolation.test.ts` passes on the three OSes. *Tests*: the attribution property suite on a fake host model (operations: open view, new tab via claim, `window.open`, `noopener` popup, service-worker window, operator window, close tab, close view, page crash, host crash; invariants of §3.4); `FakeSessionHandle` becomes `FakeSessionView` over `FakeBrowserHost` (09 §4). *Docs*: `docs/contributing/architecture.md`.

### T1 — Templates, live mode, sealing, recording (one PR, or two if review needs it: core then surfaces)

*Scope*: §2 (object, identity, storage, encryption, migration `0008`), §3 (host, supervisor, windows, attribution with N views, close, crash fan-out, pipeline, interception ownership, checkpoints, versions, restore, flags, displays), §4, §5 (`list_templates`, `launch_session.template`, option rules, sealing, tracing off, tool table), §6 (access with the moved `AuthorizationRule`/`checkHarnessRules`, scopes `templates:*`, capacity), §7 (recording: dashboard wizard steps 1–5 without the pack catalog, which shows domains only until T3; CLI `templates create|finish|list|show|rm|disable|enable|host|versions|restore`), the T1 rows of §11 and §12, `doctor` checks except `site packs`, purge/init.

*Acceptance*:
- Three agents launch from one template, each gets its own window; `list_tabs` of each shows only its pages; a `target=_blank` link and a `window.open` popup land in the opener's session; an operator-opened window and a service-worker window are parked; `close_session` closes only that session's windows and the host survives; killing the host's browser fails all three with `SESSION_DEAD` and the host restarts.
- Cookies set by a site in one session are visible to the others; `get_cookies` returns empty values and `sealed: true`; `evaluate` answers `EVALUATE_DISABLED`; `set_cookies` and `save_storage_state` answer `SESSION_SEALED`; unsealing each flag changes exactly that behaviour.
- Conflicting `context_options`/`launch_options` are refused with `INVALID_ARGUMENTS` naming each option; equal values and the five defaulted parameters pass.
- The cap, the page cap and the host slot are enforced with the typed codes; an unauthorized principal or harness gets `TEMPLATE_NOT_FOUND` and does not see the template in `list_templates`.
- A recording on a headed Linux desktop and under Xvfb produces version 1, encrypted (the file does not contain a cookie name in clear text; it decrypts only with the key and AAD); restore works; a key mismatch is reported, not crashed on.
- The identity seed and locale/timezone survive host restarts and a moved host (a changed `TZ`).
- Background tabs and minimized windows report `visible`, take screenshots and stream the live view.

*Tests*: unit (template service, admission order and codes, option-conflict table, access rule with D-48's cases reused, envelope encryption with tampered AAD/tag/key id, checkpoint hashing and retention, supervisor state machine with a fake clock and fake host, the migration `v7.db → v8` with fixture and golden); contract goldens (`list_templates.json`, the changed `launch_session.json`, `get_cookies.json`, OpenAPI, WS, config schema, errors); HTTP route tests and the auth matrix; integration `templates-live.test.ts` (the acceptance list above, real Chromium, headed under Xvfb on Linux CI and headless elsewhere), `template-attribution.test.ts` (real-Chromium version of the property suite's scenarios), `template-sealing.test.ts` (sentinel cookie absent from every agent-facing result); dashboard component tests with axe for the list, wizard and template page; Playwright e2e: create a template against the fixture site, sign in through the window, see the tick, launch from an agent over MCP. *Docs*: `docs/guide/templates.md` (new: concepts, recording, agent usage, what agents can observe, displays and Xvfb, backups and keys), `docs/guide/security.md` (templates as credentials, encryption scope), `docs/guide/dashboard.md`, `docs/guide/cli.md`, `docs/guide/configuration.md`, `docs/guide/mcp-clients.md` (agent usage of `list_templates`).

### T2 — Health, notifications, re-login, versions

*Scope*: §8 (probes with the generic site logic and pack-shaped data structures, pre-launch check, schedule, re-login by window, attention and vault, notifications and act ops, version list and pin in the dashboard); the T2 rows of §11 and §12.

*Acceptance*: against fixture sites that redirect, show a landmark, show a challenge interstitial and time out, the four outcomes are produced and a challenged probe never starts a re-login; a sign-out produces exactly one `template.signed_out` notification per identity provider that resolves itself after a re-login; the Re-login act button opens the window; an auto-relogin fills once, writes one `vault_access` row on its maintenance session and is not retried within 24 h; `TEMPLATE_NEEDS_LOGIN` only when every site is out.

*Tests*: probe classifier table tests; scheduler on a fake clock (jitter, sequencing, two-host limit, host start for a probe); producer tests for the new kinds (contract validation, thread revisions, redaction sentinel); the vault broker with a linked binding (gates satisfied by the link, origin gate, confirm on the maintenance session); integration `template-health.test.ts` with the fixture server; dashboard tests for the Sites and Versions tabs. *Docs*: `docs/guide/templates.md` (health, re-login), `docs/guide/notifications.md` (new kinds), `docs/guide/vault.md` (auto-relogin).

### T3 — Site packs, local

*Scope*: §9 except §10 (schema and `refinePack()` in contracts, `SitePackSource` bundled and local, `SitePackRegistry`, the closed strategy set, guards in both paths, write policies, challenges with `security_intercept` and migration `0009`, pacing, element guards, `human_only` in the vault, classification, the catalog in the wizard, the Site packs page without the Updates tab's remote parts, `sitepacks list|show|diff|enable|disable|verify`); the bundled packs of §9.8, every shipped field verified against a live signed-in session (recorded in each pack's `verified`).

*Acceptance*: a LinkedIn-shaped fixture pack blocks a `GET` logout navigation (`URL_BLOCKED`), a form-`POST` logout and a `fetch` logout (network aborts with audit rows); a write under `confirm` is held until approved on `/attention` and aborted on deny or after 10 min; a Cloudflare-style interstitial raises one `security_intercept` request, holds the session's tools with `SITE_OPERATOR_PENDING`, permits takeover input and resumes after resolution; pacing holds or aborts as specified; every row of §9.10's abuse table is refused or inert.

*Tests*: schema and refinement tables (every constraint, every bound); the malicious-pack corpus; classifier per field; each strategy with a fake clock; request-guard integration with the fixture server; challenge detection with fixture pages; the `v8.db → v9` migration with the `operator_requests` rebuild (data preserved, CHECK extended, `min_reader_version` 9); `registry.test.ts` over `registry/packs/*.json`; dashboard tests for the catalog and pack pages. *Docs*: `docs/guide/site-packs.md` (new: purpose, what a pack contains, write policies, challenges, local packs, verifying a pack), `docs/guide/templates.md`, `docs/guide/security.md`.

### T4 — Remote registry, signing, update experience, website

*Scope*: §10 (registry client with the TUF-lite verification, polling, cache, import/export, approvals and auto-update, the Updates tab, banner and notification, `sitepacks check|approve|reject|pin|unpin|import|export`), the `registry/` publishing pipeline (`registry-check`, `registry-sign` in the `registry-signing` environment, weekly re-sign, `scripts/registry-keys.ts`), the website deploy change (§10.8), the release snapshot (§10.9), D-55's disclosure in `doctor`, the wizard and `docs/guide/security.md`.

*Acceptance*: against a local static server holding a signed test registry: a valid update becomes a pending candidate with the right classification; an expired index, a rolled-back index, a fast-forwarded index, a wrong online key, a swapped pack file, an oversized file and an unknown key are each refused with the state unchanged; `304` costs no download; requests carry no cookie, query or version; with `sitePacksUpdateCheck=false` no request is made (asserted by a server that fails the test on any request); `sitepacks export` then `import` on an offline host yields the same candidates; a release build refuses the preview test key.

*Tests*: unit tests for every verification step and the floors; `registry-client.test.ts` against a `Bun.serve` fake registry; the signing scripts' round trip; workflow lint for the new jobs; dashboard tests for the Updates tab with axe; a Playwright path banner → Updates → Approve. *Docs*: `docs/guide/site-packs.md` (updates, approval, air-gapped use, mirrors), `docs/guide/security.md` (outbound request, trust chain), `docs/contributing/registry.md` (new: how to propose a pack change, review, key operations).

### T5 — Later

The deferred items of §16, each as its own spec change and PR series.

---

## 18. Open questions

Questions this spec could not settle from the decisions on record, each with the recommended answer the spec currently follows:

1. **The operator-request rebuild in v9 is incompatible** (`min_reader_version` 9), so downgrading below the T3 release needs a database restore. *Recommended*: accept it, as D-04 allows, and say so in the release notes. The alternative, raising challenges as `attention` requests marked in `options`, stays compatible but reuses the agent-initiated kind for something no agent asked for and leaves D-15's reserved kind unbuilt.
2. **The update check runs only while at least one template exists.** The owner's answer turns the check on by default; with no template nothing uses packs, so this spec makes no request then. *Recommended*: keep it; the first template creation runs a check.
3. **Default write policy for X.** The site catalog suggested `warn`; the accepted Q12 answer (confirm what a site's terms reserve for humans) and X's terms (scripting the website is prohibited and may lead to permanent suspension) point to `confirm`. *Recommended*: `confirm` for posts, replies, DMs, follows and likes, as in §9.8; the operator can relax it per template.
4. **`TEMPLATE_NEEDS_LOGIN` when only some sites are signed out.** *Recommended* (as specified): refuse only when every enabled site is out; otherwise launch, report site status in `template.sites` and warn on the dashboard, because the agent's task may need only the signed-in site.
5. **Default access of a new template.** *Recommended* (as specified): any principal and all harnesses, shown explicitly in the wizard, because under `auth=off` there is one principal anyway and a template nobody may use is a confusing first experience.
