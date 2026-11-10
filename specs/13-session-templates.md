---
title: "Session templates and site packs"
spec: "13"
status: Normative
scope: Session templates (a signed-in browser identity an operator records once and agents launch sessions from), live mode (one shared browser per template, one window per agent session), sealing, template access, health and re-login, versions, and site packs (signed per-site data selecting from strategies compiled into the binary) with their registry on browserhive.ai; the prerequisite security fixes that apply to every session; every surface they add, and the PR program that delivers them.
audience: Contributors implementing templates or site packs; reviewers of the session model, the interception chain and the registry trust chain; operators and agent authors who want the exact contract.
related:
  - 00-decisions.md
  - 01-overall-architecture.md
  - 02-mcp-and-tools.md
  - 03-admin-backend.md
  - 04-admin-frontend.md
  - 06-ci-cd-local-dev.md
  - 08-cli-arguments-and-config.md
  - 09-testing.md
  - 10-error-handling-and-telemetry.md
  - 11-stealth.md
---

# 13 — Session Templates and Site Packs

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: the prerequisite fixes that apply to every session (§17, T0), the template object and its storage, live mode (one shared browser per template), the agent surface (`list_templates`, `launch_session.template`, sealing), template access, the recording workflow, health and re-login, versions, site packs and their registry, every REST/WS/dashboard/CLI/config/telemetry surface they add, and the PR program (§17). Decisions: D-49 (templates are their own object), D-50 (live mode and the shared-browser session model), D-51 (sealing and tracing), D-52 (template access), D-53 (template state at rest), D-54 (site packs are data selecting from a closed strategy set), D-55 (registry delivery and update policy), D-56 (capacity accounting), D-57 (agent-requested URLs are limited to web schemes), D-58 (a vault fill writes the password only into a password input).

**Implementation status.** This spec describes the target design. It is delivered by the PRs of §17; until a PR lands, the current behaviour of the other specs applies to what that PR changes. Each section names the PR that delivers it where that is not obvious. Code references (`file:line`) point at `main` @ `72f20e7` (schema v7, 43 tools) unless they name another commit. Release 0.2.3 (`main` @ `96c572a`) shipped the T0 fixes T0a, T0d, T0e and T0f (§17) and migration v8 (`0008-operator-token-scopes`, data only, 03 §7), so this program's migrations are v9 and v10, and references into files those PRs changed (`auth-states/store.ts`, `token-ops.ts`, `policies.ts`, the navigation, tab and vault tools, `migrations/index.ts`) may have moved. T0b and T0c ship as standalone PRs ahead of the rest of the program.

---

## 1. Concepts

### 1.1 Glossary

| Term | Meaning |
|---|---|
| **Session template** (template) | An operator-owned, named browser identity: a pinned fingerprint, network and locale, a persistent Chromium profile signed in to one or more sites, a policy, versions and per-site health. Identified by `tp-<nanoid10>`, addressed by agents by its `name`. |
| **Site** | One registrable domain a template is signed in to, for example `linkedin.com`, computed by `registrableDomain(host)`: a helper T1a exports from `packages/core/src/kernel/url.ts`, wrapping the private `registrable()` there (`:57-60`, tldts `getDomain` with `allowPrivateDomains: false`, the vault's origin semantics). Consequence: hosts under a private suffix collapse into one site (`a.github.io` and `b.github.io` are both `github.io`). |
| **Template host** (host) | The one long-lived browser of a template: a persistent context on `<data-dir>/templates/<id>/userdata`, headed by default, with a sentinel window. At most one host per template exists at a time. |
| **Sentinel window** | The host's first window, never attributed to any session, kept open so the browser survives having no sessions (a persistent context exits when its last page closes). Recreated when closed while other pages exist (§3.2). |
| **Live mode** | The only concurrent template mode: every session launched from a template is a virtual session of its host. |
| **Virtual session** | A session (`<slug>-<nanoid8>`, a normal `sessions` row) that owns a set of windows and pages of a host instead of a browser of its own. It shares the host's cookie jar, storage, fingerprint and IP with its siblings. |
| **Exclusive session** | Every session that is not virtual: one browser and one context of its own, as before (D-21). |
| **Maintenance session** | A virtual session BrowserHive opens on a host for its own work, with `sessions.template_mode = 'maintenance'`: one per recording or re-login (slug `recording` or `relogin`, owned by the operator who started it) and one per host start for probes, keep-alive visits and host-owned confirmations (slug `maintenance`, owned by the reserved system subject `browserhive`, closed with the host). Maintenance status comes only from `template_mode`, never from the slug. Maintenance sessions have no lease, are never counted against any cap or in `server_status.sessions.count`, are refused to every agent principal by `sessionOwnership` (§6.1), and are hidden from the dashboard's session list unless asked for (§11.1). |
| **Page attribution** | The rule that assigns each page of a host to exactly one session, or to none (a parked page), before any session can see it (§3.4). |
| **Parked page** | A page of a host that no session owns: the sentinel, BrowserHive's own probe pages, tabs and windows the operator opened by hand, windows a service worker opened, pages restored by Chromium. Never in any `TabRegistry`. |
| **Serial checkout** | A deferred mode (§16): one copy of the template at a time under an exclusive lease, written back on close. Never N concurrent copies. |
| **Sealing** | The default restriction of template sessions so that the raw session material (cookie values, storage exports) stays out of agent results (§5.4, D-51). It does not stop an agent from acting as the account. **Unsealing** relaxes it per template and, optionally, per principal. |
| **Checkpoint** | The one rolling, encrypted storage-state snapshot of a host, overwritten on an interval (`versions/latest.state.enc`, §3.9). |
| **Version** | A numbered, encrypted storage-state snapshot written at a milestone (recording, re-login, restore, manual, import, a sign-in change, daily) and kept for rollback (`template_versions`). The live profile is the template; checkpoints and versions are its backups. |
| **Learned cookie names** | For a site without a pack: the cookie names that appeared on the site's registrable domain between the start of a sign-in and the operator's confirmation, minus analytics names; they make the generic probe answer `signed_in` (§8.1). |
| **Probe** | A per-site check of whether the host is signed in, with one of four outcomes: `signed_in`, `signed_out`, `challenged`, `inconclusive` (§8.1). |
| **Re-login** | Restoring a site's sign-in in the host: in a window on the BrowserHive machine, through an agent's attention request, or by a vault fill into the host (§8.4). |
| **Site pack** (pack) | Signed, versioned, declarative data about one site (sign-in, signed-in detection, guards, challenges, pacing, write policy, browser and consistency requirements, strategy selections). Data only, never code (D-54). |
| **Strategy** | A named behaviour compiled into the binary (`SiteStrategy`) that a pack may select and parameterise within bounds the binary fixes (§9.4); some adjust behaviour (pacing, dwell, serialisation), some the stealth surface (§9.4 stealth strategies). |
| **Guard** | A pack rule that matches requests by method, URL glob and resource type, or elements by role and name, and blocks, holds for confirmation, or warns (§9.3). |
| **Write policy** | Per site, what happens to requests a pack marks as writes: `allow`, `warn` or `confirm` (an operator approves each one). |
| **Tightening / restrictive / loosening** | The classification of every pack change (§9.7): tightening makes BrowserHive more conservative; restrictive is tightening that can stop the site's use; loosening or a new domain always waits for the operator's approval, and so does restrictive. |
| **Registry** | The static, signed files on `browserhive.ai/registry/v1/` from which BrowserHive downloads pack updates (§10). |

The dashboard uses plainer words for several of these terms (§11.4, UI vocabulary).

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
                       │  userdata/ (live profile)  versions/latest + vN (encrypted)   │
                       └──────────────────────────────────────────────────────────────┘
```

### 1.3 What does not change for agents

The 43 existing tools keep their names, parameters, defaults and result shapes (D-12). A template session is driven like any other session; it is opened with one new optional parameter and listed with one new tool (§5). The differences an agent can observe are listed in §5.6. Two T0 fixes change behaviour for every session, as security fixes D-12 permits (D-57): `navigate` and `new_tab` refuse non-web URL schemes, and `vault_fill` refuses a password target that is not a password input (D-58).

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
| `status` | `recording` \| `ready` \| `disabled` | `recording` | `recording` until the first Finish (§7); `disabled` by the operator; only `ready` templates can be launched |
| `owner` | principal subject | creator | the operator principal that created it |
| `sites` | `TemplateSite[]` 1–16 | required | §2.3 |
| `identity` | `PinnedIdentity` | resolved at creation | frozen (§2.2) |
| `identity_observed` | `ObservedIdentity \| null` | `null` until the first host start | recorded, never faked (§2.2) |
| `channel` | `chromium` \| `chrome` \| `edge` | server `defaultChannel`, or `chrome` when a pack asks for it and Chrome is installed | frozen; a change requires a host restart and is confirmed in the editor; a pack's request for a channel that is not installed is shown, never silently replaced (§7.1, D-26) |
| `headless` | boolean | `false` | `true` is allowed with a warning (§3.11); refused when an enabled site's pack says `headed: 'required'` |
| `stealth` | `off` \| `standard` \| `max` | server `stealth` | frozen like the identity; `off` is refused while an enabled site's pack is `human_only` (§7.3) or sets a `stealth-profile` floor (§9.4) |
| `fingerprint` | boolean | derived as for sessions (11 §3) | the display is asserted only when the host is headless (11 §2.6 rule 5) |
| `humanize` | boolean | server `humanize` | default for the template's virtual sessions; an agent may override per session (§5.3); collapses to `false` when `stealth` is `off` |
| `proxy` | `TemplateProxy \| null` | `null` | §2.2 |
| `policy` | `TemplatePolicy` | §6 | access rule, cap, unsealing, health |
| `agent_windows` | `normal` \| `minimized` | `normal` | initial state of virtual sessions' windows on a headed host; windows are created in the background either way (§3.3); `minimized` is best effort (§3.10) |
| `current_version` | integer ≥ 1 \| null | `null` | the newest version |
| `checkpoint_at`, `checkpoint_size_bytes` | epoch ms \| null, integer \| null | `null` | the rolling checkpoint (§3.9) |
| `version` | integer ≥ 1 | 1 | optimistic-concurrency row version (`If-Match`, 409 `CONFLICT`, D-14) |
| `created_at`, `updated_at`, `last_used_at`, `disabled_at` | epoch ms | | `last_used_at` = the last virtual-session launch |

### 2.2 Pinned identity and network

A template is one person on one device. Everything a site can use to tell that device apart is fixed once and never re-derived. Part of it is chosen when the template is created; the rest can only be read from a running browser and is recorded at the first host start.

| Field | Part | Source | Afterwards |
|---|---|---|---|
| `seed` | `identity` (creation) | 21 random characters (`nanoid`) | fixed for life; feeds `deriveFingerprint` (11 §2.4) as a restored profile's seed does today (`packages/core/src/infra/browsers/identity-resolver.ts:96`) |
| `locale`, `languages`, `timezone_id`, `country_code` | `identity` (creation) | the host geo seed (11 §2.5), or the operator's explicit values; **required explicitly** when a proxy is set (the wizard pre-fills the host's values and says why) | passed to the host as caller-supplied context options, so 11 §2.6 rule 1 applies (caller truth honoured, no `BYO_PROXY_UNSEEDED`); never re-resolved from a host that moved |
| `geolocation` | `identity` (creation) | the operator's explicit coordinates only (BrowserHive never invents coordinates, 11 §2.5) | omitted when not given |
| `proxy` | `proxy` (creation, changeable) | `{server, bypass?, username?, password_env?, label}` | `server` is `scheme://host:port` without credentials (a URL with `user:pass@` is refused, 400 `VALIDATION_FAILED`); `password_env` is the **name** of an environment variable (D-33), refused when it starts with `BROWSERHIVE_` (as D-33 does for channels), resolved at each host start. The host's proxy goes through the `ProxyResolver` like a session's BYO proxy (`source: 'byo'`, the auth shim of 11 §11 for credentials Chromium cannot pass, the forced loopback/RFC 1918 bypass, and a `template.proxy_assigned` bus event per host start, as `session.proxy_assigned` is for sessions, D-13). A host start first opens a TCP connection to the proxy's host and port (3 s timeout); on failure the host does not start and launches answer `TEMPLATE_DISABLED` (`reason: 'needs_operator'`; the operator sees `proxy_unreachable`). BrowserHive never falls back to the host's IP |
| `chrome_major`, `user_agent`, `ua_ch` (`brands`, `full_version_list`, `platform`, `platform_version`, `architecture`, `bitness`) | `identity_observed` (first host start) | `Browser.getVersion` and the applier's derivation (11 §2.3) | recorded, never faked (D-26). A later host start that reports a different major records an **identity drift** (`template.changed` with `identity_drift: {from, to}`, a dashboard banner, a `doctor` warning); launches continue |
| `screen` (`width`, `height`, `device_scale_factor`), `window` (`width`, `height`) | `identity_observed` (first host start) | headless: the fingerprint display; headed: the real screen read from the sentinel (`Browser.getWindowBounds`, `screen.*`), window = 1280×800 clamped to the screen until the first recording window closes, then that window's size | the window size is used for every virtual session's window (§3.3); the screen is asserted only when headless |

A template that never ran has `identity_observed: null`; the dashboard shows "Recorded at the first start", and the CLI prints `—`. Changing the proxy or channel is allowed (`PATCH`, with `confirm_identity_change: true`) and restarts the host; the editor warns that sites may sign the account out. The seed, locale, timezone and geolocation cannot be changed; a different identity is a different template.

### 2.3 Sites

`TemplateSite`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `site_id` | registrable domain | required | `registrableDomain(host)`; a host on a public suffix only is refused |
| `pack_id` | registrable domain \| null | the pack whose `domains` include `site_id`, if any (§9.6) | `null` = no pack: a generic site (cookie-presence probe with learned cookie names, §8.1) |
| `pack_version` | integer \| null | the approved version at the time | updated when the operator approves an update (§10.6) |
| `enabled` | boolean | `true` | a disabled site keeps its sign-in but is not probed, guarded or offered in `list_templates` |
| `write_policy` | `allow` \| `warn` \| `confirm` \| null | `null` = the pack's default | §9.3 |
| `vault_handle` | string \| null | `null` | a vault binding linked for auto-relogin (§8.4); linking needs `templates:login` and `vault:write`, and the binding must authorize the principal `template:<template_id>` |
| `auto_relogin` | boolean | `false` | requires `vault_handle`; refused for a site whose pack says `human_only: true` |
| `form` | `{username, password, submit?, next?}` CSS selectors \| null | the pack's `sign_in.form` | used only by auto-relogin; `password` must resolve to one password input at fill time (D-58) |
| `learned_cookie_names` | string[] (≤ 16) | `[]` | generic sites only (§7.1, §8.1) |
| `health` | `{state, checked_at, changed_at, reason, consecutive_inconclusive}` | `state: 'unknown'` | §8 |
| `stopped_at` | epoch ms \| null | `null` | set by a `stop` challenge (§9.5); cleared by the operator |
| `device_bound` | boolean | `false` | set by the `device-bound-session` strategy (§9.4) |

Sites that share one login (`identity_provider`, `shares_login_with`, §9.2) are grouped by identity provider in health and notifications: a Glassdoor sign-out on a job-hunt template reads "Indeed login (covers Indeed, Glassdoor)".

**Unlisted sign-ins.** The jar may also hold sign-ins to domains that are not sites of the template (an operator who read a PIN in their webmail inside the recording window). Every Finish and every re-login completion lists them (§7.1), and every numbered version records the jar's registrable domains in its `summary`; a version whose summary gains a registrable domain that is neither a site, a site's pack domain nor a `shares_login_with` domain, and that holds at least one persistent `HttpOnly` and `Secure` cookie, raises `template.changed` with `unlisted_domains` and a template-page warning with **Remove sign-in** (clears that domain's cookies and origin storage).

### 2.4 Storage layout and encryption at rest

```
<data-dir>/
  templates/<template_id>/            0700
    userdata/                         the host's live Chromium profile; only the host opens it (§3.9)
    versions/latest.state.enc         the rolling checkpoint (§3.9), 0600
    versions/v<N>.state.enc           numbered versions, 0600
    versions/v<N>.meta.json           {version, created_at, reason, size_bytes, sha256, key_id, summary}, 0600
    downloads/                        the host's browser-level downloads directory (§5.5)
  admin/                              0700
    template.key                      32 random bytes, base64, 0600 (absent when templateKey is set)
  site-packs/                         0700 (§9, §10)
    cache/                            verified registry files, content-addressed
    local/                            operator packs (default sitePacksDir)
```

`summary` holds, per registrable domain, the cookie count, the names of the pack's (or learned) sign-in cookies that are present, the earliest expiry and whether a session cookie exists; never a cookie value (D-20).

**Envelope.** Every checkpoint and version file is AES-256-GCM, written as one binary envelope: header = magic `BHTE` (4 bytes), format `1` (1 byte), `key_id` (8 bytes: the first 8 bytes of SHA-256 of the key), nonce (12 random bytes); then ciphertext and tag (16 bytes). The additional authenticated data is the 13-byte header prefix (magic, format, `key_id`) followed by `<template_id>:<slot>`, where `slot` is the version number or `latest`, so a file cannot be swapped between templates or slots and its header cannot be altered. Files are written to `<name>.tmp` with mode 0600, `fsync`ed and renamed; the database row is inserted after the rename. A file without a row is deleted at boot; a row without a file marks the version unreadable. Plaintext storage state exists only in memory: `storageState()` is never called with a `path` for a template, and decrypted state is never written to disk.

**The key** is resolved once per process:

1. `templateKey` (08 §5.9; secret; `BROWSERHIVE_TEMPLATE_KEY` or an `{env:…}` reference): base64 of exactly 32 bytes, else `CONFIG_INVALID` at boot. Given as a command-line flag it works but logs a warning (process arguments are readable by other users of the machine); spec 12 shows only the environment form.
2. Otherwise `<data-dir>/admin/template.key`. It is created only when no checkpoint or version file exists in any template, with `open(O_CREAT | O_EXCL, 0600)` inside `admin/` (0700), so two processes cannot both create it. When files exist and no key resolves, nothing is re-created: the `TEMPLATE_KEY_MISSING` degradation (10 §3) is recorded, checkpoints and versions are skipped, restores of encrypted files are refused, and the hosts keep running (the live profile needs no key).

A file whose `key_id` does not match the resolved key (or `templateKeyPrevious`, below) cannot be read: the version list marks it "unreadable with the current key", restoring it answers 409 `TEMPLATE_VERSION_UNREADABLE`, and a `TEMPLATE_KEY_MISMATCH` degradation names the template. Agents never see key problems.

**Rotation.** `browserhive templates rekey --oldKeyEnv <ENV>` runs locally against the data directory (it refuses while a server holds the data-dir lock, `packages/browserhive/src/composition/lock-file.ts`): it reads every file with the old key, rewrites it with the current key (`.tmp`, `fsync`, rename) and updates `key_id` in the rows; files already on the current key are skipped, so an interrupted run can be repeated. For the time between setting a new key and running `rekey`, the secret config key `templateKeyPrevious` lets a running server read (never write) old files.

**Honest scope (stated in `docs/guide/security.md` and the wizard).** Encryption protects copies of checkpoint and version files (backups, synced folders, a stolen disk image of `versions/`) when the key is not copied with them. It does not protect:

- the live profile in `userdata/` (`Cookies`, `Local Storage`, `IndexedDB`, `History`, `Sessions`, `Login Data`, which §3.1 keeps empty): on Linux Chromium under Playwright encrypts cookies with a published constant key (`--password-store=basic`) and on macOS with a mocked keychain (`--use-mock-keychain`), so it is effectively plaintext; on Windows cookies are DPAPI-protected per user, which any process of that user can undo. Its protection is the 0700/0600 modes;
- the host's `downloads/` and any auth-state snapshot an unsealed `state_export` created (plain files, 02 §6);
- a host where an attacker can read the data directory (the default key file lives next to it; `templateKey` from the environment keeps the key out of it), a running process, or an agent that runs code as BrowserHive's OS user (§5.4, §13).

Saved auth states (`auth-states/`) stay unencrypted in this program (§16).

### 2.5 Database (migration `0009-templates`, schema v9, PR T1a)

`compatible: true` as a migration: additive tables and columns plus one data rewrite (below), so this migration on its own does not raise `meta.min_reader_version`. **Downgrades are not supported across the templates release:** the feature reaches `main` in one release together with migration v10 (`0010-site-packs`, `compatible: false`, `min_reader_version` 10, §9.9), so every binary older than that release refuses the upgraded database (D-04). The flag only matters for a partial downgrade between builds of the feature branch, and the token reader fails closed for it (below). `sessions.persistence_mode` keeps its frozen CHECK (`memory`, `persistent`, `storage-state`); a virtual session is recorded as `memory` (§5.5), so no table rebuild and no new enum value is needed (D-12). Every `CHECK` list in this and later migrations is a literal frozen in the migration file, never a live constant (§9.9).

**Operator token scopes (data step).** The five scopes of §6.2 join `OPERATOR_SCOPES` in this PR. An operator API token issued without `scopes` stores `[]` and gains them automatically (03 §3.5). One whose `scopes_json` is exactly the 0.2.x full list (the 19 scopes, in registry order, as v8's `FULL_V02` literal) was issued as "every scope" (v8 already rewrote the ones that existed when it ran, but a token issued later with that explicit list keeps it), and without a rewrite it would lose the account routes, because `hasFullOperatorAccess` requires every operator scope. So this migration ends with v8's statement for that one list: `UPDATE credentials SET scopes_json = '[]' WHERE kind = 'api_token' AND principal_id IN (SELECT principal_id FROM principals WHERE kind = 'operator') AND scopes_json = '<the 19-scope literal>'`, with the literal written out in the migration file. Agent tokens and every other list are untouched. **Unknown scopes fail closed** (03 §3.5, `resolveStoredScopes`): only a stored `[]` expands to the owner kind's full set; a non-empty stored list keeps only the scopes the reading binary knows, so a token issued with only the new scopes (`["templates:read"]`) holds **no** scope in a binary that does not know them, never the full set, and a mixed list keeps its known entries. This protects any partial downgrade and every later scope addition.

```sql
-- v9 (0009-templates): session templates (spec 13, D-49)
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
  identity_json TEXT NOT NULL,                                   -- PinnedIdentity: seed, locale, languages, timezone, country, geo (§2.2); no secret
  identity_observed_json TEXT,                                   -- ObservedIdentity, NULL until the first host start
  proxy_json TEXT,                                               -- {server, bypass, username, password_env, label}; env NAME only (D-33)
  agent_windows TEXT NOT NULL DEFAULT 'normal' CHECK (agent_windows IN ('normal','minimized')),
  authorized_principals_json TEXT NOT NULL DEFAULT '[]',         -- [] = any principal (§6.1)
  harnesses_json TEXT,                                           -- NULL = all harnesses, '[]' = none (D-48 semantics, D-52)
  max_concurrent INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent BETWEEN 1 AND 20),
  unseal_json TEXT NOT NULL DEFAULT '{}',                        -- {cookie_values, evaluate, cookie_writes, state_export: bool, principals?: string[]} (§5.4)
  health_interval_ms INTEGER NOT NULL CHECK (health_interval_ms BETWEEN 1800000 AND 604800000),
  prelaunch_check INTEGER NOT NULL DEFAULT 1 CHECK (prelaunch_check IN (0,1)),
  current_version INTEGER,
  checkpoint_at INTEGER, checkpoint_size_bytes INTEGER,          -- the rolling checkpoint (§3.9)
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
  learned_cookie_names_json TEXT NOT NULL DEFAULT '[]',          -- generic sites (§8.1); names only
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('unknown','signed_in','signed_out','challenged','inconclusive')),
  health_reason TEXT, health_checked_at INTEGER, health_changed_at INTEGER,
  consecutive_inconclusive INTEGER NOT NULL DEFAULT 0,
  stopped_at INTEGER,                                            -- a `stop` challenge is in force (§9.5)
  device_bound INTEGER NOT NULL DEFAULT 0 CHECK (device_bound IN (0,1)),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, site_id)
) WITHOUT ROWID;
CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('recording','relogin','restore','manual','import','signin_change','daily')),
  restored_from INTEGER,                                         -- set when reason = 'restore' (0 = the rolling checkpoint)
  size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, key_id TEXT NOT NULL,
  structure_sha256 TEXT NOT NULL,                                -- cookie (domain, name) pairs + storage keys (§3.9)
  summary_json TEXT NOT NULL,                                    -- per-domain counts and cookie NAMES only (D-20)
  health_json TEXT NOT NULL,                                     -- per-site health state when written
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),     -- exempt from templateVersionsKeep
  created_by TEXT,                                               -- principal, or 'browserhive' for automatic versions
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
) WITHOUT ROWID;
CREATE TABLE template_probes (                                   -- telemetry class (§11.10): one row per probe
  seq INTEGER PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(template_id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('signed_in','signed_out','challenged','inconclusive')),
  reason TEXT NOT NULL,                                          -- §8.1 reason codes
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','prelaunch','recording','relogin','manual','host_start','attention','restore')),
  final_url TEXT,                                                -- sanitized (query and fragment stripped, D-20)
  duration_ms INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX idx_template_probes_template ON template_probes(template_id, site_id, at);
CREATE INDEX idx_template_probes_at ON template_probes(at);
-- the session's template, written once at launch; NULL for exclusive sessions and for every session created before v9
ALTER TABLE sessions ADD COLUMN template_id TEXT REFERENCES templates(template_id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN template_name TEXT;             -- the name at launch (history survives a rename or delete)
ALTER TABLE sessions ADD COLUMN template_version INTEGER;       -- current_version at launch
ALTER TABLE sessions ADD COLUMN template_mode TEXT;             -- open set, no CHECK: 'live' (agent) | 'maintenance'; 'serial' reserved (§16)
ALTER TABLE sessions ADD COLUMN sealed INTEGER CHECK (sealed IN (0,1));
CREATE INDEX idx_sessions_template ON sessions(template_id, created_at) WHERE template_id IS NOT NULL;
```

`MIGRATIONS` gains the entry after `operatorTokenScopes` (`packages/core/src/infra/persistence/migrations/index.ts:16-25` @ `96c572a`). `TABLES` (`index.ts:34`, deletion order, children first) gains `template_probes`, `template_versions` and `template_sites` before `templates`, and `templates` **after** `sessions`, because `sessions.template_id` references `templates`. The fixture `v9.db`, the golden `schema-v9.json` and regenerated `db.d.ts` ship with it (09 §3.2). Migration `0010-site-packs` (PR T3a) is in §9.9.

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
interface TemplateKeyProvider {                                     // §2.4
  resolve(): Promise<{ key: CryptoKey; keyId: string } | null>;    // null: no key (TEMPLATE_KEY_MISSING when files exist)
  previous(): Promise<{ key: CryptoKey; keyId: string } | null>;   // templateKeyPrevious, read only
}
interface TemplateStateStore {   // the files under templates/<id>/versions, encryption included; plaintext only in memory
  write(templateId, slot: number | 'latest', state: StorageState): Promise<{ sizeBytes; sha256; keyId }>;
  read(templateId, slot: number | 'latest'): Promise<StorageState>;   // TEMPLATE_VERSION_UNREADABLE on a key mismatch
  remove(templateId, slot: number | 'latest'): Promise<void>;
}
```

*As built in T1a-1.* `TemplateRepository.list(query)` is `listAll()` (every row, by name): `GET /templates` sorts and filters by `in_use` and `host_state`, which only the host supervisor knows, so the template service pages over the (small, operator-made) set with its own keyset cursor. `TemplateRepository.insert` throws `TEMPLATE_NAME_TAKEN` on the unique name; `update` throws `CONFLICT` on a stale version and `TEMPLATE_NAME_TAKEN` on a colliding rename. `TemplateSiteRepository` adds `listAll()`. The host side is behind one more port, `TemplateRuntime` (`ports/template-runtime.ts`: `host(id)`, `liveSessions(id)`, `launch(request)`, `shutdown(id)`), which the host supervisor implements in T1a-2. Its launch request carries the slug, the caller's identity and complete `TemplateSessionSettings` (channel, headless, stealth and fingerprint from the template; `incognito: false`, `persistence_mode: 'memory'`, `vault_enabled: false`; only `humanize`, a tightening `disable_evaluate` and the three per-session context options from the agent), never the agent's raw arguments. The service serializes a delete against launches of the same template (`TemplateLocks`): a launch never starts while the template is being deleted (`TEMPLATE_NOT_FOUND`), and a delete refuses launches in flight with `TEMPLATE_IN_USE` or, with `force`, waits for them. `listAll({onUnreadable})` lets `list_templates` skip a row it cannot read (logged, `TEMPLATE_ROW_UNREADABLE` degradation) instead of failing for every agent. Until T1a-2 `UnavailableTemplateRuntime` reports every host `stopped` and answers launches with `TEMPLATE_UNAVAILABLE` (`reason: 'starting'`). The template directory is behind `TemplateFiles` (`ports/template-files.ts`).

---

## 3. Live mode

### 3.1 The host

A host is launched with `launchPersistentContext(<data-dir>/templates/<id>/userdata, options)` (the call persistent sessions use, `packages/core/src/infra/browsers/playwright-browser-driver.ts:221`), where `options` are built from the template only; templates take no launch options in v1:

- `channel`, `headless`, the stealth flags and `ignoreDefaultArgs` of 11 §2.2 (which always keep the three switches of §3.10);
- `chromiumSandbox` per the sandbox policy (D-27): under `sandbox=on` a host that cannot sandbox fails to start with `SANDBOX_UNAVAILABLE` and the host becomes `failed` with `reason: 'sandbox_unavailable'`; under `auto` a fallback is recorded and the template page shows an "unsandboxed" warning. Each virtual session records its host's `sandboxed` and `browser_version` at launch (D-31);
- the pinned identity's context options (locale, timezone, languages, geolocation when given; viewport `null` when headed, the fingerprint display when headless and `fingerprint` is on);
- the pinned proxy through the `ProxyResolver` (§2.2);
- `downloadsPath: <data-dir>/templates/<id>/downloads`;
- `--disable-sync`, plus any `webrtc-policy` flag an enabled site's pack selects (§9.4);
- no tracing (§5.4).

**Profile preferences.** Before every host start BrowserHive merges into `userdata/Default/Preferences` (creating it when absent): `credentials_enable_service: false`, `profile.password_manager_enabled: false`, `autofill.profile_enabled: false`, `autofill.credit_card_enabled: false`, `signin.allowed: false`, `profile.exit_type: "Normal"`, `profile.exited_cleanly: true` and `session.restore_on_startup: 5` (open the New Tab page, never restore). Chrome then offers no "Save password?" or "Sign in to Chrome", autofills nothing, and never offers to restore pages after a crash. A host start that finds a non-empty `Login Data` or autofill table in `Web Data` reports it on the template page and in `doctor` ("Saved passwords or autofill data are in this template's browser; agents can trigger autofill") with **Clear saved passwords and autofill**.

**Sentinel.** The persistent context's first page becomes the sentinel: it stays on `about:blank`, is parked (§3.4) and, on a headed host, its window is minimized (`Browser.setWindowBounds {windowState: 'minimized'}`) as soon as the host is running. Every other page present when the host starts (a restored window) is closed before any session is admitted.

**Identity** (11 §2.3) is applied per page as for sessions; the applier's context-wide `context.on('page')` subscription (`packages/core/src/infra/browsers/identity-applier.ts:137`) stays host-level. Its native UA-CH probe (`identity-applier.ts:183`) runs only for the Edge channel (`:118-121`) and today opens a page with `context.newPage()`; on a host the applier is given an `openProbePage()` hook that creates the page through the host (§3.3, `background: true`) as a host claim, so the page is parked and closed after the probe. It runs once per host start, never per virtual session.

**Stale processes.** At daemon start, before any host starts, every Chromium process whose command line names a `--user-data-dir` under `<data-dir>/templates/` is terminated (it survived a killed daemon and holds `SingletonLock`), through the process-tree reader port; a `SingletonLock` whose process no longer exists is removed. Each one found is recorded in the existing "stale Chromium processes" degradation (10 §3).

### 3.2 Host lifecycle and supervisor

`TemplateHostSupervisor` (`app/templates/host-supervisor.ts`) owns every host, keyed by `template_id`; it is the only code path that launches or closes a host.

| State | Meaning | Launches |
|---|---|---|
| `stopped` | no browser | start the host, then proceed (§6.3) |
| `starting` | launching (deadline 60 s) | wait, within the launch budget (§3.7) |
| `running` | browser up, sentinel open | admitted (§6.3) |
| `draining` | recycle, restore or operator restart in progress | `TEMPLATE_UNAVAILABLE` `reason: 'restarting'` with `retry_after_ms` |
| `crashed` | browser exited unexpectedly; restart scheduled | `TEMPLATE_UNAVAILABLE` `reason: 'recovering'` |
| `failed` | 5 consecutive failed starts within 30 min, no display, unreachable proxy, or no sandbox under `sandbox=on` | `TEMPLATE_DISABLED` (`reason: 'needs_operator'`; the cause is on operator surfaces); an operator restart (dashboard, CLI) clears it |

- **Start** is lazy: on the first launch, recording, re-login, probe, keep-alive or restore. Hosts are never started at boot. The start needs a free browser slot (§6.3); without one the launch answers `SESSION_LIMIT_REACHED`. A host start without a usable display fails with `reason: 'no_display'` (§3.11).
- **Restart after a crash** uses backoff 5 s, 15 s, 45 s, 135 s, 405 s; the fifth consecutive failure within 30 min sets `failed`, records the `TEMPLATE_HOST_FAILED` degradation and produces the `template.host_failed` notification (§8.6).
- **Operator stop by hand.** When the sentinel window is closed by hand while other pages exist, a new sentinel is created at once (`Target.createTarget`, §3.3, host claim) and minimized. When the browser exits within 10 s after the sentinel was closed by hand (the operator quit Chrome), it is an operator stop, not a crash: its sessions close with `closed_reason: 'operator'` (`SESSION_DEAD` for agents), the host is `stopped`, nothing restarts until the next launch. Any other exit is a crash.
- **Idle stop.** A host with no agent virtual session, no recording or re-login session (its `maintenance` session does not count) and no parked page other than the sentinel for `templateHostIdleTimeout` (default `1h`; `0` = never) is stopped cleanly: final checkpoint (§3.9), then `context.close()`.
- **Recycle.** A host is drained and reopened when it is older than `templateRecycleAfter` (default `24h`), after a proxy, channel or host-flag change (`webrtc-policy`), on a restore, or on an operator restart. Draining refuses new launches, lets virtual sessions finish, and force-closes those still open after `templateDrainTimeout` (default `15m`) with `closed_reason: 'operator'` for an operator action and `'shutdown'` otherwise. A user-data-dir cannot be opened twice (`SingletonLock`), so the new generation starts only after the old one has closed; there is no overlap.
- **Memory.** The supervisor samples each host's process-tree resident memory every 60 s through the process-tree reader port, independently of OpenTelemetry (the existing browser-memory sampler, `packages/browserhive/src/composition/adapters/browser-memory.ts`, runs only with exported OTel metrics and is keyed by session, so it is not reused). Above `templateRecycleRss` (default `3GiB`), it first ranks the host's sessions by the summed `JSHeapTotalSize` (`Performance.getMetrics`) of their pages, closes the largest page of the top session and gives that session a `SESSION_RESOURCE_LIMIT` warning; when the host is still above the limit 5 minutes later, it drains the host.
- **Daemon shutdown** drains every host within the sessions budget of 01 §6 (virtual sessions close with `shutdown`), writes a final checkpoint per host when the budget allows, then closes the hosts. At the next start, `reconcileOnStartup` marks virtual sessions that were open `interrupted` like any other (`packages/core/src/app/maintenance/startup-reconcile.ts:10`).

**Failure modes.**

| Event | Behaviour |
|---|---|
| Host crash during a recording or re-login | The maintenance session ends `crashed`; the host restarts with backoff (the sign-ins already written to `userdata/` survive); the wizard, template page and CLI show "The browser closed. Reopen it to continue"; the template stays `recording` (or the re-login stays open until its timeout). |
| Disk full or I/O error during a checkpoint or version write | The `.tmp` file is deleted, the previous file and row stay, `TEMPLATE_CHECKPOINT_FAILED` (degradation, warn) is recorded; no row without a file. |
| Pack or index newer than this binary (`min_client`, `schema`, `/v2/`) | The current version stays in force; the pack page shows "v9 needs BrowserHive ≥ x.y"; `RegistryStatus.skipped` reason `min_client` (§10.3). |
| Clock skew | Expiry checks allow ±1 h of skew; `doctor` compares the local clock with the registry response's `Date` header and warns beyond 5 min; `SITE_PACKS_STALE` says "check the system clock" when `Date` disagrees by more than 1 h (§10.3). |
| Policy edit while sessions are live | A lowered cap refuses new launches only. Re-sealing, revoking access, disabling the template or removing a site applies at once: sealing is checked per tool call; sessions whose principal or harness lost access, and every session of a disabled template, are closed with `closed_reason: 'operator'` after a confirmation dialog that lists them. Write-policy and pack changes apply to the next request. |
| `close_session` with a held write or an open security intercept | The held route is aborted (`blockedbyclient`) and the request settles `cancelled`. |
| Pre-T0a binary after a downgrade | Per-principal auth-state snapshots under `auth-states/p/` are invisible to it (`docs/guide/upgrading.md` says so). |

*As built in T1a-2 (deviations).* `TemplateHostSupervisor` (`app/templates/host-supervisor.ts`) implements `TemplateRuntime`; one `HostLifecycle` per template (`host-lifecycle.ts`) holds the state machine, with the pure rules in `host-state.ts` (backoff, the failure window, `permanentFailure`, idle and recycle clocks). (1) **Operator stop** is recognised by Chromium itself: the sentinel counts as closed by hand only when the host's browser-level DevTools session receives `Target.targetDestroyed` for it; a killed or crashed browser reports no target destroyed (its pipe just closes), so a kill is always a crash. Template hosts launch with Playwright's `handleSIGINT`/`handleSIGTERM`/`handleSIGHUP` off, so the daemon's own shutdown (sessions with `shutdown`, then the hosts) is never mistaken for an operator quitting the browser; a host that survives a killed daemon is the stale-process sweep's. (2) An operator stop closes the host's sessions with `closed_reason: 'operator'` (a view's crash listeners skip an operator stop, so the sessions are not marked crashed first) and removes them, so agents then get `SESSION_NOT_FOUND`; a crash marks them `crashed` (`SESSION_DEAD`) and reaps them at once, as for exclusive sessions. A view's host subscriptions are removed when it closes. An **idle stop, delete or shutdown** puts the host in `draining` before anything is awaited, closes every session still on it, closes the browser, closes any view that opened in between, and only then goes `stopped`; a launch meanwhile answers `TEMPLATE_UNAVAILABLE` `restarting` and never attaches to a closing browser or races a new start for the profile lock. The stale-process sweep matches the templates directory as a literal prefix of the text after `--user-data-dir=`, so a data dir with a space (macOS's `Application Support`) is found. (3) A **draining** host still holds its browser slot (its browser is up), with `starting` and `running`. (4) A failed start is classified `failed` at once for `no_display`, `proxy_unreachable` and `sandbox_unavailable`; any other failure (a crash or a failed start) counts toward the five in 30 minutes. A restart after the backoff starts the host only when a browser slot is free, else the host goes `stopped` and starts on the next launch. (5) The memory **sampler** of this PR records each running host's process-tree RSS for the operator view (`HostView.rss_bytes`, every `tick`, 60 s); the `templateRecycleRss` drain and `SESSION_RESOURCE_LIMIT` stay T1b's. (6) The per-host system **maintenance session** is opened on demand (`launchMaintenance`, slug `maintenance`, owner `browserhive`), not at every host start; it does not keep a host from idling. Recording and re-login sessions (T1a-3, T2) use the same method.

### 3.3 Virtual sessions: windows

A virtual session owns one or more windows of its host. Every window and tab BrowserHive creates on a host (agent windows, maintenance and probe pages, a recreated sentinel) is created **in the background**, at `about:blank` (MUST: under Patchright, headed, a `createTarget` given a URL directly does not receive the context's init scripts), and navigated afterwards:

```ts
const cdp = await browser.newBrowserCDPSession();                 // browser = context.browser(), as session-handle.ts:165-168 does
const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId: sentinelTargetId });
const { targetId } = await cdp.send('Target.createTarget', {
  url: 'about:blank', newWindow: true, background: true, browserContextId: targetInfo.browserContextId,
  width: identity.window.width, height: identity.window.height,
  ...(windowState === 'minimized' && { windowState: 'minimized' }),   // where the pinned Chromium supports it, else minimized right after creation
});
```

Playwright adopts the new target into `context.pages()` and fires `context.on('page')` (measured: about 10 ms after the `createTarget` response); the attribution dispatcher (§3.4) claims it by `targetId` within the adoption deadline (10 s; on timeout the target is closed and the launch fails with `TEMPLATE_UNAVAILABLE` `reason: 'starting'`). The window id (`Browser.getWindowForTarget`) is recorded in the session's window set.

**No focus theft.** BrowserHive never activates, raises or moves a host window except on an explicit operator action (dashboard **Show window**, recording, re-login). *Exception measured in T1a-2 (Xvfb, both drivers):* a headed host's **start** shows Chromium's first window (the sentinel, Playwright's persistent first page) as an active window before BrowserHive minimizes it, so a start can take the focus once; session windows (`createTarget {background: true}`) never do, which the headed CI leg asserts with `xdotool` against an operator window. Starting without an active first window (a patched driver or a `--no-startup-window` start) is deferred. While a recording or re-login window is open on a host, every agent window of that host is minimized (`Browser.setWindowBounds {windowState: 'minimized'}`), new agent windows are created minimized, and the maintenance window carries a BrowserHive marker in its title (`[BrowserHive] Sign in to <site>`). The wizard and re-login text tell the operator to type rather than paste, and to check the address bar.

**`new_tab`** opens a tab in the session's window when the session's active page is in a window of the session's window set and that window is a normal tabbed window (`window.toolbar.visible === true`, read in an isolated world; a popup window reports `false`). BrowserHive then runs `window.open('about:blank', '_blank', 'noopener')` in an **isolated world** of that page (`Page.createIsolatedWorld`, then `Runtime.evaluate` with `userGesture: true`, needed because Patchright drops `--disable-popup-blocking`). The page's scripts cannot see the call itself, but the user gesture gives the page transient user activation for about 5 s, which its scripts can observe (`navigator.userActivation`). In every other case (no page left, a popup window, a `chrome-error://` or PDF page, an evaluation failure), `new_tab` creates another background window for the session with `Target.createTarget {newWindow: true}`; a session may own several windows. `context.newPage()` is never called on a host by BrowserHive (it would put the tab in whichever window was activated last).

**`switch_tab`** updates the registry, as for exclusive sessions (`packages/core/src/app/sessions/session-tabs.ts:65-69`). On a **headless** host it also calls `page.bringToFront()`, so the active tab is its window's front tab. On a **headed** host it does not: `bringToFront()` raises the window and restores a minimized one, which would steal the operator's focus. A background tab of a headed host stays `visible` and focused through focus emulation (§3.10) but runs `requestAnimationFrame` at about 15 fps (§5.6).

**`press_key`** in a virtual session refuses the clipboard chords `Control+V`, `Meta+V`, `Shift+Insert`, `Control+C`, `Meta+C`, `Control+Insert`, `Control+X` and `Meta+X` (any modifier order, `ControlOrMeta` included) with `INVALID_ARGUMENTS` (`clipboard shortcuts are not available in template sessions`): CDP key events count as user input, so a paste would read the operator's clipboard on a headed host.

**Viewport.** `set_viewport` and `context_options.viewport` act per page (`page.setViewportSize`); on a headed host they also resize the session's window (`Browser.setWindowBounds` with `width`/`height` only, never `left`/`top`), clamped to the identity's window size, so the page is not letterboxed.

**Screenshots** of a virtual session's page use Playwright with a 10 s timeout; on timeout BrowserHive retries once with `Page.captureScreenshot {fromSurface: true}` on the page's CDP session (rendering of minimized windows can stall, §3.10).

*As built in T1a-2.* `HostTargets` (`infra/browsers/template-targets.ts`) is the host's browser-level DevTools session: `Target.createTarget` windows (falling back to minimizing after creation where `windowState` is refused), `Browser.getWindowForTarget`/`setWindowBounds` (size only, never a position or a state that would raise the window). `SessionView.newPage(beside?)` takes the session's active page (the `new_tab` path passes it), because the view does not know the session's active tab otherwise. The tab path waits up to 3 s for the page whose `openerId` is the active page's target before it falls back to a window. Measured (headless, Linux, Chromium 1243): a host start takes about 270 ms (Playwright) to 410 ms (Patchright); each virtual-session window is adopted and claimed in about 50 to 65 ms. The page caps run in the view before a page the session opens itself (`beforeNewPage`), never for site-opened pages. `switch_tab`, `press_key`, `set_viewport` and `screenshot` behaviour of this section is T1a-3's (the tool table); the view applies the session's `viewport`, `extraHTTPHeaders` and `colorScheme` to every page it gets, and resizes a headed window to the viewport, clamped to the identity's window size.

### 3.4 Page attribution

One dispatcher per host subscribes to `context.on('page')`. For every new page it reads `Target.getTargetInfo` on the page's own CDP session (`targetId`, `openerId`) and decides, **before** any session's `TabRegistry` sees the page, in this order:

1. **Claim.** `targetId` matches a pending claim: a session's (from §3.3) → that session; the host's own (sentinel, probe page, Playwright's internal storage-state page is not claimed) → parked.
2. **Opener.** `openerId` names a target attributed to session S → S; a parked opener → parked. CDP sets `openerId` for `noopener` popups and `target=_blank` links too (`canAccessOpener: false`). The dispatcher keeps a **tombstone map** of closed targets to their attribution for the host's life (bounded to the newest 10 000 entries), so a page whose opener closed first (`window.open(url); window.close()`, common in OAuth flows) still goes to the opener's session.
3. **Hold.** A page that matches neither while a `createTarget` of this host is still awaiting its response is held for at most 2 000 ms and re-evaluated when the response arrives. *Extension made in PR T0c* (the dispatcher reads target info asynchronously, so an opener's attribution can arrive after its child): a page whose named opener is not known yet is also held while some page's target info is still being read (the opener may be among them; at most until its own 2 000 ms run out), and while its opener is itself held, past its own 2 000 ms, until the opener is decided (bounded by the opener's own hold, and by a hard stop after a second 2 000 ms). Without this a popup of a session's page could be parked only because the opener's target info answered later. A target-info read has a 2 000 ms deadline; a page whose read fails or times out has no known target id or opener and falls to rule 4. A page that closes while undecided keeps waiting and is then recorded as a tombstone at once, so a page it opened still follows it.
4. **Park.** Anything else: a tab or window the operator opened by hand (Ctrl+T, a bookmark, even inside an agent's window), a service worker's `clients.openWindow`, a page Chromium restored, Playwright's internal storage-state page (§3.9). *As built in T1a-2:* a Ctrl/Cmd/Shift- or middle-click (or a modified form submit) opens a target with no `openerId`; the host watches each session page's `Page.frameRequestedNavigation` (disposition `newTab`/`newWindow`) and gives such a target the opener whose request named its URL (within 5 s); when requests of different pages name the same URL it stays parked (fail-closed).

The window a page appears in is never used for attribution. **Invariant (the isolation boundary of live mode, D-50).** For every host at every instant: each page is attributed to at most one session; an attribution never changes; a page enters a session's `TabRegistry` only after it is attributed to that session; a parked page is in no `TabRegistry`; a page whose opener is (or was) attributed to S belongs to S. The site-opened-page subscription that today adds every page of the context to the one session (`packages/core/src/app/sessions/create-phases.ts:250-254`) becomes a subscription to the session's own `SessionView.onPage`. Property tests (§17, T0c) guard the invariant.

**Placement is not attribution.** Chromium puts a site-opened tab into the last active normal window, so a tab opened from session A's popup window can land in session B's window (measured with both drivers). It belongs to A; it is A's page in B's window, and B's active tab may become a background tab there until it closes. The template page lists such windows as "shared by several sessions".

**Parked pages** are listed on the template page (§11.4) with a Close action. They do not count against the agent page caps (§6.3). At most 10 parked pages (the sentinel excluded) stay open per host; beyond that, the oldest is closed and logged. Pages restored at host start are closed (§3.1).

*As built in T1a-2 (T0c entry conditions).* Target facts come from two places: a page's own DevTools session answers `Target.getTargetInfo` (its target id; Playwright exposes no other link from a `Page` to its target), and the host's browser-level session runs `Target.setDiscoverTargets`, which reports every page target with its `openerId` as soon as Chromium creates it. A page target that is destroyed before any page of it was read is handed to the dispatcher as a **lost target** (`HostPageDispatcher.adoptClosedTarget`): decided by the same rules (claim, opener, hold) and tombstoned at once, so a page it opened still follows it; the page object itself, if Playwright adopts it later, gets the same attribution (`committed`). The dispatcher gained an `onCommitted` hook (the host's window waits and its parked-page bound) and an `onReleased` hook: a page attributed to a session that was already released (a popup that arrives after `close_session`) reaches no listener and is closed by the host. The property suite models both (operation `lostTarget`, and a check that every page handed back for a released session is closed), with reentrant listeners, 1 000 cases fast and 100 000 nightly. Chromium refuses `clients.openWindow` from a service worker without a notification click (`Not allowed to open a window`), so the real-Chromium suite asserts that refusal; the parked path such a window would take is the one `context.newPage()` takes, which the suite asserts.

### 3.5 Close semantics

`close_session`, a lease expiry, an operator terminate and a drain close a virtual session the same way: mark it `draining`; abort its held requests (§9.3); close every page it owns with `page.close({runBeforeUnload: false})` (5 s per page, within `sessionCloseTimeout`), which closes its windows; drop its window set, claims, per-page routes and headers (its tombstones stay); call `pageActions.forgetSession` as for every session (`packages/core/src/interface/mcp/tools/lifecycle/index.ts:56`); move or delete its downloads (§5.5); remove its session directory (it has no `userdata`). The host, its context and the other sessions are never touched: `context.close()` and `browser.close()` are host operations only (`packages/core/src/infra/browsers/session-handle.ts:141` closes the context and `:147` the browser today). A session whose last tab closes stays open with zero tabs, as today; its next `new_tab` creates a window.

### 3.6 Crashes

| Failure | Effect |
|---|---|
| A renderer crashes (`page.on('crash')`) | BrowserHive closes every crashed page and removes its tab, so later calls answer `TAB_NOT_FOUND`; `Target crashed` is added to the closed-page pattern of `packages/core/src/infra/browsers/classify-error.ts:40-41`. Same-site pages can share a renderer process, so one crash can close pages of several sessions; the sessions stay live |
| The host browser exits or its context closes (`browser.on('disconnected')`, `context.on('close')`, today `session-handle.ts:71-72`) | **fan-out**: every virtual and maintenance session of the host is marked `crashed` and reaped at once (tools answer `SESSION_DEAD`); the supervisor schedules a restart (§3.2), unless it was an operator stop |
| GPU or network service restarts | Chrome restarts them; pages may see failed requests; nothing is fanned out |

### 3.7 Creation pipeline for a virtual session

The D-21 phase names, spans and compensators are kept; `runCreatePipeline` takes the template branch when `request.template` is set. A virtual-session launch has a total budget of 50 s (`TEMPLATE_LAUNCH_BUDGET_MS`), below the 60 s request timeout of common MCP clients; each waiting step uses at most the remaining budget. The exclusive `DEFAULT_CREATE_DEADLINE_MS` (90 s, `session-service.ts:33`) is unchanged.

| Phase | Exclusive session (today) | Virtual session |
|---|---|---|
| `validate` | `validateCreateRequest` (`packages/core/src/domain/session/create-request.ts:173`) | plus: resolve the template by name, check access (§6.1), apply the option rules (§5.3) |
| `admit` | `CapAdmissionPolicy` (`packages/core/src/domain/session/admission.ts:46`) | `TemplateAdmission`, a separate async step that runs **once** (it is not repeated in `reserve`): template status and host state, template and page caps, then the strategies' `admit` hooks (§9.4; a `launch-spacing` wait is at most `min(20 s, remaining budget)`) |
| `reserve` | registry insert under the lock, with the slot check | the same lock; the slot check counts exclusive sessions plus **starting or running hosts**, and runs only when this launch must start the host (it reserves the host's slot); the row carries `template_id`, `template_name`, `template_version`, `template_mode: 'live'`, `sealed` |
| `prepareProfile` | session directory, restores | session directory without `userdata`; **acquire the host**: start it when `stopped` (or join a start in progress); when the budget runs out first, the launch answers `TEMPLATE_UNAVAILABLE` `reason: 'starting'`, `retry_after_ms: 5000`, and the start continues; then the **pre-launch health check** (§8.2) within `min(10 s, remaining budget)` |
| `resolveIdentity` | geo seed and fingerprint | the host's identity (nothing resolved) |
| `launch` | `driver.launch` | open the first window (§3.3); compensator closes it |
| `installPolicies` | blocklist route on the context | register the session with the host's interception chain (§3.8); per-page extra headers |
| `startTracing` | confirm the trace | none (§5.4) |
| `applyIdentity` | `ensureIdentityForPage(handle.page)` | the same, on the session's first page |
| `register` | first page + context page subscription | first page + `SessionView.onPage` (§3.4) |

`AdmissionPolicy.admit()` (`admission.ts:24-29`) is synchronous, returns a slot refusal mapped to `SESSION_LIMIT_REACHED` and runs twice (`create-phases.ts:91`, `:101`), so template admission does not decorate it; `CapAdmissionPolicy` keeps deciding slots, with `occupied` changed from `registry.size` to exclusive sessions plus starting or running hosts.

### 3.8 Interception on a host

`InterceptionChain` exists today only as a doc-comment seam (`packages/core/src/ports/session-policies.ts:1`, `blocklist-route.ts:37`); the blocklist is a lone `context.route('**/*')` (`packages/core/src/infra/browsers/blocklist-route.ts:57`) installed only when a blocklist is configured (`packages/browserhive/src/composition/phases/domain-sessions.ts:144-163`). PR T0b makes it a type (`infra/browsers/interception-chain.ts`): **one** `context.route('**/*', handler)` per context, installed if and only if a blocklist is configured or the context is a template host, whose handler runs ordered in-process handlers (Playwright runs separately registered route handlers in reverse registration order, so the order is kept inside one handler):

1. **Self-origin guard** (template hosts only, T1a): aborts, fail-closed, every request of every method and resource type to BrowserHive itself, matched by meaning, not spelling: its own origins (the bound host, the canonical loopback names, `allowedHosts`, the `publicUrl` origin, and under a wildcard bind the machine's name and interface addresses), and any `http(s)` URL on one of their ports whose host is loopback in any form (`*.localhost`, 127/8, `::1`, IPv4-mapped or -compatible, `0.0.0.0`; case and a trailing dot ignored). **Redirect hops**, which the route never sees, are refused by the daemon: every template host carries an HttpOnly, `SameSite=Lax` marker cookie (`browserhive_template_host`) for each of those origins, set before anything navigates; the daemon answers any request carrying it with 403 before any route, and its Host guard answers only the canonical loopback names, so the marker covers every name it serves (03 §2). The dashboard can therefore never load in a host window and its session cookie never enters a template's jar (it would be sent to an agent's `navigate`, which Chromium treats as browser-initiated, so `SameSite=Strict` would not stop it). The tool layer answers `navigate`/`new_tab` to these origins with `URL_BLOCKED` `pattern: '#browserhive'` (§5.5).
2. **Blocklist** (11 §5), unchanged.
3. **Request guard** (§9.3; mechanism T0b, pack rules T3a).

A handler ends with `route.fallback()` (pass), `route.abort('blockedbyclient')` or by awaiting a decision (a held `confirm`). Blocking decisions fail closed for document requests, as the blocklist does today (`blocklist-route.ts:89-93`); observation (challenges, `device-bound-session`) fails open. For an exclusive session without a blocklist T0b installs nothing, so its behaviour, including its HTTP cache, is unchanged.

*As built in T0b.* Handlers return a verdict (`pass` or `abort`) and the chain makes the one route call, so no handler can end a request twice; a handler that throws, or returns no valid verdict, is failed closed (documents aborted with `failed`) or open by its declared `onError`. The run order is fixed by handler id (`HANDLER_ORDER`: `self-origin`, `blocklist`, `request-guard`), whatever order handlers are given or registered in. `register(handler)` adds one handler per id and returns a disposer; `install(context)` is idempotent for its context and refuses another one. The owner is resolved lazily and memoized per request. A held handler can ask for an `AbortSignal` that aborts when Chromium fails the request, its page closes or the context closes; the `RequestConfirmer` port receives it. Exclusive sessions still build one chain per `installBlocklistRoute` call; making the chain the host's own (created at host launch, installers register on it, the disposer called on virtual-session close) is a T1a entry condition.

**HTTP cache.** Playwright disables Chromium's HTTP cache on a context while routing is enabled. A host is always routed, so it has no HTTP cache: more requests per page, and a site can observe that nothing is ever served from cache. T1a measures the cost on the fixture site and states it in `docs/guide/templates.md`; a guard that keeps the cache is deferred (§16).

**CORS preflights.** While routing is enabled, Playwright answers a CORS preflight (`OPTIONS`) itself, allowing the requesting origin, methods and headers (`playwright-core` 1.63 `crNetworkManager`), and never hands it to the route. The site's preflight answer is therefore never consulted: a cross-origin write that the server would refuse at preflight is sent (measured with Playwright; Patchright did not send it). The request guard never sees an `OPTIONS` preflight, only the write that follows it, which it matches as usual. This already holds for exclusive sessions with a blocklist (11 §5); T1a makes it hold for every template host and measures it under both drivers, as it does the cache cost.

**Owner of a request** (replacing today's fixed `sessionId`, `blocklist-route.ts:82`):

| Request | Owner |
|---|---|
| `request.frame()` resolves to a page | that page's attribution (a session, or the host for a parked page) |
| A navigation request without a frame yet (the first request of a popup: `frame()` throws) | held until the new page is attributed (at most the 2 000 ms of §3.4 rule 3), then that page's attribution |
| `request.serviceWorker()` is set, or no page can be found | the host (`session_id NULL`, the template in the details). Patchright attributes some service-worker-forwarded requests to the page's frame and Playwright does not, so the owner of such a request depends on the driver |

A host-owned request gets the template's rules. A host-owned `confirm` opens its `security_intercept` on the host's `maintenance` session (§9.3). Audit rows carry the owning session, or `session_id NULL` with the template in their details (`blocked_requests.session_id` is nullable).

**What the chain cannot see** (stated in `docs/guide/site-packs.md`; each pinned by `test/integration/request-guard.test.ts` under both drivers where it is observable):

- redirect hops after the first URL: Playwright routes only the first URL of a redirect chain, so an open or same-site redirect into a guarded URL is not stopped, and because 307/308 keep the method this covers `POST` as well as `GET`. Packs guard known redirectors (§9.3);
- requests from a `SharedWorker` (dedicated workers and service workers are routed);
- `navigator.sendBeacon` and `fetch(…, {keepalive: true})` sent while a page closes (`pagehide`/`unload` during `page.close()`, which `close_tab` and `close_session` do). Packs express writes a site sends on unload as element guards (the tool path);
- WebSocket frames, and requests a page makes from a `javascript:` URL (refused at the tool boundary for agents, D-57).

T1a decides whether template hosts disable `SharedWorker` or accept the gap.

**Operator-facing (stated in `docs/guide/templates.md`, "Known limits").** Because a host is always routed: no HTTP cache; under the Playwright driver CORS preflights are answered by Playwright, so a page an agent visits can send a cross-origin write whose preflight the target site would refuse, with the template's cookies (Patchright does not send it; templates should run with stealth on and the Patchright driver); SharedWorker requests and close-time beacons are not routed (whether a close-time beacon reaches the site depends on timing: measured both ways on CI; the suite pins that the chain never sees it); a redirect into BrowserHive is refused by the daemon; modifier-click tabs are matched to their session by request; page caps bind site-opened pages. Each row is pinned by `template-known-limits.test.ts`, `template-self-origin.test.ts` and `template-pages.test.ts` under both drivers, headless everywhere (the cache and preflight rows headless only: routing does not depend on the display) and headed on the Linux CI leg.

*Decided and measured in T1a-2.* **SharedWorker: the gap is accepted.** Template hosts do not disable `SharedWorker`: disabling it is observable to sites (a feature real Chrome has) and breaks those that use it, while what it hides from the chain is the request guard's concern, whose packs express such writes as element guards (T3a). `docs/guide/templates.md` lists it (and `docs/guide/site-packs.md` will, T3a). **The host owns its chain**: `launchTemplateHost` builds one `InterceptionChain` per host with the self-origin guard and, when a blocklist is configured, the blocklist handler (its hits carry the owning session, or `sessionId: null` for a host-owned request; `BlockedUrlHit.sessionId` is now `string | null`), installs it before any page navigates and keeps it for the context's life. Nothing is registered per virtual session, so `SessionPolicyInstaller.install` is not called for one (no disposer is needed; T3a's request guard registers on the host's chain). A chain that cannot be installed **fails the host start** (fail-closed: without it the self-origin guard is missing), so no route-failure warning code was needed. `resolveOwner` (`hostOwnerResolver`): a service worker's request → the host; a request of a page → its attribution (parked → the host); a navigation whose frame is not attached yet → polled every 25 ms until its page is attributed, at most 2 000 ms, then the host. **Measured on the fixture site, both drivers, headless:** reloading a page with five `max-age=3600` scripts sends all 5 requests again on a host (0 without routing). A cross-origin `fetch` `POST` with a custom header to an endpoint that refuses its preflight: on a Playwright host the server receives the `POST` (Playwright answered the preflight); on a Patchright host it receives nothing (neither `OPTIONS` nor `POST`); without routing both send only the `OPTIONS`.

### 3.9 Single writer, checkpoints and versions

- The host is the only writer of the template: nothing else opens `userdata/`, and no state is restored while a session is attached (§3.12).
- **Storage state** is read with `context.storageState({indexedDB: true})` into memory. Playwright saves localStorage and IndexedDB only for origins a frame of *this* browser process has visited, and for a visited origin with no open page it opens an internal page (parked by §3.4 rule 4, closed by Playwright). Origins the snapshot lacks are therefore **carried forward** from the previous checkpoint (their storage cannot have changed without a page of this process). The result is capped at 64 MiB (`TEMPLATE_STATE_MAX_BYTES`): above it, IndexedDB data is dropped from the largest origins until it fits and `TEMPLATE_CHECKPOINT_TOO_LARGE` (degradation, warn) names them.
- **Checkpoint**: one rolling slot, `versions/latest.state.enc`, overwritten every `templateCheckpointInterval` (default `15m`) while the host runs, at a clean host stop and at daemon shutdown. It writes no version row; `templates.checkpoint_at` and `checkpoint_size_bytes` are updated.
- **Versions** are written only at milestones, each as `current_version + 1` with its `summary`, `health_json` (every site's health state at that moment) and `structure_sha256` (SHA-256 over the sorted cookie `(domain, name)` pairs, localStorage keys and IndexedDB database names, never values):

| Reason | When |
|---|---|
| `recording` | Finish of a recording (§7.1) |
| `relogin` | a re-login reached `signed_in` (§8.4) |
| `restore` | a restore finished (§3.12) |
| `manual` | the operator asked (`POST /templates/{id}/versions`, "Save version now") |
| `import` | the template was seeded from a storage-state file (§7.4) |
| `signin_change` | at a checkpoint, the set of present sign-in cookie names (the pack's `cookie_names` or the learned names) of any site differs from the newest version's |
| `daily` | the first checkpoint of a day (host local time) whose `structure_sha256` differs from the newest version's |

- **Retention.** Kept: the newest `templateVersionsKeep` (default 10) versions, every pinned version, and the newest version whose `health_json` has every enabled site `signed_in` (shown as "Last good", kept as if pinned). Older ones are deleted with their files.
- Storage state excludes sessionStorage, service workers, the Cache API, the HTTP cache, permissions and saved passwords; the live profile keeps all of them (§3.12).

### 3.10 Required launch flags and focus emulation

Hosts and virtual sessions rely on three of Playwright's default switches and on its focus emulation (measured with Playwright and Patchright 1.63):

- `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` MUST stay on the host's command line. Templates take no launch options in v1, and the host's options of §3.1 never remove them.
- `Emulation.setFocusEmulationEnabled` (sent by Playwright on every page) keeps every agent page `visibilityState: 'visible'` and `hasFocus() === true`, so timers, screenshots and the live view's screencast work in background tabs and unfocused windows. No BrowserHive CDP session may disable it, except the `single-focus` strategy for its site's pages (§9.4); a future raw-CDP attach MUST enable it itself.
- **Minimized windows are best effort.** Screenshots and screencasts work in minimized windows in simple cases (about 100 ms per screenshot), but a minimized window holding a background tab after a popup, a dialog and a download stalled `page.screenshot()` in measurements (Wayland, both drivers); hence the screenshot fallback of §3.3 and the `normal` default of `agent_windows`.

### 3.11 Headed hosts and displays

Hosts are headed by default (D-50): a human signs in in them, and several sites challenge headless browsers more often. A template may be set headless; the editor warns that sites may challenge it more often, and it is refused while an enabled site's pack says `headed: 'required'`.

A headed host needs a display on the machine running BrowserHive: a desktop session on Linux (`DISPLAY` or `WAYLAND_DISPLAY`), a logged-in user session on macOS (a LaunchAgent, not a LaunchDaemon), an interactive session on Windows (not a service in Session 0). `Desktop.hasDesktopEnvironment()` (`packages/core/src/ports/desktop.ts:23`) cannot tell: it returns `true` on macOS and Windows unconditionally and only checks that the variables are set on Linux (`packages/core/src/infra/desktop/bun-desktop.ts:37-41`). It stays a hint for `doctor`; the decision is the launch itself: a host start whose browser fails with Chromium's display errors ("Missing X server or $DISPLAY", an Ozone platform initialisation failure, a macOS WindowServer connection failure) is classified `no_display`, the host becomes `failed` with `reason: 'no_display'`, and launches answer `TEMPLATE_DISABLED`.

**Servers.** Run BrowserHive under `xvfb-run -a browserhive serve …` (which creates an X authority cookie), or a sidecar `Xvfb :99 -nolisten tcp -auth <file>` with `DISPLAY=:99` and `XAUTHORITY=<file>`. A bare `Xvfb :99` lets every local user drive and record the signed-in windows and is never recommended. Nobody can see an Xvfb window: recording or a host-window re-login there needs a VNC viewer on that display (`x11vnc -display :99 -auth <file> -localhost`, reached over an SSH tunnel), or the template is seeded from a storage state (§7.4). On a Wayland desktop window activation is compositor-controlled, so BrowserHive never relies on window order.

**Remote operators.** The dashboard compares its client with the server's machine (a loopback client, or the same host name). When they differ, every action that opens a host window (the wizard's sign-in step, Re-login, Show window) says "This opens a window on <host name>, not on this device" and, on Linux without `WAYLAND_DISPLAY`, shows the VNC hint; the maintenance session's live view is shown read-only beside the ticks so a remote operator can watch progress.

### 3.12 Restore (rollback)

`POST /templates/{id}/versions/{version}/restore` (`version` may be `latest`, the rolling checkpoint) answers `202 {operation_id}` and runs in the background, reporting progress on the `templates` topic (`template.host` states, then `template.version`): it drains the host (§3.2; the dialog offers **Close sessions now**, which force-closes them, or **Wait for sessions**), starts it, calls `context.setStorageState(<decrypted state>)`, writes a new version with `reason: 'restore'` and `restored_from` (`0` for the checkpoint), and probes every site. Agents get `TEMPLATE_UNAVAILABLE` `reason: 'restarting'` meanwhile. Playwright's `setStorageState` clears cookies and the localStorage, IndexedDB and OPFS of the origins it knows (those visited in this browser process plus the state's own) and then sets the state; origins outside both keep their data, so a restore brings back sign-ins, not a clean profile. Restoring never edits an old version.

### 3.13 The driver port: `BrowserHost` and `SessionView` (PR T0c)

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
// As built in T0c, BrowserHost extends SessionHost: the facts and page-scoped helpers above
// (hostId, kind, capabilities, driver, identity, browserInfo, warnings, tracing,
// ensureIdentityForPage, browserPid) without browser, context, onCrash and close.

/** What one session may touch: its own pages only. */
interface SessionView {
  readonly sessionId: string;
  readonly host: SessionHost;                      // T0c: never the context, the browser or close()
  readonly page: Page;                             // the first page
  pages(): readonly Page[];
  owns(page: Page): boolean;
  onPage(listener: (page: Page) => void): () => void;      // pages attributed to this session after it opened
  newPage(): Promise<Page>;                        // exclusive: context.newPage(); virtual: §3.3
  cookies(urls?: readonly string[]): Promise<Cookie[]>;
  addCookies(cookies: readonly CookieInput[]): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;   // exclusive: context-wide; virtual: per page, replayed on new pages
  newCDPSession(page: Page): Promise<CDPSession>;                         // the live view's bridge; refuses a page never attributed to this session
  storageStateSource(): StorageStateSource | null;                       // null for virtual sessions
  userDataDir(): string | null;                                          // null for virtual sessions
  onCrash(listener: (reason: string) => void): () => void;              // host crash fan-out plus its own
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]>;  // exclusive: closes the host; virtual: §3.5
}

interface BrowserDriver {
  stealthDriverName(): 'patchright' | 'playwright';
  launch(spec: LaunchSpec, signal?: AbortSignal): Promise<{ view: SessionView; host: BrowserHost }>;  // an exclusive host and its one view; the session keeps the view, the pipeline uses the host for policy install
  launchTemplateHost(spec: TemplateHostSpec, signal?: AbortSignal): Promise<TemplateHost>;   // PR T1a
}
interface TemplateHost extends BrowserHost { openView(sessionId: string, opts: { windowState: 'normal' | 'minimized' }): Promise<SessionView>; parkedPages(): readonly Page[]; }
```

The port's isolation sentence becomes: "An exclusive host MUST NOT be shared between sessions; a template host is shared only by the virtual sessions of its template, and its views MUST satisfy the attribution invariant of spec 13 §3.4." Everything that reaches a session's context or handle today moves behind the view or the host:

| Reach-in today | Moves to |
|---|---|
| `contextOf` in the state tools (`packages/core/src/interface/mcp/tools/state/index.ts:15`, `:36`, `:51`, `:100`) | `SessionView.cookies`/`addCookies`/`setExtraHTTPHeaders` |
| the storage-state source of `save_storage_state` (`packages/core/src/interface/mcp/tools/auth-states/index.ts:23`) | `SessionView.storageStateSource()` |
| `newTab` (`session-tabs.ts:41`) | `SessionView.newPage()` |
| the site-opened-page subscription (`create-phases.ts:250-254`) | `SessionView.onPage` |
| close (`packages/core/src/app/sessions/session-close.ts:92-107`) | `SessionView.close` |
| `session.handle?.capabilities` (`packages/core/src/interface/mcp/tools/interaction/act.ts:21`) | `SessionView.host.capabilities` |
| identity and `browserInfo` from the handle (`packages/core/src/domain/session/session.ts:128`, `:277-279`) | `SessionView.host.identity`/`browserInfo` |
| `SessionPolicies.install(handle, …)` (`packages/core/src/ports/session-policies.ts`, `domain-sessions.ts:146` uses `handle.context`) | `install(host, …)` registering with the host's `InterceptionChain` |
| the live view's handle access (`packages/core/src/interface/ws/live-view.ts:288`, `:344`) | `SessionView.pages()` and the host for the screencast |
| the CDP bridge's `newCDPSession` (`packages/core/src/interface/ws/cdp-bridge.ts:127`) | `SessionView.newCDPSession` (the host context, scoped to the view's pages) |
| `browserPid` for metrics (`packages/browserhive/src/composition/phases/wire-observers.ts:41-45`) | `BrowserHost.browserPid` (keyed by host) |
| the vault's tracing handle (`packages/core/src/interface/mcp/tools/vault/index.ts:97`) | `SessionView.host.tracing` |

`IdentityApplier`'s context-wide `context.on('page')` (`identity-applier.ts:137`) stays on the host.

*As built in T1a-2 (deviations).* The template host's port is `ports/template-host.ts`: `TemplateHost extends BrowserHost` with `openView(sessionId, {windowState, maintenance?, pageOptions?, beforeNewPage?, signal?})`, `agentPageCount()`, `sessionPageCount(id)`, `parkedPages(): ParkedPageInfo[]` (the sentinel excluded), `viewIds()` and `onExit(listener({reason, operatorStop}))`; it is started by a separate port, `TemplateHostLauncher.launchTemplateHost(spec)` (implemented by `PlaywrightBrowserDriver`), rather than a member of `BrowserDriver`, so the exclusive driver fakes are untouched. `TemplateHostSpec` carries the template's channel, headless, stealth, fingerprint, the pinned identity (`seed`, geo), the resolved proxy, the window size, BrowserHive's own origins (for the self-origin guard) and `testingArgs` (the §14 seam's Chromium switches). The supervisor (app) holds only these ports, so `app/` keeps no infra import, and a session holds the view, whose `host` is the narrow `SessionHost`. The creation pipeline's template branch is `app/sessions/virtual-phases.ts` (same phase names, spans and compensators); `SessionService.createVirtual` runs it with a `VirtualSessionLauncher` the supervisor builds per launch. T0c's acceptance includes that no module under `interface/` imports `BrowserContext` (a dependency-cruiser rule, `interface-no-playwright`: dependency-cruiser cannot match imported names, so `interface/` takes Playwright's page-level types only from `ports/page-types.ts`, which does not export `BrowserContext`). An import rule alone would still let a session reach the context through a value, so T0c also types `SessionView.host` as the narrow `SessionHost`, and a grep rule (`packages/core/test/lint/grep-rules.test.ts`) forbids `.context()` and `host.context`/`browser`/`close`/`onCrash` in `interface/` and `app/` (Playwright's `Page.context()` cannot be hidden by a type). The scheme guard's CDP retry uses `SessionView.newCDPSession`. `test/lint/depcruise-rules.test.ts` runs the rules against a fixture tree that breaks each one, so an inert rule fails CI.

## 4. Settings shared by the whole browser

A context-level setting is the template's, never a session's. The table fixes, for every setting a session could ask for, whether a virtual session can have its own value.

| Setting | Scope in a host | Per virtual session | How |
|---|---|---|---|
| User agent, UA-CH, `Accept-Language` | host (one identity) | no | the pinned identity (§2.2); the per-page CDP override is replayed on every attributed page (11 §2.3) |
| Locale, timezone, geolocation, permissions | host | no | context options from the pinned identity |
| Proxy, egress IP, WebRTC IP policy | host | no | the pinned proxy; `webrtc-policy` (§9.4) |
| Cookies, localStorage, IndexedDB, Cache API, service workers, SharedWorkers, BroadcastChannel, Web Locks | host (shared) | no | shared by design: one person, one jar |
| `sessionStorage` | page | yes | per tab, copied into a `window.open` popup |
| Request routing (`context.route`) and HTTP cache | host | no | one interception chain, per-request owner resolution; no HTTP cache (§3.8) |
| Extra HTTP headers | page | yes | `page.setExtraHTTPHeaders` on the session's pages, replayed on new ones |
| Viewport | page | yes | `page.setViewportSize`, plus window size on a headed host (§3.3) |
| Color scheme | page | yes | `page.emulateMedia({colorScheme})` |
| Clock, offline emulation, HTTP credentials, `recordVideo`, `bypassCSP`, `javaScriptEnabled`, `serviceWorkers`, `ignoreHTTPSErrors`, `isMobile`, `hasTouch`, `deviceScaleFactor` | host | no | Playwright's defaults for hosts; never set |
| Tracing | host | no | off for virtual sessions in v1 (§5.4) |
| Downloads directory | host | no | the host's `downloads/`, claimed per page (§5.5) |
| Humanize state, evaluate permission | session | yes | per session, as today (`packages/core/src/infra/browsers/page-actions.ts:51-61`) |
| Vault fills | — | no | refused in virtual sessions (§5.5) |

---

## 5. Agent surface

**Agent-facing text** (owner decision 2026-11-08). Every string an agent receives (tool descriptions, result fields, warnings, notes, error messages, hints and details) says what the session can and cannot do: it starts signed in to the template's sites; signing out or changing account, security or privacy settings is not allowed and may be blocked or need the operator's approval; sign-ins and site data it changes are kept in the template and carried into later sessions from it; cookie values are hidden, and `evaluate` and saving the login are unavailable unless the operator allows them. None explains how templates work (a shared browser, windows, hosts), and none reveals that other agents or sessions exist: no agent-visible result carries a count of a template's sessions, a `mode`, a host state, or a reason that names the mechanism. Operator surfaces (REST, WS, dashboard, CLI, logs) keep the full detail. A golden test lists every agent-visible string that only template sessions produce (the `list_templates` and `template` descriptions, the `TEMPLATE_*`, `SESSION_SEALED` and `SITE_*` messages, hints and detail texts, notes and warnings) and fails on the words `browser`, `window`, `host`, `shared`, `other session`, `sibling`, `agents` or `in use`.

### 5.1 `list_templates` (new tool, pack `templates`, PR T1a)

| Tool | Input | Output | Errors | RO/D/I/OW |
|---|---|---|---|---|
| `list_templates` | `{}` (`z.object({}).strict()`) | `{ templates: [{ name, display_name, description, sites: [{ site, title, status: 'signed_in'\|'signed_out'\|'challenged'\|'inconclusive'\|'unknown', checked_at: number\|null }], availability: 'available'\|'busy'\|'needs_login'\|'unavailable', sealed: boolean }] }` sorted by `name` | `TOOL_NOT_AVAILABLE` (when `templates=false`) | yes/no/yes/no |

- **Only templates the caller may launch are listed** (§6.1); a template the caller may not use is absent, never marked. `site` is the registrable domain; `title` the pack's title or the domain; disabled sites are omitted.
- `availability`: `available` (a launch would be admitted now; a stopped host counts as available, it starts on launch); `busy` (the template is at capacity, or a strategy defers launches, §9.4); `needs_login` (every enabled site is `signed_out` or `challenged`); `unavailable` (the template is not `ready`, or cannot run until the operator acts). No count of sessions, no `mode` and nothing about other sessions is returned (D-09, §5).
- Pack `templates`, capability `read`, `since` = the release that ships T1a (`TEMPLATES_SINCE`, `0.4.0` as built in T1a-1 because 0.3.0 is planned for other work; the final feature PR moves it if templates ship later). Registration order: appended after `vault_fill` (02 §3.14), so the existing 43 keep their positions. A new tool gets a strict empty input schema; the argument-less legacy tools keep theirs (D-12). The MCP server `instructions` (02 §1) gain one sentence: "Use list_templates to find session templates the operator has signed in to sites; launch_session with template starts a session that is signed in to them."
- Description (§5): "List the session templates you may use. A session launched with a template's name as `template` starts signed in to the template's sites. The sign-ins belong to the operator: do not sign out, and do not change account, security or privacy settings; such actions may be blocked or need the operator's approval. Sign-ins and site data the session changes are kept in the template and carried into later sessions from it. Cookie values are hidden, and evaluate and saving the login are unavailable unless the operator allows them."

### 5.2 `launch_session.template` (new optional parameter, PR T1a)

`template?: string` (`^[a-z][a-z0-9-]{1,31}$`): the template's `name`. Described as: "Name of a session template from list_templates. The session starts signed in to the template's sites; sign-ins and site data it changes are kept in the template." `slug` stays required and names the session as usual (`<slug>-<nanoid8>`).

The `launch_session` description, which today says that each session owns its own browser so cookies never leak between sessions (`packages/contracts/src/tools/lifecycle.ts:62-66`), becomes: "Launch a new browser session. Without `template`, the session is fully isolated: it owns its own Playwright driver, browser, context and page, and its cookies and storage are its own. With `template`, the session starts signed in to the template's sites (see list_templates). The resolved session_id is '<slug>-<nanoid8>' and is returned as the 'session_id' field." Descriptions are not frozen by D-12; the `tools.json` golden changes.

`SessionMetadata` (the result of `launch_session`, `list_sessions`) and `session_info` gain one additive key for template sessions only: `template: { name, sites: [{ site, status }] }` (D-12: a new result key). Exclusive sessions do not carry it.

### 5.3 Launch options on a template

The schema bakes defaults into five parameters (`channel`, `incognito`, `headless`, `disable_evaluate`, `vault_enabled`; `packages/contracts/src/tools/lifecycle.ts:46-54`), so the server cannot tell an explicit value from a default for those five. The rules:

| Parameter | Rule on a template launch |
|---|---|
| `channel`, `headless`, `incognito` | **ignored**: the template's values apply (never refused, because they always arrive) |
| `disable_evaluate` | applied as sent; a sealed template forces `true` (§5.4) |
| `vault_enabled` | ignored: vault fills are refused in virtual sessions (§5.5) |
| `humanize` | applied as sent; collapses to `false` when the template's `stealth` is `off`; a `humanize-input` strategy forces it on for its site (§9.4) |
| `stealth`, `fingerprint` | refused when present and different from the template's |
| `persistence_mode` | `memory` accepted (it is what the session reports); `persistent` or `storage-state` refused |
| `restore_profile` | refused when present |
| `launch_options` | refused when it has any key (`{}` is accepted) |
| `context_options` | `viewport`, `extraHTTPHeaders` and `colorScheme` are applied per session (§4); any other key is refused when present, whatever its value |

A refusal is `INVALID_ARGUMENTS` with one issue per offending option, `path` naming it (`context_options.locale`) and the message `template '<name>' fixes <option>; omit it` (02 §2.3 text format). Launch and context options are refused by presence, not by comparing values, so a refusal never tells an agent whether a guessed value (a proxy password, the operator's coordinates) equals the template's.

### 5.4 Sealing and tracing (D-51)

**What sealing is.** Sealing keeps the raw session material (cookie values and storage exports) out of what agents receive. It does not stop an agent from acting as the account: with `click`, `fill` and `snapshot` an agent can create durable credentials (an API token, an SSH key, an app password, a recovery address, an OAuth consent for another application) unless a guard blocks that flow (`credential` guards, §9.3), and a page may embed tokens in its HTML. It covers tool-initiated reads only: a site's own scripts read non-HttpOnly cookies as usual. It is effective only against agents whose sole access is BrowserHive's MCP interface: an agent that can run code as BrowserHive's OS user (a local harness with a shell, typically under the `stdio` transport) or connect to its display can read or drive the template directly (§13).

Template sessions are **sealed** unless the operator unseals the template. Unseal flags (`unseal_json`, each `false` by default) and the optional `principals` list (empty or absent = every principal the template allows; otherwise the flags apply only to sessions launched by those principals, and every other session is sealed):

| Flag | Sealed behaviour (default) | Unsealed | Editor text |
|---|---|---|---|
| `cookie_values` | `get_cookies` returns only cookies of the template's sites, their packs' `domains` and `shares_login_with` domains, each with `value: ""` (name, domain, path, expiry and flags kept), and the additive result key `sealed: true` | full values of every cookie, as for exclusive sessions (never persisted, D-20) | "Agents can copy these sign-ins out of BrowserHive." |
| `evaluate` | `disable_evaluate` is forced `true`: `evaluate` answers `EVALUATE_DISABLED` with `scope: 'session'` (02 §3.6), byte-identical to a session launched with `disable_evaluate: true` | the session's `disable_evaluate` and the server's `allowEvaluate` apply as usual | "The agent can read storage and non-HttpOnly cookies and can run code that other sessions of this template will load (storage, caches, service workers). Treat it as unsealing everything for every agent this applies to." |
| `cookie_writes` | `set_cookies` answers `SESSION_SEALED` | allowed; it changes the jar of every session of the template | "Changes the sign-ins of every session of this template." |
| `state_export` | `save_storage_state` answers `SESSION_SEALED` | allowed; the snapshot is saved under the caller's own auth-state namespace (02 §6) with `source_template_id` in its manifest | "Equivalent to showing cookie values. Sessions started from an exported state are copies of this sign-in and can sign the template out (§15)." |

- **Redaction.** In a sealed session (without `cookie_values` for that principal), before any agent-facing text result leaves the dispatcher and before it is stored in `tool_calls.result_text` (`get_content`, `snapshot`, `wait_*` messages, error messages and details), every occurrence of a value of a cookie currently in the host's jar of length ≥ 12 is replaced with `[sealed]`. The dispatcher reads the jar at most once per result (cached for 5 s). Screenshots and the live view are not redacted; tokens a page embeds that are not cookie values are not redacted.
- **Never sealed away**: `save_full_profile` always answers `INVALID_PERSISTENCE_CONFIG` in a virtual session, as today for a session that is not `persistent` (`auth-states/index.ts:42`); `set_extra_http_headers` applies to the session's pages only (§4).
- **URL schemes.** A `javascript:` URL would run agent-written script in the page and bypass a forced `disable_evaluate`; D-57 (PR T0d, shipped in 0.2.3) refuses it, and every other non-web scheme, for every session (§5.5, §17).
- A restore of a saved auth state whose manifest has `source_template_id` into an exclusive session adds the session warning `TEMPLATE_STATE_COPY` ("This session started from a copy of template '<name>''s sign-ins; using the copy can sign the template out").

**Tracing is off for virtual sessions in v1.** A Playwright tracer is per context: a host trace would record every agent's pages, and the vault's pause/resume around a fill (`packages/core/src/domain/vault/broker.ts:264`, `:305`) would cut every sibling's trace and could let a sibling's keystrokes into a resumed chunk (D-13). `GET /sessions/{id}/trace.zip` answers 404 `TRACE_UNAVAILABLE` with `enabled: false`; the dashboard explains why (§11.4). A per-page trace split is deferred (§16).

### 5.5 Tool-by-tool behaviour in a virtual session

U = unchanged (page-scoped through `TabRegistry`, correct once attribution is, `packages/core/src/interface/mcp/tools/shared.ts:11-13`); S = scoped or changed as stated. The T0d scheme rule applies to every session and is listed here for completeness.

| Tools | | In a virtual session |
|---|---|---|
| `launch_session` | S | §5.2–§5.3; the pipeline of §3.7 |
| `close_session` | S | closes the session's pages and windows only (§3.5) |
| `list_sessions`, `get_attention_result`, `request_attention`, `list_saved_auths` | U | ownership as today; maintenance sessions are never listed to agents; `get_attention_result` also re-attaches to a `security_intercept` request of the caller's session (§9.5) |
| `server_status` | S | shape unchanged; `sessions.count` counts browser slots in use (exclusive sessions plus running template hosts), the number `limit` bounds, so no agent result counts template sessions (§5, §6.3) |
| `session_info` | S | `config` reports the template's channel, headless, stealth and fingerprint, `persistence_mode: 'memory'`, `incognito: false`, `vault_enabled: false`; additive `template` (§5.2) |
| `navigate`, `new_tab(url)` | S | every session (T0d, D-57): only `http:`, `https:` and exactly `about:blank` (plus `data:` in exclusive sessions), else `URL_SCHEME_NOT_ALLOWED`; template sessions also: `URL_BLOCKED` `pattern: '#browserhive'` for BrowserHive's own origins (§3.8), pack `GET` document guards (§9.3), `stop` (§9.5) and strategies (§9.4); `new_tab` places the tab per §3.3 and answers `TEMPLATE_BUSY` at a page cap (§6.3) |
| `go_back`, `go_forward`, `reload`, `wait_for_url`, `wait_for_selector`, `wait_for_load_state`, `snapshot`, `get_content`, `accept_next_dialog`, `dismiss_next_dialog`, `upload_file` | U | site-pack guards and strategies apply on in-scope pages (§9.3, §9.4); results are redacted when sealed (§5.4) |
| `screenshot` | S | the CDP fallback of §3.3 |
| `click`, `type_text`, `fill`, `hover`, `select_option`, `scroll`, `drag_and_drop` | U | humanize per session; element guards and strategies on in-scope pages |
| `press_key` | S | as above, plus the clipboard-chord refusal of §3.3 |
| `close_tab`, `list_tabs` | U | |
| `switch_tab` | S | `bringToFront()` on headless hosts only (§3.3) |
| `set_viewport` | S | per page, plus window size when headed |
| `set_extra_http_headers` | S | per page, replayed on the session's new pages |
| `evaluate`, `get_cookies`, `set_cookies`, `save_storage_state` | S | sealing (§5.4) |
| `save_full_profile` | S | `INVALID_PERSISTENCE_CONFIG` (§5.4) |
| `download_file` | S | the download is attributed by `download.page()` and saved into `sessions/<id>/downloads` (`saveAs`); a download no session claims within 60 s is deleted from the host's `downloads/` |
| `vault_list_available` | S | returns no entries, with `note: "Vault fills are not available in template sessions; the operator keeps the template signed in."` |
| `vault_fill` | S | returns `blocked` with `reason: 'not_authorized'` and writes one `vault_access` row with reason `template_session`: a fill would sign the shared jar in for every principal the template allows, bypassing the binding's own principal, slug and harness rules (D-14); re-login is the operator's (§8.4) |
| `list_templates` | new | §5.1 |

`SessionMetadata` for a virtual session (D-12: no new enum value): `persistence_mode: 'memory'` (the session itself keeps nothing; cookies and site data it changes persist in the template, as the `template` parameter's description says), `incognito: false`, `headless`/`channel`/`stealth`/`fingerprint` = the template's, `disable_evaluate` = the effective value (`true` when sealed), `vault_enabled: false`, `identity` = the host's applied identity, `proxy_label` = the template proxy's label.

### 5.6 What an agent can still observe

These follow from the design. `docs/guide/templates.md` (operator documentation) states them; no agent-facing string explains them (§5):

- **Shared state.** Cookies and storage change underneath the session when a sibling acts; `storage` events, BroadcastChannel and SharedWorker messages arrive from sibling windows; service workers are shared.
- **Shared sign-out.** A sibling (or the site) signing the account out signs every session out. Packs guard logout and account pages (§9.3); `list_templates` and the `template` key of `session_info` report site status.
- **Shared fate.** A host crash ends every session of the template with `SESSION_DEAD` (§3.6); a recycle answers new launches with `TEMPLATE_UNAVAILABLE`.
- **Focus.** Every agent page reports `visible` and `hasFocus() === true` at once (focus emulation, §3.10), except where `single-focus` applies (§9.4); a background tab of a headed host runs `requestAnimationFrame` at about 15 fps (§3.3).
- **Placement.** A tab the site opens from a popup window may appear in another session's window; it is still the opener's (§3.4).
- **Sealing refusals** (`SESSION_SEALED`, `EVALUATE_DISABLED`, empty cookie values, `[sealed]`) and the vault refusal reveal that the session comes from a template; they do not reveal the mechanism.

---

## 6. Policy and access (D-52)

### 6.1 Who may list and launch

- **Operators** create, edit, record, re-login, restore and delete templates (scopes in §6.2). **Agents** only list and launch them; no tool changes a template.
- A template's grant reuses the vault's rule shapes: `authorized_principals` (empty = any principal; matched with `isPrincipalAuthorized`, `packages/core/src/domain/vault/bindings.ts:93`) and an optional `harnesses` list matched with `isHarnessAllowed` (`packages/contracts/src/harness/index.ts:488`; the vault's `checkHarnessRules`, `packages/core/src/domain/vault/harness-rule.ts:39`, combines a binding list with a group list a template does not have), with D-48's semantics unchanged: no list = all harnesses, an empty list = none, known slugs against the launch harness, custom names exactly against the launch declared name. Gate order: template exists and is not `recording` → principal → harness. The harness is the launching call's resolved identity, which becomes the session's launch harness (`sessions.harness`, D-30); for `list_templates` it is the listing call's.
- The harness list is a **narrowing guard, not a security boundary** (D-48): real separation is one API token per agent with `authorized_principals`. The editor shows D-48's one-line note and warnings.
- A refusal is indistinguishable from absence: `launch_session` answers `TEMPLATE_NOT_FOUND` with the same message and details as for an unknown name and `list_templates` leaves the template out (D-09, D-14). The operator sees the real reason in the access tester (`POST /templates/{id}/access/resolve`, §11.1) and in one `info` log line per refused launch (`template launch refused`, with `template_id`, `reason: 'principal_not_allowed'|'harness_not_allowed'|'recording'`), never in anything the agent receives.
- Session ownership is unchanged: a virtual session is owned by the principal that launched it (D-09); the template's owner is a different principal.
- **Maintenance sessions are never an agent's.** `sessionOwnership` (`packages/core/src/interface/mcp/policies.ts`) refuses a session with `template_mode = 'maintenance'` to every agent principal with `SESSION_NOT_FOUND`, before the owner comparison; `list_sessions` never returns one. The subjects `browserhive`, `local` and `system` and every subject starting with `template:` are reserved: token creation refuses them (PR T0f, shipped in 0.2.3, 03 §3.5), so no agent principal can be named after the system owner of maintenance sessions or the `local` owner of legacy auth states. Auto-relogin acts as the synthetic principal `template:<template_id>` (§8.4), which has no token and cannot log in.
- `AuthorizationRule` and `isPrincipalAuthorized` move from `domain/vault` to a shared `domain/policies/access-rule.ts` (T1a); the vault imports them from there, with no behaviour change.
- **Default access.** Under `auth=off` every agent is `local`, so a new template created without `policy.authorized_principals` stores the principal **`local`** and all harnesses ("All agents of this hive"): identical to "any principal" while auth is off. After a switch to `auth=token` such a template is reachable by operators only, because no token can be `local` (reserved, T0f), until its access is edited; `doctor` warns (check `template access`: every template whose access names only `local` while `auth=token`). An explicit `[]` ("All agents") stays any principal under either mode. Under `auth=token` the wizard preselects nothing and requires an explicit choice ("All agents" or a list), and `POST /templates` without `policy.authorized_principals` answers 400 `VALIDATION_FAILED`, because "any principal" makes the new bearer credential usable by every token at once. Access and unseal lists refuse the reserved subjects `browserhive`, `system` and `template:*` with 400 `VALIDATION_FAILED` (`local` is allowed: it is the `auth=off` principal).

### 6.2 Scopes

Five scopes join the 19 of 03 §3.5 (`packages/contracts/src/enums/scope.ts:5-25`); operators hold all of them (`OPERATOR_SCOPES`, `packages/core/src/domain/auth/scopes.ts:10`); agents keep `mcp:tools` only. Since 0.2.3 the credential decides (03 §3.5): a dashboard session holds every scope, an operator API token exactly its credential's. A token stored as `[]` (issued without `scopes`) gains the five; a token issued with the 0.2.x full list is rewritten to `[]` by migration v9 (§2.5); a token with any other list does not gain them and, no longer holding every operator scope, cannot reach the account routes (`/auth/tokens`, `/auth/grants`, …) either, which is already true of every narrowed token.

| Scope | Grants |
|---|---|
| `templates:read` | list and read templates, sites, health, probes, versions, hosts; the `templates` WS topic; together with `sessions:read`, the live view and screenshots of template sessions |
| `templates:write` | create, edit, delete, disable, restore, save versions, pin versions, start/stop/restart hosts, close parked pages, seed from a storage state |
| `templates:login` | start a recording, re-login, open host windows on the BrowserHive machine, watch the live view of maintenance sessions; with `vault:write`, link a vault binding for auto-relogin. Separate because it drives a signed-in browser and sees the operator type |
| `sitepacks:read` | read packs, diffs, change history, guard hits, registry status; the `site-packs` WS topic |
| `sitepacks:write` | download, apply, reject, revert and pin pack versions, set follow, approve local files, enable and disable packs, import packs, run an update check |

### 6.3 Capacity and admission (D-56)

- **Browser slots.** `maxSessions` (D-21) bounds browsers: each exclusive session uses one slot and each **starting or running host** uses one slot, whatever its number of virtual sessions. `CapAdmissionPolicy` compares `exclusive sessions + starting or running hosts` with the effective cap, under the registry lock (§3.7); a launch that needs a host start when no slot is free answers `SESSION_LIMIT_REACHED`, whose `{limit, live}` now counts browsers.
- **Counting.** Operator surfaces count virtual sessions as sessions (`/system.capacity.live`, `browserhive.sessions.active` with `mode`) and add `/system.capacity.browsers` (exclusive sessions + starting or running hosts), which `max` bounds; the dashboard's capacity bar and the D-44 `capacity` anomaly check use `browsers`. The agent-visible `server_status.sessions.count` is defined as that browser count, the number its `limit` bounds, so an agent never sees template sessions counted (§5). Maintenance sessions are counted nowhere except `browserhive.sessions.active{mode="maintenance"}`.
- **Template cap.** At most `max_concurrent` (default 5, range 1–20) live agent virtual sessions per template. The effective cap is `min(max_concurrent, min over the enabled sites' pack concurrency.max_sessions)`, further scaled by `ramp-up` (§9.4). At the cap: `TEMPLATE_BUSY` (`limit_kind: 'capacity'`).
- **Pages.** Agent pages only (parked and maintenance pages excluded): at most `templateMaxPagesPerHost` (default 40, range 2–200) per host, and at most `max(2, floor(templateMaxPagesPerHost / effective cap))` per session, so one session cannot take every page. Beyond the host cap a launch or `new_tab` answers `TEMPLATE_BUSY` with `limit_kind: 'capacity'`; beyond the session cap `new_tab` answers it with `limit_kind: 'tabs'`.
- **Admission order** for a virtual session, each step failing typed: access (§6.1; unknown, unauthorized or still-`recording` → `TEMPLATE_NOT_FOUND`) → template not `disabled` (`TEMPLATE_DISABLED`) → host not `draining`/`crashed` (`TEMPLATE_UNAVAILABLE`) and not `failed` (`TEMPLATE_DISABLED`) → template cap and page caps (`TEMPLATE_BUSY`) → strategies' `admit` hooks (`launch-spacing`, `active-hours`, §9.4) → browser slot and host start (`SESSION_LIMIT_REACHED`, `TEMPLATE_UNAVAILABLE`) → pre-launch health (§8.2, `TEMPLATE_NEEDS_LOGIN`). Health runs after the host is up, so a cold start does not spend the probe budget.
- **Memory planning** (measured, headless, Wikipedia pages): one extra page in a shared browser costs about 80–100 MB PSS against about 210–230 MB for an extra browser; 10 sessions in one browser about 1.3 GB against 2.3 GB as 10 browsers. A host can grow to `templateRecycleRss` (3 GiB, two slots' worth of D-21's 1.5 GiB budget) before it is recycled; `doctor`'s "maxSessions vs RAM" check counts each template that has run in the last 24 h at `templateRecycleRss`.

*As built in T1a-2.* The per-session page cap also binds pages a site opens: a page attributed to a session beyond its cap is closed at once (never another session's) and the session gets the `SESSION_PAGE_LIMIT` warning, so one session's site cannot exhaust the host's agent pages for the others. `TemplateAdmission` is `admitTemplateLaunch` (`app/templates/template-admission.ts`): draining → `TEMPLATE_UNAVAILABLE` `restarting`, crashed → `recovering` with `retry_after_ms` until the restart, failed → `TEMPLATE_DISABLED` `needs_operator`, then the template cap (live agent sessions plus launches already admitted, so concurrent launches cannot overshoot) and the host's agent-page cap → `TEMPLATE_BUSY` `capacity`. The browser slot is checked under the registry lock only when the launch must start the host, and the host is marked `starting` before the lock is released. `server_status.sessions.count` is exclusive live sessions plus starting, running or draining hosts; `SessionService.occupiedSlots()` is the admission input for both exclusive and template launches. Measured (headless, six windows on the fixture site): each extra virtual session adds about 160–170 MB of process-tree RSS (RSS, not PSS: shared pages count once per process). `/system.capacity.browsers` (operator surfaces) is T1b's with the other `/system` and REST changes.

---

## 7. Recording workflow

Recording is how an operator creates a template's sign-ins: a real, headed window on **the machine running BrowserHive**, driven by hand (typing, IME, OAuth popups, passkeys and security keys on that machine). Playwright launches Chromium with `--disable-extensions`, `--password-store=basic` and (on macOS) `--use-mock-keychain`, and §3.1 turns Chrome's password manager off, so password-manager extensions and the operator's saved passwords are not available in the window; the wizard says so. Recording through the dashboard's live view is deferred (§16), because live-view input lacks clipboard, IME and tab switching (04 §16).

### 7.1 Dashboard

`/templates/new` is a five-step wizard (§11.4); the wizard step is in the URL (`?step=`), focus moves to the step heading on Next and Back, and steps 3 and 4 open pre-filled with **Next** focused and a **Skip to sign-in** link, so the shortest path is name → sites → sign in → Finish.

1. **Name**: name (with the agent-facing grammar), display name, description.
2. **Sites**: search the site catalog (every pack, `GET /site-packs`; domains only before T3a) or add any domain. Each chosen site shows the pack's title, its provenance, version and SHA-256 (adding the site approves that version, §9.6), its terms clause, stance and default write policy (§9.3), "a human must sign in" for `human_only` sites, `shares_login_with` groupings ("Glassdoor uses the Indeed login") and its requirements (Chrome, headed, proxy recommended, a stealth floor). A pack that prefers a channel that is not installed says so ("linkedin.com prefers Chrome; Chrome is not installed — `browserhive init --installChrome`") and the template uses the default channel only after the operator confirms.
3. **Identity and network**: channel, stealth level, fingerprint, headless (warned), proxy (server, username, password **environment variable name**), locale and timezone (pre-filled from the host; required with a proxy).
4. **Access**: who may use it (§6.1 default access; principals, harnesses with D-48's picker), concurrency cap, sealing (all sealed by default; "Allow evaluate" and the other unseal flags as checkboxes with the editor texts of §5.4, and the principals they apply to). **Next** (or Skip) calls `POST /templates` (status `recording`).
5. **Sign in**: "Open browser on <host name>" (§3.11 remote-operator text) starts the host headed and opens one maintenance window with one tab per site at its pack's sign-in URL (a generic site opens `https://<site>/`); the operator signs in. BrowserHive snapshots the jar's cookie names when the window opens. Every 5 s it checks each site's sign-in cookies by name (no navigation): for a site with a pack, when its `cookie_names` appear it runs the site's probe (§8.1) and shows a tick: "Signed in", "Signed out", "Check needed" (challenged, with the reason), "Couldn't tell" (inconclusive). For a generic site, the step shows **I'm signed in** per site: pressing it snapshots the names again, and the names added on the site's registrable domain since the window opened, excluding analytics names (`ANALYTICS_COOKIE_PATTERNS`: `_ga*`, `_gid`, `_gat*`, `_fbp`, `_fbc`, `__cf_bm`, `_cfuvid`, `__utm*`, `_hj*`, `_uetsid`, `_uetvid`, `ajs_*`), become its `learned_cookie_names` (at most 16) and the tick reads "Signed in". **Finish** runs every probe once more, lists **unlisted sign-ins** ("Also signed in to: google.com — agents can use this") with **Remove sign-in** preselected for each, writes version 1 (`reason: 'recording'`, from T1b) and sets the template `ready`. A site that is not signed in at Finish is kept, marked signed out, and offered for re-login.

The recording window belongs to a maintenance session owned by the operator; closing the browser window by hand cancels nothing (the host keeps the sentinel), and **Cancel** closes the maintenance session and leaves the template in `recording`. A template in `recording` is listed with the status "Setting up" and **Continue sign-in**. Step 5's error states each have copy and an action: `no_display` (the CLI command to run on the BrowserHive machine, §7.2, and the server guidance of §3.11), `proxy_unreachable` (the proxy address and a link to step 3), `SESSION_LIMIT_REACHED` (close a session or raise `maxSessions`), `BROWSER_NOT_INSTALLED` (the install command), and a host crash (§3.2).

### 7.2 CLI

```
browserhive templates create job-hunt --sites linkedin.com,indeed.com [--channel chrome] [--displayName "Job hunt"]
    [--description <text>] [--proxy http://host:port --proxyUsername <name> --proxyPasswordEnv <ENV>]
    [--locale en-CA --timezone America/Toronto] [--maxConcurrent 5] [--headless] [--noLogin] [--fromState <file>]
    [--allPrincipals | --principal <subject>…] [--timeout 30m]
```

The command creates the template over the REST API (the server must run with `--admin`; under `auth=token` one of `--allPrincipals` or `--principal` is required, §6.1), starts recording, prints one line per site and updates it as probes finish (`linkedin.com  ✓ signed in`), and finishes when every site is signed in, when the operator presses Enter (confirming every generic site, §7.1), or at `--timeout` (default `30m`; the template stays `recording` and `browserhive templates finish job-hunt` completes it later). `--noLogin` creates the template and exits without opening a window; `--fromState` seeds it (§7.4) instead of recording.

### 7.3 Google and other human-only sign-ins

Google "may stop sign-ins from browsers that are being controlled through software automation", and a host is automation-controlled whoever types in it (CDP pipe, Playwright's switches, and `--enable-automation` when `stealth` is `off`, `packages/core/src/infra/browsers/launch-args.ts:9-25`). Packs mark such sites `human_only: true` (§9.2): BrowserHive never fills their sign-in form (no auto-relogin), a template with an enabled `human_only` site cannot use `stealth: 'off'`, and the wizard tells the operator to sign in by hand. Whether a person can complete the Google sign-in in a host is verified by hand for T1a's acceptance (stealth `standard` and `max`, channels `chromium` and `chrome`, on Linux and macOS) and recorded in the bundled pack's `verified`; when it cannot, the documented path is §7.4.

### 7.4 Seeding from a storage state

`POST /templates/{id}/state` (`templates:write`; a template in `recording`, or `ready` with `confirm: true`) takes a Playwright storage-state JSON (≤ 16 MiB; cookies and origins, schema-validated): BrowserHive drains the host if it runs, starts it, applies the state with `context.setStorageState`, writes a version with `reason: 'import'`, probes every site and sets the template `ready`. It covers servers where nobody can see the host window, and sites that refuse a sign-in in an automation-controlled browser: the operator signs in with a separate browser profile and exports its state (for example from a BrowserHive exclusive session with `save_storage_state`, or with Playwright's `--save-storage`). The file is read in memory and never stored in plain text. CLI: `templates create … --fromState <file>` or `templates seed <name> <file>`. A seeded identity is still the template's pinned identity, not the source browser's; sites may treat the first visit as a new device.

---

## 8. Health and re-login (PR T2; navigation probes and challenges with T3a)

### 8.1 Probes

A probe answers "is the host signed in to this site?" without reading a cookie value. It runs in a page of the host's `maintenance` session (created in the background, minimized on a headed host), never in an agent's window, and only ever issues `GET` navigations to the site's own probe path; during a probe a guard aborts any document request that leaves the pack's `domains` (§9.10).

1. **Cookie pre-check** (no navigation): the host context's cookies for the site's domains (the pack's `domains`, else the site), names and expiry only. A pack with `cookie_names` none of which is present and unexpired → `signed_out`, reason `cookies_absent`.
2. **Navigation** (sites with a pack, T3a) to `https://<probe.host><probe.path>` (`waitUntil: 'domcontentloaded'`, timeout 20 s), then, in this order:
   - a challenge matches (§9.5) → `challenged`, reason `challenge:<kind>`;
   - the final URL matches a `signed_out_redirects` glob → `signed_out`, reason `redirect`;
   - the `signed_out_marker` selector is present → `signed_out`, reason `marker`;
   - the `landmark` selector is present → `signed_in`, reason `landmark`;
   - `kind: 'redirect'` and the final URL is still on the probe host and path → `signed_in`, reason `no_redirect`;
   - otherwise → `inconclusive`, reason `timeout`, `network`, `http_<status>` (≥ 500) or `no_signal`.
3. **A generic site** (no pack, or any site before T3a) is decided by step 1 with its learned cookie names: every learned name present and unexpired → `signed_in`, reason `learned_cookies`; none present → `signed_out`, reason `cookies_absent`; some → `inconclusive`, reason `partial_cookies`; no learned names → `inconclusive`, reason `no_pack`.

Selectors are checked with `page.locator('css=' + selector).count()` and texts with `page.getByText(text)`: queried, never evaluated (§9.10). **A challenged probe is never reported as signed out**, and neither `challenged` nor `inconclusive` ever starts a re-login: logging in again into an anti-abuse checkpoint is the account-safety failure this design avoids.

### 8.2 Before a launch

When `prelaunch_check` is on (default), a launch (after its host is running, §6.3) probes every enabled site whose last probe is older than 15 min. Pre-launch probes are **single-flight per template**: concurrent launches await the same probes. The budget is `min(10 s, remaining launch budget)`; sites not finished count as `inconclusive` for this launch. Then:

- every enabled site is `signed_out` or `challenged` → `TEMPLATE_NEEDS_LOGIN` (`retryable: after_operator`, `details {template, sites[], sites_text}`), and the re-login notification is produced (§8.6);
- otherwise the launch proceeds; the session's `template.sites` report each site's status, and a `TEMPLATE_SITE_SIGNED_OUT` warning (10 §1.1) lists signed-out sites on the session's dashboard.

### 8.3 Schedule

- Every template's sites are probed every `health_interval` (per template; default `templateHealthInterval` = `6h`; range 30 min to 7 d) with ±10 % jitter; a pack's `keeper.interval_hours` raises the floor for its site (a probe is traffic).
- Sites of one template are probed one after the other with a random 5–20 s gap; at most 2 hosts probe at the same time.
- A stopped host is started for a scheduled probe or keep-alive visit and stopped again by the idle rule (§3.2). Its windows are created in the background and minimized (§3.3); on a headed host Chromium may still show the sentinel window for a moment when it starts, and keystrokes that land in it reach no agent (it is parked). `docs/guide/templates.md` says that idle templates start briefly for checks, and `templateHealthInterval` or a template's `health_interval` controls how often. When no browser slot is free for that start (§6.3), the probe is skipped and retried at the next interval.
- Every site is probed after each host start, after a restore or seed, and when an attention request on one of the template's virtual sessions resolves (the operator may have signed in through takeover, §8.4).
- Three consecutive `inconclusive` results show a warning on the template page ("BrowserHive couldn't tell whether LinkedIn is signed in"); no notification.

### 8.4 Re-login

| Path | Who | How |
|---|---|---|
| **Host window** (default) | operator at the BrowserHive machine | dashboard **Re-login**, `browserhive templates login <name> --site <site>`, or the notification's Re-login action: the host starts headed if needed and opens a maintenance window at the site's sign-in URL on that machine's desktop (agent windows minimized, §3.3); the cookie pre-check runs every 5 s and the probe when cookies change (a generic site: **I'm signed in**, §7.1), for up to 30 min; on `signed_in` a version is written (`reason: 'relogin'`), unlisted sign-ins are listed as at Finish, and the notification resolves. The act button pressed in an external channel (Telegram, Discord, ntfy) only **queues** the re-login: the window opens when the operator presses **Show window** on the template page or confirms on that machine, never on an unattended desktop |
| **Attention** | operator anywhere | an agent in a virtual session that meets a sign-in page calls `request_attention` (takeover); the operator signs in through the live view of that session's page (with the live-view input limits of 04 §16); the jar is shared, so the template is signed in; the resolution triggers a probe (§8.3). The takeover UI shows the page's real origin prominently and warns when it is not one of the site's sign-in origins (the pack's `sign_in.url` host or the site's domains), because an agent can stage a look-alike page and ask for attention |
| **Vault auto-relogin** | BrowserHive, as principal `template:<template_id>` | only for a site with `vault_handle` and `auto_relogin` and a pack that is not `human_only`: on a `signed_out` probe, a maintenance session (owner: the template's owner; slug `relogin`) opens the sign-in URL and the vault broker fills it with the linked binding (`form` selectors, §2.3). Every gate of 02 §3.13 runs as for any fill, with the principal `template:<template_id>`, the slug `relogin` and no harness (so a binding with a harness list refuses it): linking a binding is not an authorization by itself; the binding must list `template:<template_id>` among its principals, which the template page's **Allow this template** button adds (with `vault:write`, shown as "widens who can use this credential"). `dashboard_confirm` asks the operator on the maintenance session. The fill writes its one `vault_access` row on that session with `trigger: 'auto_relogin'` and the principal that linked the binding. One attempt per sign-out; a second `signed_out` within 24 h is not retried automatically and produces `template.relogin_failed` |

**Vault fills happen only into the host by BrowserHive, never from an agent's session** (§5.5).

### 8.5 Versions in health

Every successful re-login and every finished recording writes a version (§3.9); the template page lists versions with their reason, size, per-domain summary and the per-site health they were written with (`health_json`), marks "Last good", and offers Restore and Pin (§3.12). A restore that brings a site back is confirmed by the probe that follows it.

### 8.6 Notifications

New kinds join the open `NotificationKind` set (`packages/contracts/src/enums/notification-kind.ts:8-22`, D-32); the exhaustive maps `KIND_CATEGORY`, `KIND_SEVERITY`, `KIND_LABEL` and `KIND_TYPE` (`packages/contracts/src/notifications/taxonomy.ts:10`, `:27`, `:44`, `:69`) get one entry each, and the producer table of 03 §9.1 one row each. Threads of a site are keyed by its **identity provider** (`identity_provider`, else the site itself), so a sign-out and a challenge of Glassdoor (provider Indeed) share one thread.

| Kind | Produced on | Category · severity · state | In-app type | Thread | Actions |
|---|---|---|---|---|---|
| `template.signed_out` | a site's state becomes `signed_out` | needs-you · warn · open → `resolved` when it is `signed_in` again, `final` when the site or template is removed | `attention` | `template:<template_id>:<provider>` | act `template.relogin` ("Re-login on <host name>", queued, §8.4), open `/templates/<id>?site=<site>` |
| `template.challenged` | a probe or a session hits a challenge on a site (§9.5) | needs-you · warn · open → `resolved` on the next `signed_in` probe | `attention` | `template:<template_id>:<provider>` | open `/templates/<id>?site=<site>`; for a session challenge also `/sessions/<id>?live=1&takeover=1` |
| `template.relogin_failed` | auto-relogin failed, or a host-window re-login timed out | problems · warn · final | `error` | `template:<template_id>:<provider>` | open `/templates/<id>?site=<site>` |
| `template.host_failed` | a host reaches `failed` | problems · error · open → `resolved` when it runs again | `error` | `template-host:<template_id>` | open `/templates/<id>` |
| `site_pack.write_confirm` (T3a) | writes need confirmation (§9.3) | needs-you · warn · open → `resolved` when none is open | `attention` | `site-confirm:<template_id>:<site>` (one coalesced thread showing the number of open confirmations) | act `attention.resolve` (approve / deny) on the newest request, only for guards of kind `write`; open `/attention` |
| `site_pack.update_pending` (T3a for bundled versions and local files, T4b for the registry) | a followed pack has a pending version, or a local file needs approval (§10.5, §10.6) | system · info, **warn when a downloaded candidate loosens or is restrictive, or a local file changed since approval** · open → `resolved` when none is pending | `system` | `site-packs:updates` | open `/site-packs?pending=1` |

- `template.relogin` joins the open `NotificationCommandOp` set (D-41) and runs through the same service and scope as the dashboard (`templates:login`); a press records the D-41 presser on the `template.relogin` audit row. Write confirmations reuse `attention.resolve` with `attention:resolve`, because security intercepts are operator requests resolved on `/attention`.
- The title of a sign-out reads "Job Hunt: LinkedIn signed out"; its summary names the sites the identity provider covers. A write confirmation's payload shows the method, the sanitized URL, the guard id and kind, the site and the tool call that triggered it.
- `site_pack.update_pending`'s summary is one line ("linkedin.com v7 → v8 available; x.com v3 → v4 tightens 2 rules; local linkedin.com changed") and its `blocks` carry one line per pack with the publisher's notes (before a download) or the classification (after).
- Pack titles in notifications are escaped for each platform's markup (D-40).
- Digests (D-43) gain a "Templates" fields block: sites signed out, re-logins, challenges and pending pack updates in the period.

---

## 9. Site packs (D-54; local in PRs T3a and T3b, remote in PRs T4a and T4b)

### 9.1 Purpose

A site pack makes a templated session behave on one site the way that site expects a person to behave, so the account holds up against the site's detection of automation, parallel logins, session sharing and tracking, and so the template stays healthy and signed in. A pack carries:

- how to sign in and how to tell, without reading a cookie value, whether the browser is signed in (§8.1);
- which requests and controls end or endanger the sign-in or mint new credentials (logout, account and security pages, token and key creation, OAuth consent, destructive actions) and must be blocked, confirmed or flagged (§9.3);
- which pages are challenges that need a human (§9.5);
- how many concurrent sessions and how fast the site tolerates, labelled official or vendor guidance with a source (§9.2);
- the browser, headedness, device binding and geo/timezone/locale consistency the site expects;
- the site's terms clause on automation as data the operator uses to choose a write policy;
- per-site stealth and behaviour strategies, selected from the closed set compiled into the binary (§9.4).

A pack is **data only**. It never carries code, scripts, launch arguments, executable paths, proxy settings, vault rules or any field whose value BrowserHive sends anywhere; a strategy that changes a launch flag selects among values compiled into the binary. A pack applies to template sessions only in this program; applying packs to every session, and to stealth defaults, is deferred (§16).

### 9.2 Schema

The structural zod schema lives in contracts (`packages/contracts/src/site-packs/schema.ts`), `.strict()` everywhere: an unknown key fails the pack version, so a new field needs a `min_client` bump and the registry carries several versions per pack (§10.1). One serialized pack is at most 64 KiB. The refinements need the registrable-domain helper, the spec 11 glob parser (`parseBlocklist`, `packages/core/src/domain/policies/blocklist.ts:89`) and a CSS parser, which contracts may not import (`.dependency-cruiser.cjs`: contracts are platform-neutral and import no core), so `refinePack()` lives in core (`packages/core/src/domain/site-packs/refine.ts`) and is used by the registry, the CLI `sitepacks verify`, the `registry-check` CI job and the tests; the website build does not import it (§10.7).

```ts
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const RegistrableDomain = z.string().min(4).max(253).regex(DOMAIN_RE);   // refine: registrableDomain(d) === d
const Host = z.string().min(4).max(253).regex(DOMAIN_RE);                // refine at pack level: registrableDomain(host) ∈ domains
const ScopedPath = z.string().min(1).max(200).regex(/^\/[A-Za-z0-9\-._~\/%]*$/);  // a path: no scheme, query or fragment
const ScopedUrl = z.object({ host: Host, path: ScopedPath }).strict();   // always https://<host><path>
const UrlGlob = z.string().min(1).max(300);       // spec 11 §5 grammar ('*', '?' only, no regex, no scheme);
                                                   // refine: its host part's registrable domain is literal and ∈ domains
const CssSelector = z.string().min(1).max(200);   // refine (§9.10): a selector list of at most 4 complex selectors, parsed by a
                                                   // CSS Selectors Level 4 parser; only the pseudo-classes of CSS_PSEUDO_ALLOWLIST;
                                                   // no pseudo-elements, no engine prefix, no `>>`, at most one `:has(`
const Text = z.string().min(2).max(120);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const Method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ResourceType = z.enum(['document', 'xhr', 'fetch', 'ping', 'eventsource', 'other']);   // Playwright's names; beacons are 'ping'
const Source = z.object({ url: z.string().url().max(500).startsWith('https://'), kind: z.enum(['official', 'vendor', 'community', 'observed']) }).strict();
const Action = z.enum(['block', 'confirm', 'warn', 'write_policy']);
const GuardKind = z.enum(['logout', 'account', 'credential', 'destructive', 'write']);   // credential: tokens, keys, app passwords,
                                                   // OAuth consent, recovery and passkey changes

const Guard = z.object({
  id: Id, kind: GuardKind,
  match: z.object({
    url: UrlGlob,
    methods: z.array(Method).min(1).max(5).optional(),              // absent = every method
    resource_types: z.array(ResourceType).min(1).max(6).optional(), // absent = document, xhr, fetch, ping
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
  request_guard: Id.optional(),                                     // the guard that enforces it on the network (§9.3); refinePack warns when absent
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
    default: z.enum(['allow', 'warn', 'confirm']),                  // refine: follows the stance rule of §9.3 unless `exception` is set
    stance: z.enum(['prohibited', 'restricted', 'writes_restricted', 'allowed']),   // the terms' position on automation
    clause: z.object({ quote: z.string().min(1).max(300), url: z.string().url().max(500).startsWith('https://'), checked: IsoDate }).strict().optional(),
    exception: z.string().min(10).max(300).optional(),              // why default departs from the stance rule; shown to the operator
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

`StrategyId` is the closed enum of §9.4; each strategy validates its own `params`. The pack-level refinements are listed in §9.10. `CSS_PSEUDO_ALLOWLIST` = `:not()`, `:is()`, `:where()`, `:has()`, `:nth-child()`, `:nth-last-child()`, `:nth-of-type()`, `:nth-last-of-type()`, `:first-child`, `:last-child`, `:only-child`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:checked`, `:disabled`, `:enabled`, `:empty`, `:root`; Playwright's extensions (`:text*`, `:has-text`, `:text-matches` with its regular expression, `:visible`, `:nth-match`, `:left-of` and the other layout pseudo-classes) are refused.

### 9.3 Guards and write policies

Guards are enforced in two places, both pure matching over the pack's data with the spec 11 §5 glob grammar and comparison forms (`parseBlocklist`, `blocklistComparisonForms`, `matchBlocklist`, `packages/core/src/domain/policies/blocklist.ts:89`, `:139`, `:165`), with two guard-only differences (owner decision 2026-11-10, PR T0b review; the blocklist is unchanged): a guard URL that does not end in `*` matches the same path **with any query string** as well as the paths beneath it (`site.test/logout` matches `/logout`, `/logout/x` and `/logout?next=/`, not `/logout-help`), because logout and write endpoints carry `continue=`, `next=`, tokens and ids in the query and a guard a query string defeats is no guard; and percent-encodings of unreserved characters (RFC 3986 §2.3) are decoded on both sides, so `/log%6Fut` is `/logout` as the server reads it. Guard URLs must be ASCII (punycode hosts): the comparison forms are punycode. The matchers are compiled once per rule set (`compileRequestGuardRules`, `domain/policies/request-guard.ts`). A request or page belongs to the pack of its **URL's** registrable domain (not of the page that sent it); the first matching guard of that pack decides. `DEFAULT_GUARDS`, compiled into the binary and applied on every host page whether or not the site has a pack, are `credential` guards (`block`) for the OAuth consent approval endpoints of `accounts.google.com`, `github.com` and `login.microsoftonline.com`/`login.live.com`, verified against live flows in T3a.

1. **The request guard**, handler 3 of the host's `InterceptionChain` (§3.8; mechanism T0b, pack rules T3a). It matches every routed request of a host by method, URL and resource type. This closes today's gap: the blocklist aborts document loads only and cannot match a method (`packages/core/src/infra/browsers/blocklist-route.ts:76`), so `linkedin.com/m/logout/` loaded unblocked and a `fetch` or form `POST` logout passes. It is the enforcement point; its blind spots are listed in §3.8 (redirect hops: packs `block` known open redirectors on their domains whose target can be a guarded path).
2. **The tool layer**, before the browser is touched; an early, friendlier refusal, not the boundary. `navigate` and `new_tab(url)` check `GET` document guards (as the blocklist's `urlBlocklist` policy does, 11 §5). Element guards are checked for `click`, `hover`, `select_option`, `drag_and_drop` (source and target), `fill` and `type_text` (the field and, when the text ends with a newline, its form's submit controls), and `press_key` (with a selector: that element; without one: the focused element, `document.activeElement` read in an isolated world): the action is refused when its target **is the guarded element or a descendant of it** (`guardLocator.filter({ has: agentLocator })` or the guard locator matching the agent locator itself, counted with `count() > 0`), where the guard locator is `locator('css=' + selector)` or `getByRole(role, {name})`: queried, never evaluated. Every element guard SHOULD name the request guard that enforces it (`request_guard`); `refinePack` warns when it does not.

| Effective action | Network path | Tool path |
|---|---|---|
| `block` | `route.abort('blockedbyclient')`; audit row | `URL_BLOCKED` with `pattern: '<pack id>#<guard id>'` (navigation) or `SITE_ACTION_BLOCKED` (element) |
| `confirm` | **held** (the route handler awaits) while a `security_intercept` request with `options.reason: 'write_confirm'` is open on the owning session (§9.5), or on the host's `maintenance` session for a host-owned request; approve → `route.fallback()` (the request goes on through the chain to the network); deny, timeout, `close_session` or the held request going away (its `AbortSignal`) → `route.abort('blockedbyclient')`. The held request also records a `SITE_WRITE_HELD` session warning, and the session's next tool call answers `SITE_OPERATOR_PENDING` with the request id until it settles | `SITE_OPERATOR_PENDING` with the request id; an approval grants that session a one-time pass for the same guard and URL for 10 min. Packs SHOULD express writes as element guards (the tool path is the primary, visible path) and keep network `confirm` as the backstop |
| `warn` | `route.fallback()`; audit row; `SITE_GUARD_WARNED` session warning; counted | proceed; audit row |
| `write_policy` | the site's effective write policy: the template site's `write_policy` override, else the pack's `write_policy.default`; mapped to allow (`route.fallback()`), warn or confirm as above | the same mapping |

- **Confirmation deadline and bounds.** A write confirmation has `deadline_at = now + attentionTimeout`, floored at `minAttentionWait` (D-15; no separate timeout constant). At most one write confirmation is open per session: a further matching write of that session is aborted with an audit row and the session's next tool answers `SITE_OPERATOR_PENDING` with the open request's id. At most 10 security intercepts (write confirmations and challenges together) are open per template; beyond that, matching writes are aborted and sessions are held on the newest open request.
- **Who can approve.** Write confirmations for guards of kind `write` can be approved on `/attention` or from a notification button (§8.6); for kinds `logout`, `account`, `credential` and `destructive` only on `/attention`, where the request shows the method, sanitized URL, guard and kind, site, and the tool call that triggered it.
- **Under `transport=stdio`** no operator can answer (no dashboard; `get_attention_result` answers `ATTENTION_REQUIRES_HTTP`): `confirm` acts as `block`, and challenges only mark health (no request, no hold). 01 §2's stdio paragraph says so.
- Every guard decision writes one `site_guard_hits` row (§9.9) with the guard, action, session (or `NULL` for host-owned requests), method, sanitized URL and, for confirmations, the request id and the decider.
- **Terms clauses are data.** `write_policy.clause` is shown verbatim, with its `checked` date and its URL as plain text with the domain shown (never a one-click link), in the wizard, the template's site card and the pack page; `stance` is shown as a label ("The site's terms prohibit automated access"). **Stance rule** for a pack's default write policy (owner decision Q12: confirm what a site's terms reserve for humans): `prohibited` or `writes_restricted` → `confirm`; `restricted` → `warn`; `allowed` → `allow`; a pack that departs from it carries `write_policy.exception` with the reason, shown to the operator. The operator chooses the template's write policy; the clause has no other effect.
- Write guards (`kind: 'write'`) are also what `pace-writes` counts (§9.4).
- A `human_only` site: auto-relogin cannot be enabled for it (agent fills are refused in every virtual session, §5.5).

### 9.4 Strategies (the closed set compiled into the binary)

A strategy is code in `packages/core/src/infra/site-packs/strategies/` registered in a compile-time exhaustive map (`STRATEGIES: {[K in StrategyId]: SiteStrategy}`, the pattern of `CHANNEL_KIND_SPECS`). A pack selects strategies by id and passes parameters that the strategy's own schema validates and **clamps to bounds fixed in the binary**; every numeric or enum parameter declares its safe direction (used by §9.7), and a parameter that names a path has none. A pack version naming an unknown id is skipped (`unknown_strategy`), so an older binary keeps its previous version. The always-on **data interpreter** (probes, guards, challenges, write policies, concurrency, consistency checks) is not a strategy and needs no selection.

**Behaviour strategies:**

| `StrategyId` | Hooks | Parameters (default; bounds; safe direction) | Behaviour |
|---|---|---|---|
| `pace-writes` | request guard | none (reads `pacing.rules`) | One token bucket per (template, rule): the account's budget, shared by every session of the template. A matching write over budget is held until the next token when that is ≤ 60 s away (plus 0–20 % jitter), else aborted with an audit row (`action: 'paced'`) and a `SITE_PACED` session warning |
| `launch-spacing` | admit | `min_gap_s` (pack `pacing.min_launch_gap_s`; 0–3600; up), `jitter_pct` (20; 0–50; up) | Consecutive virtual-session launches on the template are spaced; a launch waits up to `min(20 s, remaining budget)` for its turn, beyond that it answers `TEMPLATE_BUSY` (`limit_kind: 'capacity'`) with `retry_after_ms` |
| `ramp-up` | admit, request guard | `days` (14; 1–90; up), `start_fraction` (0.3; 0.1–1; down) | For a template younger than `days`, the cap and every `pace-writes` limit are multiplied by `start_fraction + (1 − start_fraction) × age_days / days`, rounded up |
| `serialize-site` | before action | `max_parallel` (1; 1–5; down) | At most `max_parallel` sessions of the template run an interaction or navigation tool on the site's pages at once; others wait (FIFO) up to 30 s, then answer `TEMPLATE_BUSY` (`limit_kind: 'pace'`). One person, many tabs, one at a time |
| `human-dwell` | before action | `min_ms` (600; 0–10000; up), `max_ms` (2500; `min_ms`–20000; up) | Before an interaction or navigation tool on the site's pages, the session waits until a random dwell in `[min_ms, max_ms]` has passed since its previous action on that site |
| `humanize-input` | before action | none | Forces humanized pointer and typing (02 §7) for the site's pages whatever the session's `humanize`; ignored with a template warning when the template's stealth is `off` |
| `entry-warmup` | before action | `path` (`/`; a `ScopedPath` on the pack's first domain's `www.` host or the probe host; no safe direction), `dwell_ms` (2000; 500–10000; up), `referrer` (`none`; `none`\|`same-site`\|`search`; none) | A session's first navigation to the site that is a deep link first loads `https://<host><path>` (with the chosen `Referer`: the site's root, or `https://www.google.com/`) and dwells, so the account does not arrive cold on a deep page |
| `keep-alive` | keeper | `interval_h` (pack `keeper.interval_hours`, else 24; 6–168; up) | A maintenance page visits the keeper path (else the probe path) with `GET` at the interval ± 20 %, skipped when a virtual session loaded the site within the interval; rolling cookies stay fresh. Doubles as a probe |
| `active-hours` | admit | `start_hour` (8; 0–23), `end_hour` (22; 0–23), `weekdays_only` (false); refine: the window is at least 1 h (`start_hour ≠ end_hour`; wrapping past midnight allowed) | Launches outside the window, in the template's pinned timezone, answer `TEMPLATE_BUSY` (`limit_kind: 'capacity'`) with `retry_after_ms` to its start; running sessions continue |
| `device-bound-session` | response observer (`context.on('response')`) | none | Watches in-scope responses for `Sec-Session-Registration` / `Sec-Session-Id` headers (DBSC; response headers, which a route handler that falls back never sees) and marks the template site `device_bound` (shown as a badge; blocks future export and serial checkout, §16); never changes a request |

**Stealth strategies** (they change the identity surface the site sees; one identity is one device, so the template-level ones constrain the whole template):

| `StrategyId` | Scope | Parameters (default; bounds; safe direction) | Behaviour |
|---|---|---|---|
| `stealth-profile` | template | `min_level` (`standard`; `standard`\|`max`; up), `fingerprint` (`any`; `required`\|`forbidden`\|`any`), `humanize` (false; up) | A floor checked at template creation, at site add and at pack approval: the template's `stealth` must be at least `min_level`, its `fingerprint` must match unless `any` (`forbidden` for sites known to flag canvas and audio noise), and `humanize` true forces the template's default on. A template below the floor cannot enable the site; approving a version that raises the floor above the template's settings asks the operator to change the template or disable the site. Any change of a parameter other than in its safe direction is loosening |
| `single-focus` | per page | none | For the site's pages, only the page the template's most recently active session last acted on keeps focus emulation; the site's other pages get `Emulation.setFocusEmulationEnabled {enabled: false}` and report their real visibility, so the site never sees several focused tabs of one account. Screenshots and the live view of such a page use the CDP fallback (§3.3) |
| `webrtc-policy` | host | `policy` (`default_public_interface_only`; `default_public_interface_only`\|`disable_non_proxied_udp`; toward `disable_non_proxied_udp`) | Adds `--force-webrtc-ip-handling-policy=<policy>` to the host's command line while any enabled site selects it (the strictest wins); applying or removing it restarts the host (§3.2) |

Canvas and audio noise cannot be switched per page inside one shared host without making one device behave two ways, so a pack expresses that need through `stealth-profile.fingerprint` (a capability limit, not a policy).

```ts
// packages/core/src/ports/site-strategy.ts
interface SiteStrategy<P> {
  readonly id: StrategyId;
  readonly params: z.ZodType<P>;                                     // clamps to the binary's bounds; declares each parameter's safe direction
  readonly hooks: Partial<{
    admit(ctx: TemplateAdmitContext, params: P): Promise<AdmitDecision>;            // proceed | wait(ms) | refuse(TEMPLATE_BUSY details)
    beforeAction(ctx: SiteActionContext, params: P): Promise<void>;                 // may wait; may throw TEMPLATE_BUSY
    onRequest(ctx: SiteRequestContext, params: P): Promise<RequestDecision>;        // pass | hold(until) | abort(reason)
    onResponse(ctx: SiteResponseContext, params: P): void;                          // observe only
    keeper(ctx: KeeperContext, params: P): KeeperPlan;
    hostFlags(params: P): readonly string[];                                        // from a compiled-in table only
    templateRequirements(params: P): TemplateRequirements;                          // stealth floor
    pageFocus(ctx: SitePageContext, params: P): 'emulated' | 'real';
  }>;
}
```

### 9.5 Challenges

**Detection** (fail-open) runs on the pages of a host:

- a main-frame navigation whose URL matches a pack challenge `url` glob;
- after `domcontentloaded`, `page.title()` containing `title_contains`, a `landmark` selector present, or `text` present (`getByText`);
- a provider frame (`CHALLENGE_PROVIDERS`: `cloudflare` `challenges.cloudflare.com`; `recaptcha` `www.google.com/recaptcha/*`, `www.recaptcha.net/recaptcha/*`; `hcaptcha` `*.hcaptcha.com`; `arkose` `*.arkoselabs.com`; `datadome` `*.captcha-delivery.com`) counts **only as a challenge surface**: a frame on a provider challenge path (`/recaptcha/api2/bframe`, `/recaptcha/enterprise/bframe`, hCaptcha's challenge frame, Arkose `enforcement`, `geo.captcha-delivery.com/captcha`), or a provider frame whose element is visible, at least 100 × 60 CSS px and intersects the viewport (`frame.frameElement().boundingBox()` checked at the frame's `load` and 2 s later). Invisible and badge-only frames (reCAPTCHA v3 and Enterprise anchors with `size=invisible`, Turnstile in invisible mode) are ignored.

`DEFAULT_CHALLENGES` (compiled in, every host page): the Cloudflare interstitial (main-frame title "Just a moment" or "Verify you are human" with a `challenges.cloudflare.com` frame), `kind: 'captcha'`, `action: 'attention'`; and any provider challenge surface, `kind: 'captcha'`, `action: 'notify'` (an internal action packs cannot use). On pages outside every pack's domains only `DEFAULT_CHALLENGES` apply.

**Outcome:**

| Situation | Effect |
|---|---|
| A match with `action: 'attention'` or `'stop'` in an agent's virtual session | a `security_intercept` operator request on that session (D-15's reserved kind, built by migration v10, §9.9) with `mode: 'takeover'`, `reason` "<Site title> security check", `options {reason: 'challenge', site, challenge, kind, action, page_url}` and `deadline_at = now + attentionTimeout` (floored at `minAttentionWait`). The lease pauses (D-15); the site's health becomes `challenged`; `template.challenged` opens or grows. Until the request settles, every tool on the session except `close_session`, `list_sessions`, `server_status`, `session_info`, `list_tabs`, `screenshot`, `list_templates`, `get_attention_result`, `list_saved_auths` and `vault_list_available` answers `SITE_OPERATOR_PENDING` (`details {session_id, site, request_id, reason: 'challenge'}`); the agent may wait with `get_attention_result(request_id)`. On timeout the request settles `timeout`, the session's tools are released and the site stays `challenged` |
| `action: 'notify'` (provider surfaces from `DEFAULT_CHALLENGES`) | the site's health becomes `challenged` and `template.challenged` opens or grows; no request, no hold |
| The match is on the URL the agent itself passed to `navigate`/`new_tab` (not a redirect into it, not a frame) | an agent can set no state by navigating to a challenge URL: no request, no health change, no `stop`; the page loads |
| A maintenance session or a probe | sets the probe's outcome (`challenged`) only; no request |
| `transport=stdio` | health only (§9.3) |

- **Resolving.** The operator takes over in the live view (operator input is permitted while a `takeover`-mode `attention` **or** `security_intercept` request is open, extending `AttentionService.isInputPermitted`, `packages/core/src/app/attention/attention-service.ts:180-182`; amends D-10) or solves it in the host window, then resolves or rejects it on `/attention` (`POST /attention/{request_id}/resolve`, `attention:resolve`); `get_attention_result` returns the outcome to the owning principal (today it answers only `attention` rows, `attention-service.ts:122`). A resolution triggers a probe of the site.
- **`stop`** (terminal states such as Google's "Couldn't sign you in" or Instagram's suspension, where retrying makes things worse): as `attention`, and additionally the site's `stopped_at` is set: every agent navigation to the site, and every tool on a page of the site, answers `SITE_OPERATOR_PENDING` with `reason: 'stopped'` until the operator clears the site on the template page (**Clear stop**).
- **Bounds.** At most one open challenge request per session (further matches on that session attach to it), at most one new one per session per 5 min, and the per-template limit of 10 open security intercepts shared with write confirmations (§9.3); notifications are grouped per template and identity provider (§8.6).
- **Screenshots** (D-36): challenge requests are not a screenshot trigger in v1; the notification links to the live view instead.

### 9.6 Ports, the registry service and hook points

```ts
// packages/core/src/ports/site-pack-source.ts
interface SitePackSource {
  readonly id: 'bundled' | 'remote' | 'local' | 'import';
  readonly trust: 'publisher' | 'operator';            // bundled/remote/import and signed local layouts: publisher; unsigned local files: operator
  load(signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>>;   // already verified and schema-checked
}
// packages/core/src/app/site-packs/registry.ts
class SitePackRegistry {
  effectiveFor(hostOrDomain: string): EffectivePack | null;   // registrableDomain() then the owning pack
  list(): readonly SitePackView[]; get(packId): SitePackView | null;
  pending(): readonly PendingUpdate[];                         // available and downloaded versions of followed packs, local files needing approval (§10.5, §10.6)
  approveOnFirstUse(packId, version, by, provenance); download(packId, version | 'all'); apply(packId, version, by); reject(packId, version, by);
  revert(packId, by); pin(packId, version | null, by); setFollow(packId, follow: boolean | null, by); approveLocal(packId, sha256, by); setEnabled(packId, enabled, by);
  reload(): Promise<RegistryStats>;                            // atomic swap; a failed load keeps the previous set (D-22 pattern)
  stats(): RegistryStats;                                      // per source: loaded, skipped [{pack, version, reason}], last load
}
```

- **Approval** (owner decision 2026-11-08). No pack version applies until an operator has approved it, whatever its source:
  - **First use.** When an operator adds a site to a template (wizard step 2, `POST /templates`, `PUT …/sites/{site_id}`, `templates create --sites`), BrowserHive shows the pack that would apply with its provenance (bundled with BrowserHive x.y.z; downloaded from the registry, with the signing key id, "signature verified" and the index version; an imported file; a local file's path), its version and its SHA-256, and adding the site **approves that version** (`site_pack_changes` decision `approved`, by that operator, with the provenance). A pack another template already uses keeps its approved version. Until a pack is approved, its site is generic (§8.1).
  - **Bundled versions** that a later BrowserHive release ships are candidates like any other: on the first start of the release they appear as pending updates (already downloaded, with their diff), and the template keeps using the approved version until an operator applies the new one. Neither a release nor auto-update ever applies one.
  - **Registry versions** follow §10.6 (automatic check, then Download & review and Apply by the operator).
  - **Unsigned local files** (§10.5) apply only with content an operator approved, once per content hash: a file whose SHA-256 differs from the approved one is "Changed since approval — review" and the last approved content keeps applying (from BrowserHive's copy in `site-packs/cache/local/`); a file never approved is "Not yet approved" and nothing of it applies.
  - **Precedence** for one pack id: approved local content (operator trust) wins; else the approved version from any other source; else none. Loading a local file records a `site_pack.local_override` audit row, and the pack shows "Local file overrides v9" wherever it appears.
- **Matching by eTLD+1.** A host belongs to the pack whose `domains` contain `registrableDomain(host)`. A registrable domain belongs to at most one pack: a pack version claiming a domain another pack of higher precedence owns is skipped (`domain_overlap`). Subdomain rules use host globs inside the pack's domains.
- **Hook points:**

| Event | Hook | Where |
|---|---|---|
| Template creation, site add, pack approval | requirements (channel, headed, proxy, consistency, `stealth-profile`), the clause and write policy shown, `human_only` | `TemplateService` / wizard step 2 / approval flow |
| Probe and keep-alive | `signed_in` data; `keep-alive` | the health scheduler (§8.3) |
| Before navigation and element actions | `GET` document guards, element guards, `stop`, `serialize-site`, `human-dwell`, `humanize-input`, `entry-warmup`, `single-focus` | the tool dispatcher's policies for template sessions (02 §2.3) |
| Every request of a host | the request guard: guards, `DEFAULT_GUARDS`, write policy, `pace-writes`, `ramp-up` | `InterceptionChain` handler 3 (§3.8) |
| Every response of a host | `device-bound-session` | `context.on('response')` |
| Host launch | `webrtc-policy` | the host's options (§3.1) |
| Challenge detected | a `security_intercept` operator request (§9.5) | `OperatorRequestBroker` (D-15) |
| Admission of a virtual session | `concurrency`, `launch-spacing`, `active-hours`, `ramp-up` | `TemplateAdmission` (§3.7) |

- `SitePackRegistry` publishes `site_pack.changed` and `site_pack.status` on the bus (§11.3) and records `SITE_PACKS_STALE` / `SITE_PACKS_FETCH_FAILED` degradations (10 §3).
- `sitePacks=false` turns the whole layer off: templates use generic sites (learned-cookie probes, no guards, no strategies), the catalog shows only domains, and no update check runs.

### 9.7 Tightening, restrictive and loosening

Every change from the approved version to a candidate is classified field by field in the binary (`classifyPackChange`, unit-tested per field). **Default deny**: a field, or a strategy parameter, without a rule below is loosening. The candidate's class is the strongest of its fields: **loosening** > **restrictive** > **tightening** > **neutral**.

| Field | Tightening | Restrictive | Loosening | Neutral |
|---|---|---|---|---|
| `domains` | | | **a domain added** or removed (a removed domain loses its guards and challenges and becomes free for another pack) | |
| `identity_provider`, `shares_login_with` | | | any change | |
| `sign_in.url`, `sign_in.form`, `signed_in.*`, `keeper.path`, any strategy parameter that names a path | | | any change (path- and URL-bearing values) | |
| `sign_in.human_only` | `false → true` | | `true → false` | |
| `guards`, `element_guards` | a guard added; an action made stricter (`warn` < `confirm` < `block`) | a guard added or made stricter whose match covers the pack's probe path, its sign-in URL, or a whole host (`*`-only path) | a guard removed; an action made laxer; a `match`, `target` or `request_guard` changed; any change to or from `write_policy` | |
| `write_policy.default` | stricter (`allow` < `warn` < `confirm`) | | laxer | `stance`, `clause`, `exception` |
| `challenges` | a challenge added; `attention → stop` | a challenge added or changed whose match covers the pack's probe path or sign-in URL, or whose `landmark`/`text`/`title_contains` would match every page (`body`, `html`, `:root`, a text shorter than 4 characters) | a challenge removed or its match changed; `stop → attention` | |
| `concurrency.max_sessions`, `pacing.rules[].limit` | lowered; a rule added | lowered to 1 | raised; a rule removed | `source` |
| `pacing.min_launch_gap_s`, `keeper.interval_hours` | raised | | lowered | |
| `browser.headed`, `consistency.proxy` | made stricter | `headed: 'required'` added (refuses headless templates) | made laxer | |
| `browser.channel` | | | any change | |
| `consistency.pin_*` | `false → true` | | `true → false` | |
| `device_binding` | an entry added | | an entry removed | |
| `strategies` | a strategy added; a parameter moved in its safe direction | `active-hours` added or its window shortened below 4 h; `stealth-profile` raised above a using template's settings | a strategy removed; a parameter moved against its safe direction; a parameter without a safe direction changed | |
| `title`, `description`, `verified`, `sources`, `min_client`, `max_client` | | | | any change |

**Apply rules.** The classification informs the operator; only auto-update acts on it. With the default `sitePacksAutoUpdate=false`, every candidate waits for an operator's Apply (§10.6). With `sitePacksAutoUpdate=true`, registry candidates of followed packs that are tightening or neutral are downloaded and applied automatically; **loosening and restrictive candidates and domain changes always wait**, and bundled candidates and local files always need an operator (§9.6). **Revocation**: an approved version marked `revoked: true` in the index (§10.1) is classified against its fallback (the previous approved version, else none) like any candidate: a tightening or neutral fallback applies at once; a loosening or restrictive fallback leaves the revoked version in force, opens a pending decision marked `revoked` and produces `site_pack.update_pending`; with no fallback the revoked version stays in force and is reported, never silently removed. A pinned pack follows the same revocation rule.

### 9.8 Bundled packs

The first release with T3a bundles the packs drafted in the site catalog research (`scratchpad/session-templates/06-site-catalog.md`). **Every field marked unverified there MUST be confirmed against a live signed-in session before it ships**; a field that cannot be confirmed is left out, and the pack's `verified` dates record what was checked. Every bundled pack MUST list `credential` guards for the site's token, app-password, SSH- or deploy-key, OAuth-consent, recovery-address and passkey endpoints where the site has them, and `logout` and `account` guards from the catalog. Write policies follow the stance rule of §9.3; packs with no `write` guards are unaffected by their default.

| Pack id | `domains` | Identity provider | Probe | `human_only` | Stance → default write policy | Strategies |
|---|---|---|---|---|---|---|
| `google.com` | `google.com` | | `myaccount.google.com/`, `redirect` (signed out → `www.google.com/account/about/`) | `true` | `restricted` → `warn` (no write guards; account pages blocked) | `keep-alive`, `device-bound-session`, `stealth-profile` (`standard`) |
| `youtube.com` | `youtube.com` | `google.com` | `www.youtube.com/feed/history`, `landmark` (signed-out marker: the "Sign in" link) | (provider's) | `prohibited` → `confirm` (comments, subscriptions); history-clearing controls blocked | `keep-alive` |
| `linkedin.com` | `linkedin.com`, `licdn.com` | | `www.linkedin.com/feed/`, `redirect` (`/uas/login`, `/authwall`) | `false` | `prohibited` → `confirm` (invitations, messages, posts) | `serialize-site`, `single-focus`, `human-dwell`, `launch-spacing`, `ramp-up`, `pace-writes` |
| `reddit.com` | `reddit.com`, `redd.it` | | `www.reddit.com/settings/account`, `either` | `false` | `prohibited` → `confirm` (posts, comments, votes, messages) | `human-dwell` |
| `facebook.com` | `facebook.com`, `fbcdn.net` | | `www.facebook.com/settings`, `redirect` (`/login.php`) | `false` | `prohibited` → `confirm` (posts, comments, messages, friend requests) | `serialize-site`, `single-focus`, `human-dwell` |
| `instagram.com` | `instagram.com`, `cdninstagram.com` | | `www.instagram.com/accounts/edit/`, `redirect` (`/accounts/login`) | `false` | `prohibited` → `confirm` (posts, comments, follows, likes, messages) | `serialize-site`, `single-focus`, `human-dwell` |
| `x.com` | `x.com`, `twitter.com`, `twimg.com` | | `x.com/settings/account`, `redirect` (`/i/jf/onboarding/web`, `/i/flow/login`, `/login`) | `false` | `prohibited` → `confirm` (posts, replies, DMs, follows, likes) | `serialize-site`, `human-dwell`, `pace-writes` |
| `github.com` | `github.com` | | `github.com/settings/profile`, `redirect` (`/login`) | `false` | `allowed` → `allow` (sudo prompts are challenges; tokens, SSH and deploy keys, OAuth apps are `credential` guards) | |
| `indeed.com` | `indeed.com` | | `www.indeed.com/myjobs`, `redirect` (`secure.indeed.com/auth`) | `false` | `writes_restricted` → `confirm` (Indeed Apply submit, terms §A.3.5) | `human-dwell` |
| `glassdoor.com` | `glassdoor.com` | `indeed.com` | `www.glassdoor.com/member/profile/index.htm`, `redirect` (`/member/profile/login`) | (provider's) | `prohibited` → `confirm` (reviews, applications) | `human-dwell` |
| `microsoft.com` | `microsoft.com`, `live.com`, `microsoftonline.com` | | `account.microsoft.com/`, `redirect` (`login.live.com`, `login.microsoftonline.com`) | `false` | `prohibited` → `confirm` (no write guards; `account.microsoft.com/security*` guarded: probing it forces a fresh sign-in) | `keep-alive` |

Logout guards (`block`) and account, security and deletion pages (`block`, or `confirm` where a page is also the probe: Reddit's `/settings/account` is probed with `GET` and guarded for form posts only) follow the catalog's lists. Pacing rules ship only with their source and kind: X's numbers are official technical caps (`help.x.com/en/rules-and-policies/x-limits`), LinkedIn's are vendor guidance.

### 9.9 Database (migration `0010-site-packs`, schema v10, PR T3a)

`compatible: false` (accepted by the owner, 2026-11-08): `operator_requests.kind` has a CHECK constraint, so adding `security_intercept` rebuilds the table (`foreign_keys=OFF` around the rebuild, as the runner already does, `migrations/runner.ts:66`, `:108`; D-04) and raises `meta.min_reader_version` to 10. A binary older than v10 refuses the database with `DB_NEWER_THAN_BINARY`, naming the pre-upgrade backup (D-04); the release notes of the T3a release and `docs/guide/upgrading.md` say so. It is the project's first incompatible migration.

**Frozen literals.** `0001-initial.ts` builds that CHECK from the live constant `OPERATOR_REQUEST_KINDS` (`packages/core/src/ports/persistence/enums.ts:118`, imported at `0001-initial.ts:3-26`, used at `:269`). T3a must add `security_intercept` to that constant, which would silently change v1's DDL on fresh installs. So T3a first replaces the import in `0001` with a literal `V1_OPERATOR_REQUEST_KINDS = ['attention', 'vault_confirm']` (a golden test pins v1's DDL text unchanged), and every migration from v9 on uses literal lists only (v8, `0008-operator-token-scopes` of 0.2.3, has no CHECK and already writes its scope lists as literals in the migration file).

```sql
-- v10 (0010-site-packs): site packs (spec 13 §9, D-54) and the security_intercept operator request (D-15)
-- operator_requests is rebuilt with the same columns, indexes and data, plus:
--   kind CHECK (kind IN ('attention','vault_confirm','security_intercept'))
--   template_id TEXT                                     -- the template a security_intercept request belongs to; NULL otherwise
CREATE TABLE site_pack_state (                           -- configuration class: never pruned
  pack_id TEXT PRIMARY KEY,
  approved_version INTEGER, approved_sha256 TEXT,
  approved_source TEXT CHECK (approved_source IN ('bundled','remote','import','local')),
  approved_provenance_json TEXT,                         -- {release} | {key_id, index_version} | {file} | {path}, as shown at approval
  approved_domains_json TEXT NOT NULL DEFAULT '[]',      -- the scope the operator approved
  approved_by TEXT, approved_at INTEGER,
  previous_version INTEGER, previous_sha256 TEXT, previous_source TEXT,   -- kept for Revert (§10.6)
  local_path TEXT, local_approved_sha256 TEXT, local_approved_by TEXT, local_approved_at INTEGER,   -- unsigned local file (§10.5)
  pinned_version INTEGER,                                -- NULL = not pinned
  follow INTEGER CHECK (follow IN (0,1)),                -- NULL = automatic: followed while a template uses the pack (§10.6)
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE site_pack_changes (                         -- audit class: every candidate and decision
  seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
  pack_id TEXT NOT NULL, from_version INTEGER, to_version INTEGER,          -- to_version NULL for a local file
  to_sha256 TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled','remote','import','local')),
  classification TEXT NOT NULL CHECK (classification IN ('unclassified','tightening','restrictive','loosening','neutral','new_pack','revoked','local_override')),
  new_domains_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,                                            -- the publisher's signed note from the index (§10.1)
  diff_json TEXT,                                        -- [{path, from, to, class}]; NULL until downloaded
  decision TEXT NOT NULL CHECK (decision IN ('available','downloaded','auto','approved','rejected','superseded','reverted')),
  decided_by TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX idx_site_pack_changes_pack ON site_pack_changes(pack_id, seq);
CREATE INDEX idx_site_pack_changes_pending ON site_pack_changes(created_at) WHERE decision IN ('available','downloaded');
CREATE TABLE site_guard_hits (                           -- audit class (auditRetentionDays)
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,  -- NULL for host-owned requests; survives session pruning
  template_id TEXT, pack_id TEXT NOT NULL, guard_id TEXT NOT NULL,
  guard_kind TEXT NOT NULL CHECK (guard_kind IN ('logout','account','credential','destructive','write','stop')),
  action TEXT NOT NULL CHECK (action IN ('block','confirm','warn','paced','held')),
  outcome TEXT CHECK (outcome IN ('approved','denied','timeout','cancelled')),   -- confirmations only
  decided_by TEXT,                                       -- the operator who approved or denied a confirmation
  source TEXT NOT NULL CHECK (source IN ('tool','request','element')),
  method TEXT, url TEXT NOT NULL,                        -- sanitized (D-20)
  request_id TEXT, tool TEXT, ts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_site_guard_hits_ts ON site_guard_hits(ts, event_id);
CREATE INDEX idx_site_guard_hits_session ON site_guard_hits(session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX idx_site_guard_hits_template ON site_guard_hits(template_id, ts);
```

`TABLES` gains `site_guard_hits` before `sessions` and `site_pack_changes` and `site_pack_state` anywhere (no references). The registry client's rollback floors (highest `keys.json` and `index.json` versions seen, §10.3) are stored in the `meta` table (`site_packs.keys_version`, `site_packs.index_version`), so no further migration is needed for T4.

### 9.10 Constraints that make malicious data harmless

A remote registry adds a third principal, the publisher, trusted less than the operator. The schema and the binary bound what a compromised publisher (a stolen online key, a malicious merge, a hijacked site) could do:

| Field | Abuse if unconstrained | Constraint |
|---|---|---|
| `sign_in.url` (opened in a window where the operator types a password) | point it at a look-alike domain: phishing | a `ScopedUrl` (`https`, host inside the pack's `domains`, path only, no query); shown in full in the dashboard before the window opens; any change is loosening |
| `domains` | widen a pack so its other rules can target any site; drop a domain to strip its guards | each added or removed domain needs the operator's approval, even with auto-update on; overlapping domains are refused |
| every path BrowserHive loads by itself (probe, keeper, `entry-warmup.path`) | a logout endpoint, a deletion `GET`, an open redirect inside the domains | path only, no query; must not match the pack's own `logout`, `account`, `credential` or `destructive` guards (refinement); any change is loosening; during probes, keeper visits and warm-ups a guard aborts every document request leaving the pack's domains (fail-closed) |
| `guards` | block password or security pages, or whole sites: denial of the agent's work; hide warning pages | glob grammar only, hosts inside the pack's domains, at most 64; shown in the diff; removals are loosening; host-wide or probe-covering additions are restrictive |
| `challenges` | match everything (notification storm, every session held) or nothing (agents keep hammering a checkpoint) | per-session and per-template request bounds (§9.5); match-everything additions are restrictive; removing a challenge is loosening; an agent's own navigation never triggers one |
| `signed_in` | always signed in (hides expiry) or always signed out (re-login loops) | cookie **names** only, never values; selectors queried, never evaluated; re-login never starts on `challenged` or `inconclusive`; any change is loosening |
| numbers (`concurrency`, `pacing`, `min_launch_gap_s`, keeper interval, strategy parameters) | raise caps until accounts are banned; set to 0 or 1 for denial of service | floors and ceilings in the binary: `max_sessions` 1–20 and never above the template's `max_concurrent`; `PACE_CEILING` = 60/minute, 1000/hour, 10000/day, 50000/week; keeper 6–168 h; `active-hours` ≥ 1 h; strategy bounds of §9.4; raising is loosening, lowering to 1 restrictive |
| selectors | script execution, engine escapes, regular expressions (ReDoS), CPU exhaustion | standard CSS ≤ 200 characters, at most 4 selectors per list, one `:has(`, pseudo-classes from `CSS_PSEUDO_ALLOWLIST` only, no engine prefix or `>>`; only ever passed to `locator('css=…')` |
| any string | XSS in the dashboard or notifications, oversized payloads | rendered as text only (URLs as plain text with the domain shown, never one-click links); escaped per platform in notifications (D-40); per-field length caps; 64 KiB per pack, 256 KiB per index (the endless-data defence) |
| strategy ids and host flags | reference behaviour the binary does not have; inject launch arguments | only ids compiled into this binary; an unknown id skips the pack version; host flags come from compiled-in tables (`webrtc-policy`) |

There is **no exfiltration channel by construction**: no pack field is ever sent anywhere, the fetch carries no data about the install (§10.4), and every URL a pack can make the browser load is inside its approved domains.

---

## 10. Registry delivery (D-55; publishing in PR T4a, the client in PR T4b)

### 10.1 Layout on browserhive.ai

```
https://browserhive.ai/registry/v1/
  keys.json            {schema: 1, version, expires, index_floor?, online: [{key_id, public_key, not_after}]}
  keys.json.sig        Ed25519 signature of keys.json by a root key
  index.json           {schema: 1, version, issued_at, expires, packs: [{id, title, versions: [{v, min_client, max_client?, sha256, size, path, released, notes, revoked?}]}]}
  index.json.sig       Ed25519 signature of index.json by an online key
  packs/<id>/<sha256>.json   one pack version, content-addressed, immutable
```

The schema major is in the path (`/v1/`); a client that finds nothing it can parse keeps what it has. `path` is relative to `registry/v1/` and MUST equal `packs/<id>/<sha256>.json`. Pack files are trusted only through the index's `sha256` and `size` (the mix-and-match defence). `notes` is the publisher's change summary for that version (plain text, at most 500 characters, signed as part of the index; shown as text, never as a link); `released` is an ISO date. At most 10 versions per pack are listed.

### 10.2 Signing (TUF-lite)

- **Ed25519**, verified in core (`packages/core/src/infra/site-packs/verify.ts`) with `node:crypto` `verify(null, bytes, publicKey, signature)` over the exact file bytes (no canonicalisation on the client; producers write canonical JSON with sorted keys only so diffs stay stable). A unit test proves Bun's `node:crypto` verifies Ed25519 before anything relies on it. Contracts may not import `node:crypto`, so no verification code lives there.
- **Root keys**: two Ed25519 keys held offline by the owner, threshold 1 of 2 (one may be lost), pinned in the binary (`packages/core/src/infra/site-packs/trust-root.ts`) and published in the repository (`registry/keys/root-1.pub`, `root-2.pub`). They sign only `keys.json`. Replacing a root key requires a release.
- **Online key**: one Ed25519 key in an approval-gated CI environment (§10.7), listed in `keys.json` with `not_after` at most 90 days after it was added. It signs `index.json`. A stolen online key is revoked by a new root-signed `keys.json`, without a release.
- **Freshness**: `index.json.expires` is at most 14 days after `issued_at`; CI re-signs the same content every week with a new `version` and `expires` (the TUF timestamp role). `keys.json.expires` is at most **120 days** ahead, so a CDN that withholds a revoking `keys.json` can do so for at most 120 days; the owner re-signs `keys.json` when adding each online key (at most every 90 days) anyway.
- **Pull-request previews** sign with a test key that release binaries do not trust. Tests inject a test trust root through the internal testing seam (`createServer({ testing: { sitePacksTrustRoot } })`, 08 §9, exported only from the `browserhive/testing` entry point and marked `@internal`); there is no configuration key, flag or environment variable that weakens verification.

### 10.3 Client verification

1. `keys.json`: the signature verifies against a pinned root key; `version ≥` the stored `site_packs.keys_version`; `now < expires` (with ±1 h skew allowance). Accept → store the version. When it carries `index_floor`, the stored index floor is reset to it (the only way to lower the floor after a fast-forward attack).
2. `index.json`: ≤ 256 KiB; signed by an online key of the accepted `keys.json` with `now < not_after` and `issued_at < not_after`; `issued_at ≤ now + 5 min`; `version >` the stored `site_packs.index_version` and `≤` it + 100 000 (fast-forward bound); `now < expires`. Accept → store the version and keep the file as the last good index.
3. Each pack version the client **downloads** (Download & review, auto-update, an import or a signed local layout): `size` and `sha256` match the index, ≤ 64 KiB, parses with `SitePackV1` and `refinePack()`, `min_client ≤` this binary `≤ max_client` (else skipped, reason `min_client`, and the pack page shows which BrowserHive it needs). Before a download, the index alone decides what is listed as available: the highest non-revoked version per pack whose `min_client`/`max_client` admit this binary.
4. An expired index is never used for new content: the last good index stays in force and the `SITE_PACKS_STALE` degradation (warn) is recorded until a fresh one verifies; when the response's `Date` header differs from the local clock by more than 1 h, the degradation's message says to check the system clock. A verification failure keeps everything as it was and is recorded in `site_pack_changes` only when a candidate was involved; three consecutive failed checks record `SITE_PACKS_FETCH_FAILED` (warn).

### 10.4 Polling and request hygiene

- **Automatic check** (owner decision 2026-11-08): when `sitePacksUpdateCheck` is on (default), the client fetches `keys.json` and `index.json` (with their signatures) 5 minutes after boot and then every 24 h ± 2 h, whether or not a template exists; the operator can check at any time (`POST /site-packs/check`, `browserhive sitepacks check`). **Nothing else is downloaded automatically**: the signed index lists every version with its size, hash, release date and notes, which is what the Site packs page shows until an operator downloads a version (§10.6). Only auto-update, when the operator turns it on, downloads followed packs' candidates by itself (§9.7).
- Requests: HTTPS only to `sitePacksUrl`; `User-Agent: BrowserHive` with no version and no install identifier; no cookies, no query string, no request body; 5 s connect and 30 s total timeout; a fresh connection without TLS session resumption for each check.
- **Conditional requests without tracking.** The client sends `If-None-Match` only with an ETag equal to `"<sha256 hex of the body it holds>"` (the form browserhive.ai's static hosting uses); with any other ETag it sends an unconditional `GET`. So a CDN cannot give each install its own ETag and read it back as an identifier.
- **What the registry learns.** An automatic check fetches the same two files for every install, so it reveals the requester's IP address and timing only. A **Download & review** fetches one pack file and so reveals which pack version that IP downloaded; **Download all** (`sitepacks download --all`) fetches every listed version the client lacks instead, for operators who prefer not to reveal that. `docs/guide/security.md` says so.

### 10.5 Manual download, import and air-gapped hosts

- `sitePacksUpdateCheck=false` stops every request; bundled and local packs still work.
- `browserhive sitepacks export <dir>` (on a connected host) writes the verified signed layout of §10.1; `browserhive sitepacks import <dir|file>` (or `POST /site-packs/import`, ≤ 1 MiB) verifies it with the pinned keys exactly as a fetch would and queues its candidates for approval.
- **The local folder** (`sitePacksDir`, default `<data-dir>/site-packs/local`; owner decision 2026-11-08) accepts two things, read at boot and on `POST /site-packs/reload`: (a) a **signed layout** (`keys.json`, `index.json` with their signatures and `packs/`, as `export` writes or as downloaded from browserhive.ai by hand), verified exactly like `import`, whose versions appear as downloaded pending updates; (b) **unsigned single-pack files** (`<pack id>.json`) written by the local administrator, validated with the same schema and refinements and needing no signature, which apply only after an operator approves their content **once per content hash** (§9.6): **Approved**; **Changed since approval — review** (the diff between the approved and the current content is shown, and the approved content keeps applying); **Not yet approved** (nothing applies). Approving (`POST /site-packs/{pack_id}/approve-local` with the SHA-256 the operator reviewed, `browserhive sitepacks approve-local <id>`) copies that content to `site-packs/cache/local/<id>/<sha256>.json`, so later edits to the file change nothing until approved again. A file that fails validation is skipped with its reason on the Site packs page.

### 10.6 The update experience

- **Following** (owner decision 2026-11-08). Each pack has a **Follow updates** setting: automatic by default (followed while any template uses the pack), or set on or off by the operator (`PUT /site-packs/{pack_id}/follow`, `browserhive sitepacks follow <id> on|off|auto`). The check always fetches the whole index (§10.4); following decides only which packs list pending updates, count in badges and banners and produce `site_pack.update_pending`, and which packs auto-update may touch.
- **Per pack and version**, the states are: **Available** (in the verified index: version, size, release date and the publisher's notes); **Downloaded** (after **Download & review**: verified, §10.3, classified against the approved version, §9.7, and shown as the exact field-level diff with loosening and restrictive fields and new domains highlighted); **Applied** (an operator pressed **Apply**: it becomes the approved version, every template site using the pack follows it, an `operator_actions` row and a `site_pack_changes` decision are recorded, and the previous approved version is kept for **Revert**, which restores it in one action); **Rejected** (dismissed; a newer version appears again). **Pin** keeps the current version and lists newer ones as "pinned at v7, v9 available". Applying a version whose `stealth-profile` or `browser` requirements a using template does not meet asks the operator to change the template or disable the site first. Bundled versions from a release and signed local layouts arrive as Downloaded; unsigned local files have their own approval (§10.5).
- **Surfaces**: the Site packs page (§11.4), the CLI `sitepacks list|check|download|diff|apply|reject|revert|pin|unpin|follow|approve-local` (§11.5), and the `site_pack.update_pending` notification for followed packs (§8.6).
- **Auto-update** (`sitePacksAutoUpdate`, off by default): §9.7.
### 10.7 Publishing (CI)

- **Source of truth**: a top-level `registry/` folder in the repository (`registry/packs/<id>.json`, canonical JSON; `registry/keys/root-1.pub`, `root-2.pub`), reviewed like code (CODEOWNERS: the owner).
- **Pull requests** touching `registry/**` run the `registry-check` job in `ci.yml`: `bun scripts/registry-build.ts --check` (a workspace script that imports core's `refinePack()`): schema and refinements for every pack, version strictly greater than on `main` for changed packs, globs parsed with the spec 11 grammar, size caps, and a classification report per pack in the job summary. `packages/core/test/site-packs/registry.test.ts` runs the same checks in `bun test`. `website/` is not a workspace member and never imports the schema.
- **Merge to `main`**: a `registry-build` job (no secrets) runs `bun install` and `bun scripts/registry-build.ts`, producing `dist/registry/v1/` (content-addressed pack files and an unsigned `index.json`) as an artefact. A separate `registry-sign` job in the GitHub environment `registry-signing` (deployment branches: `main` only; required reviewer: the owner, self-review prevented; secret `REGISTRY_ONLINE_KEY`, separate from `CLOUDFLARE_API_TOKEN`) checks out the commit **without installing dependencies**, runs a dependency-free verifier (`node scripts/registry-sign.mjs`, using only `node:crypto` and `node:fs`) that recomputes every pack hash from `registry/packs/*.json` at the commit, diffs the artefact against them, and only then signs `index.json`; it attests the artefact (`actions/attest-build-provenance`). The existing deploy job uploads the signed files.
- **Weekly** (`registry-resign.yml`, a scheduled workflow in the same environment, so each run waits for the owner's approval): re-sign the current content with a new `version` and `expires`. A missed approval only makes installs report `SITE_PACKS_STALE` after 14 days; nothing stops working.
- **Root operations** (adding or rotating the online key, writing `keys.json`) run offline with `bun scripts/registry-keys.ts` on the owner's machine.

### 10.8 Website hosting change (part of T4a)

browserhive.ai is a static Cloudflare Workers assets site (`website/wrangler.jsonc`); it needs one deploy change: the build copies the signed registry output into `website/dist/registry/v1/`, and `website/public/_headers` gains `/registry/v1/packs/*` → `Cache-Control: public, max-age=31536000, immutable` and `/registry/v1/*.json`, `/registry/v1/*.sig` → `Cache-Control: public, max-age=0, must-revalidate`, all with `Access-Control-Allow-Origin: *`. No server code runs; D-33 stands.

### 10.9 Bundled snapshot

- T3a bundles `registry/packs/*.json` into `packages/browserhive/dist/site-packs/packs/` at build time, with a generated `index.json`; their integrity is the release's (npm provenance, D-18).
- From T4b, the release workflow runs `bun scripts/snapshot-registry.ts` before publishing: it downloads the live signed files, verifies them with the pinned keys and writes the verified layout of §10.1 to `packages/browserhive/dist/site-packs/` (covered by `"files": ["dist"]`, `packages/browserhive/package.json:31-35`). The snapshot sets the initial rollback floors of a fresh install. A snapshot that does not verify fails the release.

---

## 11. Surfaces

### 11.1 REST (`/api/v1`, admin only)

Conventions of 03 §4–§5 apply (snake_case, problem+json, `Page<T>`, cursors, `If-Match`, weak ETags). Every route below is operator-only (**S**: operator session or operator bearer) and has exactly one scope (`ep(name, method, path, scope)`, `packages/contracts/src/http/endpoints.ts:24-30`), so the auth-matrix test covers it. Contracts live in `packages/contracts/src/http/templates.ts` and `packages/contracts/src/http/site-packs.ts`, routes in `core/src/interface/http/routes/templates.ts` and `routes/site-packs.ts` through `defineRoute` (03 §1.2). The PR column names the PR that adds each route.

**Templates**

`TemplateSummary` = `template_id, name, display_name, status, channel, headless, sites: [{site_id, title, health_state, checked_at}], host: {state, since, pages, rss_bytes?}, in_use, cap, current_version, checkpoint_at, last_used_at, sealed, identity_drift?: {from, to}`. `Template` = §2.1 (with `proxy.password_env`, never a value). `HostView` = `{state, since, started_at, restarts, last_error?, pages, parked_pages, rss_bytes?, recycle_at?, sandboxed, profile_secrets: boolean}`.

| Method | Path | Scope | Request | Response | Errors | PR |
|---|---|---|---|---|---|---|
| GET | `/templates` | `templates:read` | filters `status[]`, `host_state[]`, `site`, `q`; sort `name\|created_at\|last_used_at\|in_use` | `Page<TemplateSummary>` + `facets {status, host_state, health}` | — | T1a |
| POST | `/templates` | `templates:write` | `TemplateInput {name, display_name?, description?, sites: [{site_id, write_policy?}] (1–16), channel?, headless?, stealth?, fingerprint?, humanize?, proxy?: {server, bypass?, username?, password_env?, label?}, locale?, timezone_id?, geolocation?: {latitude, longitude, accuracy?}, agent_windows?, policy?: {authorized_principals?, harnesses?: string[]\|null, max_concurrent?, unseal?, health_interval_ms?, prelaunch_check?}}` | 201 `{template}` (`status: 'recording'`) | 400 `VALIDATION_FAILED` (an inline proxy credential, a `BROWSERHIVE_` `password_env`, `locale`/`timezone_id` missing with a proxy, `headless` with a `headed: 'required'` pack, `stealth: 'off'` with a `human_only` pack or below a `stealth-profile`, `policy.authorized_principals` missing under `auth=token`), 409 `TEMPLATE_NAME_TAKEN` | T1a |
| GET | `/templates/{template_id}` | `templates:read` | — | `{template, host: HostView, sites: TemplateSiteView[], sessions_live, parked_pages: [{target_id, url, title, opened_at}], shared_windows, unlisted_domains, now}` | 404 `TEMPLATE_NOT_FOUND` | T1a |
| PATCH | `/templates/{template_id}` | `templates:write` | any `TemplateInput` field except the frozen identity + `If-Match`; `proxy` or `channel` needs `confirm_identity_change: true`; `harnesses: null` clears (D-48) | `{template, closed_sessions}` (sessions that lost access, §3.2) | 400, 404, 409 `CONFLICT`, 409 `TEMPLATE_NAME_TAKEN` | T1b |
| DELETE | `/templates/{template_id}` | `templates:write` | `?force=true` closes live virtual sessions (`closed_reason: 'operator'`) | `{ok, closed_sessions, deleted_bytes}`; stops the host, deletes `templates/<id>/`; the dialog (typed name) says that deleting does not sign out at the sites | 404, 409 `TEMPLATE_IN_USE` | T1a |
| POST | `/templates/{template_id}/disable`, `/enable` | `templates:write` | — | `{template, closed_sessions}` | 404 | T1b |
| PUT | `/templates/{template_id}/sites/{site_id}` | `templates:write` | `{enabled?, write_policy?: 'allow'\|'warn'\|'confirm'\|null}`; adds the site when absent | `{site: TemplateSiteView}` | 400, 404 | T1b |
| PUT | `/templates/{template_id}/sites/{site_id}/relogin` | `templates:login` | `{vault_handle: string\|null, auto_relogin?: boolean, form?}`; the handler also requires `vault:write` on the caller (`FORBIDDEN` otherwise, listed in the auth matrix) | `{site: TemplateSiteView, binding_allows_template: boolean}` | 400 (`auto_relogin` on a `human_only` site or without a binding), 403, 404 | T2 |
| DELETE | `/templates/{template_id}/sites/{site_id}` | `templates:write` | — | `{ok}` | 404, 409 `CONFLICT` (the last site) | T1b |
| POST | `/templates/{template_id}/sites/{site_id}/clear-stop` | `templates:write` | — | `{site}` | 404 | T3a |
| POST | `/templates/{template_id}/domains/{domain}/remove-sign-in` | `templates:write` | — | `{ok, cookies_removed}` (an unlisted sign-in, §2.3) | 404 | T1a |
| POST | `/templates/{template_id}/recording` | `templates:login` | `{sites?: string[]}` | `{session_id, host: HostView}` (the maintenance session) | 404, 409 `TEMPLATE_DISABLED`, 429 `SESSION_LIMIT_REACHED` | T1a |
| POST | `/templates/{template_id}/recording/confirm` | `templates:login` | `{site_id}` | `{site}` (the generic site's **I'm signed in**, §7.1) | 404, 409 `CONFLICT` | T1a |
| POST | `/templates/{template_id}/recording/finish` | `templates:login` | `{remove_sign_ins?: string[]}` | `{template, version: number\|null}` | 404, 409 `CONFLICT` (not recording) | T1a |
| DELETE | `/templates/{template_id}/recording` | `templates:login` | — | `{ok}` (closes the maintenance session; status stays `recording`) | 404 | T1a |
| POST | `/templates/{template_id}/state` | `templates:write` | a Playwright storage state (≤ 16 MiB), `confirm?` | 202 `{operation_id}` (§7.4) | 400, 404, 409, 413 | T1b |
| POST | `/templates/{template_id}/relogin` | `templates:login` | `{site_id, method: 'window'\|'vault'}` | `{session_id}` | 400 (`vault` without a linked binding or on a `human_only` site), 404, 409 `TEMPLATE_DISABLED` | T2 |
| POST | `/templates/{template_id}/host/show` | `templates:login` | — | `{ok}` (raises the queued maintenance window, §8.4) | 404, 409 | T2 |
| POST | `/templates/{template_id}/probe` | `templates:write` | `{site_ids?: string[]}` | `{results: [{site_id, outcome, reason, duration_ms}]}` (waits, at most 120 s) | 404, 409 `TEMPLATE_DISABLED` | T2 |
| GET | `/templates/{template_id}/probes` | `templates:read` | filters `site_id`, `outcome[]`, `trigger[]`, `since`, `until`; cursor | `Page<ProbeRow>` | 404 | T2 |
| POST | `/templates/{template_id}/host/start`, `/stop`, `/restart` | `templates:write` | — | `{host}` (`restart` clears `failed`) | 404, 409 `TEMPLATE_DISABLED` | T1b |
| POST | `/templates/{template_id}/host/pages/{target_id}/close` | `templates:write` | — | `{ok}` (parked pages only) | 404 | T1b |
| POST | `/templates/{template_id}/host/clear-profile-secrets` | `templates:write` | — | `{ok}` (empties saved passwords and autofill, §3.1; restarts the host) | 404 | T1a |
| GET | `/templates/{template_id}/versions` | `templates:read` | cursor | `Page<TemplateVersionRow>` (`version, reason, restored_from, size_bytes, summary, health, pinned, last_good, readable, created_by, created_at`) plus `checkpoint: {at, size_bytes, readable}\|null` | 404 | T1b |
| POST | `/templates/{template_id}/versions` | `templates:write` | — | `{version: number\|null}` (`null`: structure unchanged since the newest version) | 404, 409 (host not running) | T1b |
| POST | `/templates/{template_id}/versions/{version}/restore` | `templates:write` | `{force_close?: boolean}`; `version` may be `latest` | 202 `{operation_id}` (§3.12) | 404 `TEMPLATE_VERSION_NOT_FOUND`, 409 `TEMPLATE_VERSION_UNREADABLE` | T1b |
| PATCH | `/templates/{template_id}/versions/{version}` | `templates:write` | `{pinned: boolean}` | `{version: TemplateVersionRow}` | 404 | T1b |
| GET | `/templates/operations/{operation_id}` | `templates:read` | — | `{operation_id, kind: 'restore'\|'seed', state: 'running'\|'done'\|'failed', version?, error?}` | 404 | T1b |
| POST | `/templates/{template_id}/access/resolve` | `templates:read` | `{principal?, harness?, harness_declared?}` | `{allowed, reason?: 'principal_not_allowed'\|'harness_not_allowed', rule?}` (the D-48 tester, applied to the template rule) | 400, 404 | T1b |
| POST | `/templates/{template_id}/data-dir/reveal` | `templates:write` | — | as `POST /sessions/{id}/data-dir/reveal` (03 §4.2); audited | 404 | T1b |

`GET /sessions` gains the filters `template[]` (template ids) and `maintenance` (`exclude`, the default, \| `include` \| `only`), the facet `templates` and the sort key `template`; `SessionSummary` gains `template?: {template_id, name, version, mode: 'live'\|'maintenance'}` and `sealed?: boolean` (present for template sessions only); 03 §4.2 lists them. Live view and screenshots of a maintenance session need `templates:login`, those of a template session `templates:read` in addition to the session scopes. `GET /sessions/{id}/timeline` gains the kind `guard` (rows of `site_guard_hits`, T3a). `/system.capacity` gains `browsers` (§6.3). `parked_pages[].url` in REST and WS is sanitized like `final_url` (D-20). Rate limits (03 §2): `/templates/{id}/probe`, `/templates/{id}/recording` and `/templates/{id}/state` 6/min, `/site-packs/check` 6/min.

**Site packs**

`SitePackView` = `pack_id, title, domains, approved: {version, sha256, source, provenance, by, at}\|null, previous: {version, source}\|null, pinned_version, follow: {setting: 'auto'\|'on'\|'off', effective: boolean}, enabled, local: {path, sha256, state: 'approved'\|'changed'\|'not_approved', approved_sha256?}\|null, pending: [{version, state: 'available'\|'downloaded', size, released, notes, classification?, new_domains?, source}], used_by: [template_id], human_only, write_policy_default, stance, verified, skipped?: {version, reason}`. `RegistryStatus` = `update_check, auto_update, url, last_check_at, last_ok_at, last_outcome, index_version, index_expires_at, stale, clock_skew_ms?, keys_version, bundled: {version, built_at}, local: {dir, count, signed_layouts, needing_approval}, skipped: [{pack_id, version, source, reason}]`.

| Method | Path | Scope | Request | Response | Errors | PR |
|---|---|---|---|---|---|---|
| GET | `/site-packs` | `sitepacks:read` | `q`, `source[]` (`local`, `registry`, `bundled`, `import`), `pending`, `follow` | `{data: SitePackView[], status: RegistryStatus, pending_count, local_needing_approval, now}` | — | T3a |
| GET | `/site-packs/{pack_id}` | `sitepacks:read` | — | `{view: SitePackView, pack: SitePackV1, versions: [{version, source, sha256, state}]}` | 404 `SITE_PACK_NOT_FOUND` | T3a |
| GET | `/site-packs/{pack_id}/diff` | `sitepacks:read` | `to` (a downloaded version, or `local` for the current local file), `from?` (default: approved) | `{from, to, classification, new_domains, changes: [{path, from, to, class}]}` (`class` from T3b) | 404, 409 (not downloaded) | T3a |
| POST | `/site-packs/{pack_id}/download` | `sitepacks:write` | `{version}` or `{all: true}` (every listed version the client lacks, all packs) | `{view, diff}` | 404, 409 (not in the index), 502 (verification failed: `SITE_PACK_INVALID`) | T4b |
| POST | `/site-packs/{pack_id}/apply` | `sitepacks:write` | `{version}` | `{view}` | 404, 409 `SITE_PACK_UPDATE_NOT_PENDING` (not downloaded) | T3a |
| POST | `/site-packs/{pack_id}/reject` | `sitepacks:write` | `{version}` | `{view}` | 404, 409 `SITE_PACK_UPDATE_NOT_PENDING` | T3a |
| POST | `/site-packs/{pack_id}/revert` | `sitepacks:write` | — | `{view}` (the previous approved version) | 404, 409 (no previous version) | T3a |
| PUT | `/site-packs/{pack_id}/pin` | `sitepacks:write` | `{version: number\|null}` | `{view}` | 400, 404 | T3a |
| PUT | `/site-packs/{pack_id}/follow` | `sitepacks:write` | `{follow: boolean\|null}` (`null` = automatic) | `{view}` | 404 | T3a |
| POST | `/site-packs/{pack_id}/approve-local` | `sitepacks:write` | `{sha256}` (the content the operator reviewed) | `{view}` | 404, 409 `CONFLICT` (the file changed since it was shown) | T3a |
| POST | `/site-packs/{pack_id}/enable`, `/disable` | `sitepacks:write` | — | `{view}` | 404 | T3a |
| POST | `/site-packs/check` | `sitepacks:write` | — | `{outcome: 'updated'\|'not_modified'\|'failed'\|'disabled', checked_at, available, error?: {code, message}}` | — | T4b |
| POST | `/site-packs/reload` | `sitepacks:write` | — | `{stats}` | — | T3a |
| POST | `/site-packs/import` | `sitepacks:write` | a signed layout (`{files: {"<path>": "<base64>"}}`) or one unsigned pack (stored in `sitePacksDir`, then approved like any local file); ≤ 1 MiB | `{imported: [{pack_id, version, state}]}` | 400 `SITE_PACK_INVALID`, 413 | T3a (unsigned), T4b (signed) |
| GET | `/site-packs/changes` | `sitepacks:read` | `pack_id`, `decision[]`, `since`, `until`, cursor | `Page<SitePackChangeRow>` | — | T3a |
| GET | `/site-packs/strategies` | `sitepacks:read` | — | `{data: [{id, title, description, kind: 'behaviour'\|'stealth', hooks, params: [{name, type, default, min, max, safe_direction}]}]}` | — | T3b |
| GET | `/site-packs/guard-hits` | `sitepacks:read` | `template_id`, `session_id`, `pack_id`, `action[]`, `since`, `until`, cursor | `Page<SiteGuardHitRow>` | — | T3a |
`/attention` lists `security_intercept` requests beside attention requests (`OperatorRequestRow.kind` gains `'security_intercept'` and `options` carries `reason`, `site`, `challenge` or `guard`, and for a write the method, sanitized URL and tool); `POST /attention/{request_id}/resolve` decides them (`resolve` = approve, `reject` = deny).

### 11.2 OpenAPI

Generated as today (`bun run gen:openapi`, `scripts/gen-openapi.ts`), checked by the OpenAPI golden; every new route has a problem+json response and every list route the shared `Page<T>` envelope (09 §3.1). The auth-matrix and list-golden tests gain the new routes with each PR.

### 11.3 WebSocket topics and bus events

| Topic | Scope | Event types → payload | PR |
|---|---|---|---|
| `templates` | `templates:read` | `template.changed {template: TemplateSummary}`, `template.removed {template_id}`, `template.host {template_id, host: HostView}`, `template.health {template_id, site: TemplateSiteView}`, `template.version {template_id, version: TemplateVersionRow}`, `template.operation {operation_id, kind, state}` | T1b |
| `site-packs` | `sitepacks:read` | `site_pack.changed {view: SitePackView}`, `site_pack.pending {pack_id, to_version, classification}`, `site_pack.status {status: RegistryStatus}` | T3a |

`WS_STATIC_TOPICS` (`packages/contracts/src/ws/topics.ts:6-18`) gains both. Session events are unchanged; template sessions' `SessionSummary` carries `template`. Bus events: `template.created`, `template.updated`, `template.deleted`, `template.host.changed`, `template.health.changed`, `template.probe.completed`, `template.version.created`, `template.proxy_assigned`, `site_pack.changed`, `site_pack.checked`, `site_pack.guard_hit`, plus the broker's existing `attention.*` events for `security_intercept` requests (`kind` in the payload).

**Naming.** One spelling per layer: scopes and CLI `sitepacks`; REST paths and WS topic `site-packs`; configuration `sitePacks*`; events, audit actions and notification kinds `site_pack.*`; metrics `browserhive.site_pack.*`; registry-level degradation codes `SITE_PACKS_*`, per-pack error codes `SITE_PACK_*`.

### 11.4 Dashboard

Routes (file-based, 04 §3): `_auth/templates.tsx`, `templates_.new.tsx`, `templates_.$id.tsx`, `site-packs.tsx`, `site-packs_.$id.tsx`; features `src/features/templates/` and `src/features/site-packs/`, reusing `features/vault/harnesses` (`HarnessRuleField`). Navigation (04 §6.1): **Templates** (order 25, badge: the number of sites that need a sign-in) with **Site packs** as its indented child item (order 26, badge: pending updates of followed packs plus local files needing approval), so the Site packs page sits in the Templates area of the sidebar; with `templates=false` or `sitePacks=false` they render in the "Not enabled" group naming the exact flag (04 §11 copy rule). Doc links go through `lib/links.ts`. Every page meets 04's quality bar: checked in a real Chrome at 390, 1024, 1440 and 1920 px in both themes, keyboard walk, axe (04 §1, principle 3).

**UI vocabulary** (docs keep the internal terms in the glossary):

| Internal term | UI label |
|---|---|
| host | Browser |
| parked pages | Other windows |
| sentinel | (never shown) |
| sealed / unseal flag | Sign-ins protected / Allow … |
| maintenance session | BrowserHive (system) |
| tightening / restrictive / loosening | Tightens rules / Can stop the site / Relaxes rules |
| `security_intercept` | Site check / Write approval |
| stance | What the site's terms say |
| virtual session | Session (with a "Template" badge) |

- **`/templates`**: header with **New template**; the pending-updates banner (§10.6); a table (cards under 768 px) of Template (display name, `name` in mono), Sites (one chip per site with its health dot: signed in, signed out, check needed, couldn't tell, not checked), Browser (state dot and pages), Sessions (`in_use / cap`), Last used, and a kebab (Open, Re-login…, Restart browser, Disable…, Delete…). A `recording` template shows "Setting up" with **Continue sign-in**. Empty state: what a template is, the three steps, **New template**.
- **`/templates/new`**: the wizard of §7.1, one step per screen (`?step=`), Back/Next with focus on the step heading, the site catalog as a searchable grid of pack cards (title, domains, `human_only`, write policy, terms stance) plus "Add another site", and the sign-in step showing per-site ticks live over the `templates` topic, with the remote-operator banner (§3.11) and the error states of §7.1.
- **`/templates/$id`**: header (display name, status pill, Browser state with Start/Stop/Restart and **Show window**, **Re-login** menu per site, Disable…, Delete…). Banners: identity drift, unsandboxed, saved passwords present (§3.1), unlisted sign-ins (§2.3), key missing or mismatched. Tabs (`?tab=`): **Sites** (default; a card per identity provider group: health with reason and last check, **Check now**, **Re-login**, **Clear stop**, write policy select with the pack's clause and stance, linked vault binding with **Allow this template** and the auto-relogin switch, guard and challenge counts, `device_bound` badge), **Sessions** (live and recent virtual sessions; "BrowserHive (system)" sessions marked; Other windows with Close; windows shared by several sessions), **Versions** (the checkpoint row, then versions with reason, size, per-domain summary, health, Last good, readable, **Restore…**, **Pin**, **Save version now**, **Seed from file…**), **Access** (principals, Harnesses field with D-48's note and warnings, cap, sealing switches each with the editor text of §5.4 and the principals they apply to, the access tester), **Settings** (the pinned identity read-only, the observed identity, proxy with "this may sign you out" confirmation, channel, headless warning, agent windows, health interval, pre-launch check, data-directory reveal), **Activity** (probes and guard hits, filterable).
- **Confirmations** (04 §11): delete (typed name), restore (lists the sessions that will close), disable or access changes that close live sessions (lists them), each unseal flag, applying a pack version that relaxes rules or can stop a site, approving a local file, reverting a pack, removing a site, seeding over a ready template.
- **`/site-packs`** (owner decision 2026-11-08): header with last check time and outcome, **Check now** and **Download all**; filter chips **Local**, **Online** (registry), **Bundled**, **Imported** and **Updates available**, plus search, all in the URL (`source`, `pending`, `q`). An **Updates available** section on top lists every pending version of followed packs and every local file that needs approval, one card each: pack title, from and to versions, size, release date and the publisher's notes; after **Download & review**, the classification chip and the field-level diff (loosening and restrictive fields and new domains highlighted, old and new values as text); actions **Download & review**, **Apply**, **Reject**, **Pin**; for local files **Approve** with the approved-versus-current diff. Below, the table of every pack (cards under 768 px): title and domains; source and provenance ("Bundled with BrowserHive 0.4.0", "browserhive.ai registry · key k-2026a · signature verified · index 1412", "Imported file", "Local file ~/.browserhive/site-packs/local/linkedin.com.json"); approved version, SHA-256 (short, copyable), approved by and at; local state (Approved, Changed since approval — review, Not yet approved); the templates that use it; **Follow updates** (Auto, On, Off) and **Enabled** switches; **Revert** when a previous version exists. A **Registry** card shows the update-check setting with the configuration key that controls it, the URL, index version and expiry, stale and clock warnings, auto-update state, **Import…** and **Reload local packs**; a **History** tab lists `site_pack_changes`. Empty, offline, stale and `sitePacks=false` states each have copy. Keyboard: every action is reachable in order, the diff is navigable by heading, focus returns to the card after an action.
- **`/site-packs/$id`**: every section of the pack as readable text (sign-in URL in full, probe, guards table with methods and kinds, challenges, pacing with official/vendor labels and sources, strategies with their parameters from `GET /site-packs/strategies`, terms clause with its date and URL as text, verified dates, sources as text with the domain shown), its provenance, pending versions with their diffs, the local-file diff with **Approve**, versions and history.
- **Elsewhere**: the session page shows a "Template: <display name>" badge and a "Sign-ins protected" pill, explains on the Files tab that tracing is off for template sessions, and shows the template's identity; `/sessions` gains the Template facet chip and "· <template>" on the session line; `/attention` labels `security_intercept` requests "Site check" or "Write approval" with the method, URL and guard for a write; `/system` shows browsers against the limit in Capacity and lists running browsers of templates.

### 11.5 CLI

Every command talks to a running server over the REST API with `--url` (default `http://127.0.0.1:<port>` from the resolved configuration), `--token` (an operator bearer with the scopes the command needs) or `--cookie`, like `channels` (08 §7.1); `--json` everywhere. Exceptions: `sitepacks verify` is offline (schema and pinned keys, no server), and `templates rekey` runs locally against the data directory with the server stopped (§2.4). Exit codes: 0 success; 1 failure (server unreachable or an API error, printed `[CODE] message`); 2 completed with attention needed (`templates probe` with a site not signed in, `sitepacks check` or `list --pending` with updates available for followed packs or local files needing approval, `templates create` finishing with a site not signed in); 64 usage error.

```
browserhive templates list
browserhive templates show <name>
browserhive templates create <name> --sites <site,…> [--displayName <text>] [--description <text>] [--channel <chromium|chrome|edge>]
                              [--headless] [--stealth <off|standard|max>] [--proxy <url> --proxyUsername <name> --proxyPasswordEnv <ENV>]
                              [--locale <tag> --timezone <iana>] [--maxConcurrent <1-20>] [--allPrincipals | --principal <subject>…]
                              [--noLogin] [--fromState <file>] [--timeout <duration>]
browserhive templates finish <name>
browserhive templates seed <name> <file> [--yes]
browserhive templates login <name> --site <site> [--method window|vault] [--timeout <duration>]
browserhive templates probe <name> [--site <site>]
browserhive templates versions <name>
browserhive templates save <name>
browserhive templates restore <name> <version|latest> [--forceClose] [--yes]
browserhive templates host <name> start|stop|restart
browserhive templates disable|enable <name>
browserhive templates rm <name> [--force] [--yes]
browserhive templates rekey --oldKeyEnv <ENV>
browserhive sitepacks list [--source local|registry|bundled|import] [--pending] | show <id> | check
browserhive sitepacks download <id> [--version <n>] | download --all | diff <id> [--to <version|local>]
browserhive sitepacks apply <id> [--version <n>] | reject <id> [--version <n>] | revert <id> | pin <id> <version> | unpin <id>
browserhive sitepacks follow <id> on|off|auto | approve-local <id> [--yes] | enable <id> | disable <id>
browserhive sitepacks import <dir|file> | export <dir> | reload | verify <path>
```

`templates login` and `templates create` open windows on the machine running the server, wherever the CLI runs; the CLI prints a warning when the server is not on the local machine. `restore`, `seed`, `rm`, `apply`, `revert` and `approve-local` (which prints the diff first) ask for confirmation on a terminal and refuse without one unless `--yes`. `--timeout` defaults to `30m`.

### 11.6 Configuration keys

The keys and their validation are in 08 §5.9 (authoritative): `templates`, `templateKey`, `templateKeyPrevious`, `templateHostIdleTimeout`, `templateMaxPagesPerHost`, `templateHealthInterval`, `templateCheckpointInterval`, `templateVersionsKeep`, `templateRecycleAfter`, `templateRecycleRss`, `templateDrainTimeout`, `sitePacks`, `sitePacksUpdateCheck`, `sitePacksAutoUpdate`, `sitePacksUrl`, `sitePacksDir`. Not obvious from their names: `templateKey` and `templateKeyPrevious` are secrets read once at boot (§2.4); `templateMaxPagesPerHost` counts agent pages only (§6.3); `sitePacksUpdateCheck` is the only default outbound request (D-55); `sitePacksAutoUpdate=true` never applies loosening or restrictive changes, bundled versions or local files. `persistence=blueprint` and the key `profiles` stay reserved (08 §5.4): templates are not a persistence mode.

### 11.7 Metrics and spans

Instruments (rows join the catalogue of 10 §7 with the PR that records them; the guard test of 09 §3.2 keeps the two equal):

| Instrument | Type | Unit | Attributes | Recorded | PR |
|---|---|---|---|---|---|
| `browserhive.template.hosts` | gauge (observable) | `{host}` | `state` (`starting`, `running`, `draining`, `crashed`, `failed`) | hosts per state at each export | T1a |
| `browserhive.template.checkpoints` | counter | `{checkpoint}` | `reason` (`checkpoint`, `recording`, `relogin`, `restore`, `manual`, `import`, `signin_change`, `daily`) | once per checkpoint or version written | T1b |
| `browserhive.template.probes` | counter | `{probe}` | `outcome` (`signed_in`, `signed_out`, `challenged`, `inconclusive`), `trigger` (`schedule`, `prelaunch`, `recording`, `relogin`, `manual`, `host_start`, `attention`, `restore`) | once per probe | T2 |
| `browserhive.template.relogins` | counter | `{relogin}` | `method` (`window`, `vault`, `attention`), `outcome` (`signed_in`, `failed`, `timeout`) | once per finished re-login | T2 |
| `browserhive.site_pack.guard_hits` | counter | `{hit}` | `action` (`block`, `confirm`, `warn`, `paced`, `held`), `kind` (`logout`, `account`, `credential`, `destructive`, `write`, `stop`) | once per `site_pack.guard_hit` | T3a |
| `browserhive.site_pack.challenges` | counter | `{challenge}` | `kind` (`checkpoint`, `captcha`, `reauth`, `locked`, `rejected`), `action` (`attention`, `stop`, `notify`) | once per detected challenge | T3a |
| `browserhive.site_pack.checks` | counter | `{check}` | `outcome` (`updated`, `not_modified`, `failed`, `stale`) | once per update check | T4b |

Changes to existing instruments (T1a): `browserhive.sessions.active` and `browserhive.session.launch.duration` gain the attribute `mode` (`exclusive`, `virtual`, `maintenance`); `browserhive.browser.rss_bytes` reports one series per running host with the attribute `template_id` and none per virtual session (a host's sessions share its process tree; the OTel sampler maps a host's pid to its template, not to a session). Pack ids, site ids and template names are never metric attributes.

Spans (10 §6): `template.host.start` (`browserhive.template_id`, `browserhive.channel`, `browserhive.headless`), `template.host.stop` (`browserhive.reason`), `template.attach` (child of `session.launch` for a virtual session), `template.probe` (`browserhive.site`, `browserhive.outcome`), `template.checkpoint` (`browserhive.version`), `template.restore`, `site_pack.check` (`browserhive.outcome`, `browserhive.index_version`); `site_pack.guard_decide` only under `--otelVerbose`.

### 11.8 Audit

`operator_actions` rows (03 §7, audit class), `resource_kind` `template` or `site_pack`: `template.create`, `template.update` (with the changed field names; `unseal` and `access` changes named explicitly), `template.delete`, `template.disable`, `template.enable`, `template.record.start`, `template.record.confirm`, `template.record.finish`, `template.record.cancel`, `template.seed`, `template.relogin` (with the D-41 presser when it came from a notification), `template.relogin_link`, `template.probe`, `template.host.start`, `template.host.stop`, `template.host.restart`, `template.host.show`, `template.page.close`, `template.signin.remove`, `template.profile_secrets.clear`, `template.version.save`, `template.version.restore`, `template.version.pin`, `template.site.clear_stop`, `template.data_dir.reveal`, `site_pack.approve` (first use, with the provenance), `site_pack.download`, `site_pack.apply`, `site_pack.reject`, `site_pack.revert`, `site_pack.pin`, `site_pack.follow`, `site_pack.approve_local` (with the SHA-256), `site_pack.enable`, `site_pack.disable`, `site_pack.import`, `site_pack.check`, `site_pack.reload`, `site_pack.local_override` (on load). Automatic decisions (auto-update, revocations) are `site_pack_changes` rows with `decided_by: 'browserhive'`. Guard decisions are `site_guard_hits` rows (§9.9, with `decided_by` for confirmations); vault auto-relogin fills are `vault_access` rows on their maintenance session with `trigger: 'auto_relogin'`.

### 11.9 `doctor`

New checks (08 §7.1), each skipped when no template exists unless stated:

| Check | ✓ | ! (warning) | ✗ |
|---|---|---|---|
| `templates data` | `templates/` and `admin/` 0700, version files 0600 | modes broader | `templates/` unreadable |
| `template key` | the key resolves (`templateKey` or the key file, 0600) and every file's `key_id` matches | key file broader than 0600; files with another `key_id`; `templateKey` given as a flag | files exist and no key resolves (`TEMPLATE_KEY_MISSING`) |
| `template display` | every headed template's host has started on this machine, or a display variable or session is present | `Desktop.hasDesktopEnvironment()` true but the last host start failed with `no_display`; Xvfb without `-auth` (`XAUTHORITY` unset) | a headed template and no display; prints the Xvfb, VNC, LaunchAgent and interactive-session guidance |
| `template access` (T1a) | under `auth=token`, no template's access names only `local` | templates created under `auth=off` without an explicit choice store `local` and are reachable by operators only after a switch to `auth=token`: names them (§6.1) | — |
| `template agents` | transport is `http` with `auth=token` | transport `stdio` or `auth=off` while templates exist: "agents that can run commands as this user can read the templates directly; run BrowserHive as a separate user or in a container, over HTTP with per-agent tokens" | — |
| `template browsers` | every template's channel is installed | identity drift (major changed since creation); unsandboxed hosts | a template's channel is missing (names the install command) |
| `template profiles` | no saved passwords or autofill data in any template profile | some template has them (§3.1) | — |
| `template proxies` | every `password_env` is set | — | a named variable is unset (names it, never a value) |
| `template memory` | `maxSessions` fits RAM counting each recently used template at `templateRecycleRss` (§6.3) | it does not | — |
| `site packs` (always) | the bundled snapshot verifies; status of the update check | update check on: "checks <sitePacksUrl> every 24 h and downloads only the signed index; sends nothing about this install"; stale index; local clock more than 5 min from the registry's `Date`; pending updates of followed packs; local files not yet approved or changed since approval; skipped packs | the bundled snapshot does not verify |

### 11.10 Retention, purge, backups and init

| Class (03 §7.1) | Tables / files | Rule |
|---|---|---|
| configuration | `templates`, `template_sites`, `site_pack_state` | never pruned |
| template versions | `template_versions` + `versions/*` | §3.9 (newest `templateVersionsKeep`, pinned, Last good; the checkpoint slot) |
| telemetry | `template_probes` | `retentionDays` |
| audit | `site_pack_changes`, `site_guard_hits` | `auditRetentionDays`; never byte-pruned; `site_guard_hits.session_id` becomes `NULL` when its session is pruned |
| artifacts | `templates/<id>/` | deleted with the template |

- `purge`: `templates` ("Session templates (signed-in browsers and their versions)") and `site-packs` join the `--all` targets (`packages/core/src/app/maintenance/purge.ts:13-15`, `packages/browserhive/src/cli/commands/purge.ts:22-35`); purging the database alone while `templates/` exists warns that the template directories will be orphaned and names `--all`.
- Backups (`db backup`, pre-migration backups) contain the template rows, not the files. Backing up a template means copying `templates/<id>/` together with the key (`admin/template.key` or the `templateKey` value); `docs/guide/templates.md` says so. Encrypted export and import are deferred (§16).
- `init` and boot create `templates/` and `site-packs/` (`DATA_SUBDIRS`, `packages/browserhive/src/composition/data-dir.ts:11`), so `doctor` does not flag them as unrecognised (`packages/browserhive/src/cli/commands/doctor-checks.ts:288`); D-24's layout gains both.

---

## 12. Error registry entries

Tool-surface codes go in `packages/contracts/src/errors/codes-session.ts` (`URL_SCHEME_NOT_ALLOWED` in `codes-page.ts` beside `URL_BLOCKED`), REST-only codes in `codes-service.ts`, degradation codes in `codes-boot.ts` and warnings in `codes-audit-warning.ts`, each with `title`, `hint`, `cause` and `resolution` prose for `docs/reference/errors.md` (10 §1). Messages use `{name}` slots filled from `details` by the registry's `renderMessage` (`packages/contracts/src/errors/spec.ts:58-70`); a list detail has a joined string companion (`sites_text`) for its slot. Public messages of tool-surface codes are contract once published (10 §1.1). Their messages, hints and details follow the agent-facing rule of §5; `cause` and `resolution` (operator documentation) may name the mechanism.

| Code | HTTP | Category | Retryable | Details | Public message | PR |
|---|---|---|---|---|---|---|
| `URL_SCHEME_NOT_ALLOWED` | 400 | domain | different_args | `{scheme}` | `URLs with the '{scheme}:' scheme cannot be opened here. Use an http:// or https:// URL (or about:blank).` | T0d (shipped in 0.2.3) |
| `TEMPLATE_NOT_FOUND` | 404 | domain | different_args | `{template}` | `No session template named '{template}'. Use list_templates to see the templates you can use.` (identical for unknown, unauthorized and still-recording templates) | T1a |
| `TEMPLATE_BUSY` | 429 | domain | backoff | `{template, limit_kind: 'capacity'\|'tabs'\|'pace', limit_text, retry_after_ms, retry_after_s}` | `{limit_text} Retry in {retry_after_s} s.` — `limit_text`: capacity "Template '<name>' is at capacity.", tabs "This session has reached its tab limit; close a tab you no longer need.", pace "Actions on <site> are being paced." | T1a |
| `TEMPLATE_NEEDS_LOGIN` | 409 | domain | after_operator | `{template, sites, sites_text}` | `Template '{template}' is signed out of {sites_text}. The operator has been asked to sign in again; retry after that.` | T2 |
| `TEMPLATE_UNAVAILABLE` | 503 | domain | backoff | `{template, reason: 'starting'\|'restarting'\|'recovering', retry_after_ms}` | `Template '{template}' is temporarily unavailable. Retry in a few seconds.` | T1a |
| `TEMPLATE_DISABLED` | 409 | domain | after_operator | `{template, reason: 'disabled'\|'needs_operator'}` (the host's cause, `host_failed`, `no_display`, `proxy_unreachable` or `sandbox_unavailable`, is on operator surfaces only) | `Template '{template}' cannot be used until the operator fixes it.` | T1a |
| `SESSION_SEALED` | 403 | domain | never | `{session_id, tool}` | `{tool} is not available in this session: its sign-ins belong to the operator's session template.` | T1a |
| `SITE_OPERATOR_PENDING` | 409 | domain | after_operator | `{session_id, site, request_id: string\|null, reason: 'challenge'\|'write_confirm'\|'stopped', wait_text}` | `{site} needs the operator before this session can continue ({reason}). {wait_text}` — `wait_text`: "Wait with get_attention_result('<request_id>'), or close the session." or, for `stopped`, "Do not retry until the operator clears the site." | T3a |
| `SITE_ACTION_BLOCKED` | 403 | domain | never | `{session_id, site, guard}` | `This action on {site} is blocked by the operator's site rules. Do not retry it.` | T3a |
| `TEMPLATE_NAME_TAKEN` | 409 | domain | different_args | `{name}` | REST only | T1a |
| `TEMPLATE_IN_USE` | 409 | domain | different_args | `{template_id, live_sessions}` | REST only (`?force=true` closes them) | T1a |
| `TEMPLATE_VERSION_NOT_FOUND` | 404 | domain | never | `{template_id, version}` | REST only | T1b |
| `TEMPLATE_VERSION_UNREADABLE` | 409 | domain | after_operator | `{template_id, version, key_id}` | REST only (another key, or no key, §2.4) | T1b |
| `SITE_PACK_NOT_FOUND` | 404 | domain | never | `{pack_id}` | REST only | T3a |
| `SITE_PACK_INVALID` | 400 | domain | different_args | `{source, issues: [{path, message}]}` | REST and CLI | T3a |
| `SITE_PACK_UPDATE_NOT_PENDING` | 409 | domain | never | `{pack_id, version}` | REST only (the version is not downloaded or not pending) | T3a |
| `TEMPLATE_HOST_FAILED` | — | boot | never | `{template_id, reason, attempts}` (degradation record, 10 §3) | | T1a |
| `TEMPLATE_KEY_MISSING`, `TEMPLATE_KEY_MISMATCH` | — | boot | never | `{template_ids}`, `{template_id, versions[]}` (degradation records) | | T1b |
| `TEMPLATE_CHECKPOINT_FAILED`, `TEMPLATE_CHECKPOINT_TOO_LARGE` | — | boot | backoff, never | `{template_id, error}`, `{template_id, size_bytes, dropped_origins[]}` (degradation records, warn) | | T1b |
| `SITE_PACKS_STALE` | — | boot | never | `{index_version, expired_at, clock_skew_ms?}` (degradation record, warn) | | T4b |
| `SITE_PACKS_FETCH_FAILED` | — | boot | backoff | `{failures, last_error}` (degradation record, warn) | | T4b |
| `TEMPLATE_SITE_SIGNED_OUT`, `SESSION_RESOURCE_LIMIT`, `TEMPLATE_STATE_COPY`, `SITE_GUARD_WARNED`, `SITE_PACED`, `SITE_WRITE_HELD` | — | warning | — | `{session_id, message, details}` (SessionWarning, shown to operators; messages follow §5) | | T2, T1b, T1b, T3a, T3b, T3a |

`navigate` and `new_tab` document `URL_SCHEME_NOT_ALLOWED` (T0d); `launch_session` documents `TEMPLATE_NOT_FOUND`, `TEMPLATE_BUSY`, `TEMPLATE_NEEDS_LOGIN`, `TEMPLATE_UNAVAILABLE` and `TEMPLATE_DISABLED`; `new_tab` documents `TEMPLATE_BUSY`; `set_cookies` and `save_storage_state` document `SESSION_SEALED`; every navigation and interaction tool documents `SITE_OPERATOR_PENDING` and `TEMPLATE_BUSY` (`serialize-site`, §9.4), and `click`, `hover`, `select_option`, `drag_and_drop`, `fill`, `type_text` and `press_key` `SITE_ACTION_BLOCKED`. Each is a new typed code where a generic failure was possible or where D-57 makes a refusal a security fix, so additive (D-12).

---

## 13. Security considerations

- **A template is a bearer credential** that bypasses the password and MFA of every site in it; the operator decides who may launch it (§6.1), and every operator action is audited (§11.8).
- **Sealing is narrow by design** (§5.4): it keeps cookie values and storage exports out of agent results and redacts cookie values from text results. An agent can still act as the account, including minting new credentials where no `credential` guard stops it, and can read what pages display. Bundled packs guard the credential flows they know (§9.8).
- **Agents with OS access are out of scope for sealing.** An agent that can run commands as BrowserHive's OS user (typical for local harnesses on `stdio`) can copy `userdata/` and decrypt it with the published constant key, read `admin/template.key`, or drive the windows through the display. Run BrowserHive as a separate OS user or in a container, over HTTP with per-agent tokens, when agents have shell access; `doctor` warns (§11.9). Never run a bare `Xvfb` (§3.11).
- **Non-web URL schemes are refused for every session** (D-57, T0d): without that, `file://` reads the data directory (including `admin/template.key` and profile files), `chrome://` pages expose the shared history, passwords and settings, and `javascript:` runs agent script past a forced `disable_evaluate`. The host's self-origin guard (§3.8) keeps the dashboard and its cookie out of templates.
- **The operator's desktop.** Hosts are headed on the operator's machine. BrowserHive never activates a host window on its own, minimizes agent windows while the operator signs in, and refuses clipboard chords in template sessions (§3.3); the operator should type, not paste, and check the address bar. A tab the operator opens by hand is parked, never an agent's (§3.4). Saved passwords, autofill and browser sign-in are off in hosts (§3.1).
- **The isolation boundary of live mode is page attribution** (§3.4), not a process. A bug there lets one agent drive another's page; T0c lands the split behind property tests before any template exists (§17). One agent can still slow its siblings (shared renderer processes, the page caps of §6.3, memory, §3.2); one agent's sign-out signs everyone out (§5.6).
- **Unsealed `evaluate`** gives code execution in an origin every sibling shares (storage, caches, service workers): it unseals the template for everyone who may use it (§5.4).
- **Vault credentials stay per agent.** Agent fills are refused in template sessions (§5.5); auto-relogin runs as `template:<id>` through every vault gate (§8.4); every fill writes the password only into a password input (D-58, T0e).
- **At rest**: checkpoints and versions are encrypted with the header in the AAD; the live profile is protected by file modes only (§2.4).
- **Publisher trust** is bounded by signatures, expiry, rollback floors, the schema's constraints, a default-deny classifier and the operator's approval of every version before it applies (§9.6, §9.7, §9.10, §10.3). A compromised online key can, without operator approval, withhold updates and, only with auto-update on, apply tightening and neutral changes to followed packs; a revocation never applies a looser fallback without approval (§9.7). Unsigned local files apply only with content an operator approved.
- **Outbound traffic**: one anonymous `GET` of the signed index every 24 h while the check is on; no install identifier, no tracking ETag; a pack file is fetched only when an operator downloads it (or auto-update does), which reveals that version to the registry unless **Download all** is used (§10.4, D-55).

---

## 14. Testing

Conventions of spec 09 apply (colocated `bun test` units with fakes and an injected clock; real-Chromium integration suites in `packages/core/test/integration/`; dashboard component tests with axe; Playwright end-to-end; contract goldens). The suites each PR adds are listed with it in §17. Five are invariants in the sense of 09:

- **URL schemes** (every session, T0d, shipped in 0.2.3 as `domain/policies/url-scheme.test.ts`, `app/sessions/scheme-guard.test.ts` and `test/integration/url-schemes.test.ts`; T1a adds the virtual-session cases): for every tool that takes a URL and for each of `file:`, `chrome:`, `chrome-untrusted:`, `chrome-extension:`, `devtools:`, `view-source:`, `javascript:` (including `JAVA\tSCRIPT:` and leading whitespace), `blob:`, `filesystem:`, `mailto:`, `about:version` and a scheme-less `localhost:3000`, the call answers `URL_SCHEME_NOT_ALLOWED` and the browser is not touched; `data:` passes in exclusive sessions and is refused in virtual ones.
- **Page attribution** (§3.4): property-tested on the fake host model with fast-check, 1 000 cases in the fast suite and 100 000 nightly, and against real Chromium.
- **Sealing** (T1a): a sentinel cookie (also embedded in the page's HTML), a sentinel localStorage value and a sentinel IndexedDB value never appear in any agent-facing result of a sealed session, nor in its `tool_calls` rows, across every tool, including after `javascript:` and `data:` attempts.
- **Vault target** (T0e, shipped in 0.2.3 as `domain/vault/fill-target.test.ts` and the integration vault suite): a fill whose password selector resolves to anything but exactly one password input never writes the password.
- **Pack data never executes** (T3a): a malicious-pack corpus in which every abuse row of §9.10 (including `:text-matches`, a path that matches a logout guard, a domain removal and a match-everything challenge) is a fixture that must be refused, classified as stated, or rendered inert.

**Test fixtures.** The fixture server (09 §9) gains an HTTPS listener with a checked-in test certificate for `*.test` (`packages/core/test/fixtures/tls/`) and serves fixture sites as `https://site-a.test`, `https://site-b.test`, `https://idp.test` and `https://cdn-a.test`. A server created with the internal testing seam `createServer({ testing: { hostResolverRules: 'MAP *.test:443 127.0.0.1:<port>', ignoreCertificateErrorsSpkiList: '<spki>' } })` (08 §9; `browserhive/testing` only, `@internal`) adds the two Chromium switches to every host and exclusive session it launches; agent launch options still cannot (`--host-resolver-rules` stays deny-listed, `packages/core/src/infra/browsers/pass-through.ts:131`). `registrableDomain('www.site-a.test') === 'site-a.test'` (the public-suffix default rule) is asserted. Loopback and IP hosts have no registrable domain (`packages/core/src/kernel/url.ts:47-50`), which is why the fixture sites need names.

---

## 15. Non-goals

- Several concurrent copies of one template's cookie jar (fork mode). Concurrent copies sign each other out (Google supersedes a copied snapshot in about 10 minutes; refresh-token rotation with reuse detection revokes the whole family, RFC 9700 §4.14.2) and device-bound sessions cannot be copied at all.
- Code delivered through packs or the registry (scripts, selectors evaluated as script, launch arguments, regular expressions).
- Sending anything about an install to browserhive.ai: no telemetry, no install id, no per-site requests.
- Agents creating, changing or exporting templates, or filling vault credentials into them.
- Solving challenges automatically: a challenge is handed to a human.
- Protecting templates from agents that run code as BrowserHive's OS user (§13).

## 16. Deferred

| Item | Why deferred | Seam that keeps it open |
|---|---|---|
| Serial checkout (one copy at a time under an exclusive lease, written back on close; for headless servers and isolation) | live mode covers the concurrent case; a lease and write-back are a separate design | `template_mode` is an open set (`serial` reserved); `device_bound` blocks it per site |
| Per-page trace split for virtual sessions | a host tracer records every agent; splitting by `pageId` and redacting vault fills by time needs its own design | `BrowserHost.tracing` is `null` for template hosts |
| Recording and re-login through the dashboard live view | live-view input lacks clipboard, IME and tab switching (04 §16) | the maintenance session already has a live view |
| A request guard that keeps the HTTP cache, and aborts redirect hops | needs response-stage interception on a raw CDP `Fetch` session that coexists with Playwright's routing | `InterceptionChain` is one type with ordered handlers |
| Packs for exclusive sessions and as stealth defaults | the owner's later step; needs per-session owner resolution everywhere | the request guard and the registry are session-agnostic |
| Encrypted export and import of templates | key handling across machines; `device_bound` sites cannot move | the envelope format of §2.4 carries `key_id` |
| Encrypting saved auth states | separate migration of existing files | `TemplateKeyProvider` |
| A warm pool of hosts, staged pack rollouts, community packs without owner review | not needed for v1 | — |

---

## 17. The PR program

Each PR is its own branch and pull request (spec 07), with a changeset, its tests and its docs; the owner merges between PRs. Every PR builds and passes CI on its own: no test of a PR needs code, data or a table of a later one. "Docs" lists hand-written guides; generated references (`bun run gen:docs`, `gen:openapi`, `gen:db-types`) are regenerated in every PR that changes their sources.

| PR | Delivers (usable on its own) | Depends on | Migration | Goldens that change |
|---|---|---|---|---|
| **T0a** | auth-state names per principal (fix). **Shipped in 0.2.3, #64** | — | — | — |
| **T0d** | URL scheme allowlist for every session (fix, D-57). **Shipped in 0.2.3, #65** | — | — | `tools.json` (`navigate`, `new_tab` descriptions), errors |
| **T0e** | vault fills write passwords only into password inputs (fix, D-58). **Shipped in 0.2.3, #63** | — | — | `tools.json` (`vault_fill` reasons) |
| **T0f** | reserved principal subjects (fix). **Shipped in 0.2.3, #67** | — | — | — |
| **T0b** | `InterceptionChain` type and the method-aware request guard mechanism (no rules) | — | — | — |
| **T0c** | `BrowserHost` / `SessionView` split and the attribution dispatcher (no behaviour change) | — | — | — |
| **T1a** | templates core: create and record from the CLI, agents list and launch over MCP, sealing | T0b, T0c (T0d and T0f shipped) | v9 | `tools.json` (`list_templates`; `launch_session` parameter and description; `template` in `launch_session`/`list_sessions`/`session_info` results; `get_cookies.sealed`), errors, `schema-v9.json`, config schema, OpenAPI, scopes |
| **T1b** | template operations: checkpoints, versions, keys, restore, seed, every REST route, WS, CLI, `doctor`, purge | T1a | — | OpenAPI, WS topics, config schema, errors, metrics catalogue |
| **T1c** | the Templates dashboard | T1b | — | — |
| **T2** | health: generic probes, schedule, pre-launch check, re-login, notifications | T1b | — | notification JSON schema, OpenAPI, errors, metrics catalogue |
| **T3a** | site packs, local: schema, registry (bundled, local), approval on first use, local-file approval by hash, pending bundled versions with Apply/Reject/Revert/Pin/Follow, guards, write policies and confirmations, challenges, navigation probes, bundled packs, the Site packs page | T2, T0b | v10 | `schema-v10.json`, OpenAPI, WS topics, errors, notification JSON schema, config schema, metrics catalogue |
| **T3b** | strategies, pacing, the classifier (chips, restrictive, revocation) | T3a | — | OpenAPI |
| **T4a** | registry publishing: `registry/`, CI check and signing, website headers, key scripts, signed-layout verification in `sitepacks verify` | T3a | — | — |
| **T4b** | the registry client (automatic index check, Download & review, auto-update, follow-driven notifications), signed imports, the release snapshot | T4a, T3b | — | OpenAPI, config schema, errors, notification JSON schema, metrics catalogue |

### T0 — Prerequisites

T0a, T0d, T0e and T0f fixed defects in every BrowserHive session. They were independent of templates and of each other and **shipped in 0.2.3** (`main` @ `96c572a`) ahead of this spec; the paragraphs below record what was implemented, which is now the specified behaviour of the other specs (02, 03, 08), and the follow-ups T1a owes at the end of this section. T0b and T0c are behaviour-neutral refactors that only templates need and are still to come.

**T0a. Auth-state names are scoped per principal. Shipped in 0.2.3, #64.** Before it, `saveStorageState` and `saveFullProfile` wrote `<name>.*` and a manifest naming the caller without reading an existing one, so principal B saving a name A used replaced A's snapshot and took ownership of it, and identity seeds were not scoped at all. *Implemented*: `local` keeps the flat `auth-states/<name>.*` layout; every other principal has `auth-states/p/<first 16 hex chars of SHA-256(subject)>/<name>.*` (directories 0700, `principalDirName`, `PRINCIPAL_DIRS_NAME = 'p'` in `app/auth-states/store.ts`). `list`, restores, `loadIdentitySeed` and `remove` look only in the caller's directory and also require `manifest.owner === subject`; a missing, foreign or other-kind name answers the unchanged `AUTH_STATE_NOT_FOUND` text (no oracle), and a restore requires the requested `kind`. One name is one snapshot: saving either kind removes the caller's other-kind payload and seed of that name, payload first, so a failed save leaves the previous snapshot. On the first store access after start each flat manifest with a non-`local` owner moves into its owner's directory (payloads and seed first, manifest last, idempotent and resumable; when the owner already has the name, the newer `saved_at` wins; a `local` save over a still-foreign flat name moves it first); owner-less manifests stay `local`'s. The `AuthStateLocator` port gained the principal (spec 02 §6, design notes). *Not in T0a as shipped*: deleting saved logins from the operator's page (`remove()` has no operator caller yet; open PR #70). *Tests*: `store.test.ts` (cross-principal saves of all kind pairs, seeds, migration with a crash mid-move, newer copy wins), `test/integration/auth-states.test.ts` with two agent principals. *Docs*: `docs/guide/security.md` ("Saved logins are per principal"), `docs/guide/upgrading.md` (layout; a downgrade hides `p/`), `docs/guide/installation.md`, spec 02 §6.

**T0d. Agent-requested URLs are limited to web schemes (D-57). Shipped in 0.2.3, #65.** *Implemented*: `checkAgentUrl(raw, {allowData})` in `domain/policies/url-scheme.ts` behind the `urlScheme` tool policy, which runs after `sessionOwnership` and before `urlBlocklist` for `navigate` and `new_tab(url)`. It parses with WHATWG `URL` (tabs, newlines and surrounding whitespace stripped, so `java\tscript:` is `javascript:`), compares the scheme lowercased and accepts `http:`, `https:`, exactly `about:blank`, and `data:` while `allowData` is set, which is every session today because every session is exclusive. Anything else answers `URL_SCHEME_NOT_ALLOWED` (400, `different_args`, details `{scheme}`: lowercased, without the colon, `localhost` for `localhost:3000`, `''` with the message "This URL is not an absolute URL, so it cannot be opened here. …" for input that does not parse, such as `example.com`) before the browser is touched; the tool then navigates to the normalized `href`; a refused `new_tab` opens no tab. The backstop (`app/sessions/scheme-guard.ts`) is a `framenavigated` listener on every page of every session (the first page, `new_tab` pages, site-opened popups) that closes a page whose main frame commits a URL outside `http:`, `https:`, `about:blank`/`about:srcdoc`, `blob:`, `chrome-error:` and `data:`, removes its tab and logs `non-web scheme page closed` with the session id and scheme. Site-initiated `blob:` and `data:` documents and downloads are unaffected; `go_back`, `go_forward` and `reload` are not checked. *Tests*: `url-scheme.test.ts` (the parse table), `scheme-guard.test.ts`, `test/integration/url-schemes.test.ts` (every scheme of the §14 invariant on real Chromium through both tools, `data:` still opening, site-initiated `data:`/`blob:` left alone). *Docs*: `docs/guide/security.md`, `docs/reference/errors.md` (generated), spec 02 §3.3 and §3.4, spec 11 §5.

**T0e. A vault fill writes the password only into a password input (D-58). Shipped in 0.2.3, #63.** *Implemented* as gates 4a and 4b of spec 02 §3.13 (`domain/vault/page-actions.ts`, `domain/vault/broker.ts`): after the origin re-check the broker waits up to the field timeout (30 s) for `password_selector` to be visible (a field that never shows is `auth_failed` / `fill_failed`, nothing fetched); then `password_selector` must match exactly one `<input>` whose `type` is `password`, visible, not disabled and not `readonly`, and `username_selector` exactly one `<input>` whose type is not `password`, `hidden`, `file`, `checkbox`, `radio`, `submit`, `button`, `image` or `reset` (a username selector that matches nothing passes before the fetch). The check runs through `page.$$eval` and fails closed. Immediately before each value is typed (trace chunk paused) it runs again (`phase: 'pre_fill'`; a username that matches nothing is now refused, and a refusal after the username was typed clears it). A refusal returns `blocked` / `password_target_invalid` with a `vault_access` row carrying `phase`, `field` and `problem`; nothing is fetched before the pre-fetch gates pass. *Tests*: `fill-target.test.ts`, broker tests, `test/integration/vault.test.ts` against fixture forms (text input, `textarea`, `contenteditable`, two matches, hidden and disabled inputs, a swapped element, a late-rendered form). *Docs*: `docs/guide/vault.md`, spec 02 §3.13, `vault_fill` golden.

**T0f. Reserved principal subjects. Shipped in 0.2.3, #67.** *Implemented*: `RESERVED_SUBJECTS` (`local`, `browserhive`, `system`), `RESERVED_SUBJECT_PREFIX` (`template:`) and `isReservedSubject` in `domain/auth/reserved-subjects.ts`. Agent token creation (`app/auth/token-ops.ts`) refuses a reserved subject, given (the CLI's `admin tokens create <principal>`) or derived from `display`, with 400 `VALIDATION_FAILED`, `detail: 'subject is reserved'` and one issue `{path: 'subject'|'display', message: 'subject is reserved', code: 'reserved'}`, writing nothing. The comparison is on the NFKD-folded, mark-stripped, lowercased, trimmed form and on the `sanitizeSlug` form (`Local`, `ＬＯＣＡＬ`, `-local-` refused; `local-runner`, `template-x` not). Operator tokens are unchanged. Tokens issued earlier keep working and are never revoked: `browserhive doctor` (check `reserved subjects`) and one boot warning (`reserved subjects in use`) name each such agent token and each `authTokens` item with a reserved name. The dashboard's create-token form shows the refusal inline. *Tests*: `token-ops.test.ts`, `reserved-subjects` unit tests, `packages/browserhive/test/composition/reserved-subjects.test.ts`, the doctor tests, `TokensSection.test.tsx`. *Docs*: spec 03 §3.5 and §4.1, spec 08 `doctor`, `docs/guide/mcp-clients.md` ("Reserved names"), `docs/guide/security.md`, `docs/guide/cli.md`.

**Follow-ups from the 0.2.3 fixes.** Where the shipped fixes stop short of what templates need, PR T1a adds:

1. **`data:` in virtual sessions (T0d).** `checkAgentUrl` already takes `allowData`, but the tool policy and the backstop pass `true` for every session (`scheme-guard.ts`: "every session is exclusive today"). T1a passes `allowData: false` for a virtual session in the `urlScheme` policy and makes the backstop's committed-scheme set per page owner: a page attributed to a virtual session (or parked on a host) that commits `data:` is closed like any other non-web scheme, while exclusive sessions keep `data:`. Tests: the virtual-session rows of the §14 invariant, including a site-opened `data:` popup in a template session.
2. **Template scopes on existing operator tokens (scopes, migration v8).** 0.2.3 made the credential decide and `hasFullOperatorAccess` require every operator scope. Adding the five scopes of §6.2 would silently demote an operator token issued with the explicit 0.2.x full list, so migration v9 rewrites that list to `[]` (§2.5, §6.2); the `operator-token-scopes` migration test pattern is reused.
3. **Reserved names in `authTokens` (T0f).** Only token creation refuses reserved subjects; an `authTokens` config item with a reserved name (`browserhive`, `system`, `local`) is warned about, not refused (a name cannot contain `:`, so `template:*` cannot be configured). T1a therefore keys the maintenance-session refusal of §6.1 on `sessions.template_mode`, never on the subject, and auto-relogin's `template:<template_id>` principal (§8.4) is constructed in-process and never matched from a credential. A test launches a maintenance session and drives it from an agent authenticated by an `authTokens` item named `browserhive` (refused with `SESSION_NOT_FOUND`).
4. **Auth-state manifests (T0a).** The manifest schema (`app/auth-states/store.ts`) gains the optional `source_template_id` that §5.4 reads, written by an unsealed `state_export` into the exporting principal's own namespace (the flat layout for `local`, `p/<id>/` for every other principal, 02 §6); the move-on-first-access pass carries it unchanged. Deleting saved logins from the dashboard is PR #70's, not this program's.
5. **Tool count.** 0.2.3 added no tool, so `list_templates` is still the 44th name (02 §3.14). If a tool lands on `main` before T1a (open PRs #68 and #70 may add one), `list_templates` is appended after it and every "44" in specs 01, 02, 06, 09, 12 and the README moves with it; the first names keep their positions either way.

**T0b. The interception chain and a method-aware request guard.** *Scope*: the `InterceptionChain` type of §3.8 (one route per context, ordered in-process handlers, installed only when a blocklist is configured until T1a adds template hosts); the blocklist becomes its first handler with byte-identical behaviour; `RequestGuard` (pure matcher over `{methods, url glob, resource_types, action}` rules, resource types as §9.2) as the next handler, with per-request owner resolution (`resolveOwner(request)`: the fixed session for exclusive hosts), `route.fallback()` hand-off, fail-closed blocking and fail-open observation, and its hit sink as an in-memory port (the `site_guard_hits` table and writer arrive in T3a). No rules are configured outside tests. *Acceptance*: an exclusive session without a blocklist installs no route (its HTTP cache stays on); with a blocklist, the blocklist suite passes unchanged; with a test rule, a `POST` form logout, a `fetch` `POST`, a `sendBeacon` (`ping`) and a `GET` document are each matched or not by method and resource type; a handler exception aborts documents. *Tests*: matcher table tests; `blocklist-route` regression tests; an integration test against the fixture server with form, `fetch` and beacon posts. *Docs*: spec 11 §5 note.

**T0c. `BrowserHost` / `SessionView` split, no behaviour change.** *Scope*: §3.13; `PlaywrightSessionHandle` becomes an exclusive host plus its one view; every reach-in of the §3.13 table moves; the page-attribution dispatcher exists with one view per host; the dependency-cruiser rule "no `interface/` module imports `BrowserContext`". *Acceptance*: every existing unit, integration and end-to-end suite passes **with no assertion changed** (the fakes change: `FakeSessionHandle` becomes `FakeSessionView` over `FakeBrowserHost`, touching `packages/core/test/helpers/fake-session-handle.ts`, `tool-fakes.ts`, `fake-browser-driver.ts` and the tool tests that build them); `isolation.test.ts` passes on the three OSes. *Tests*: the attribution property suite on a fake host model (operations: open view, new tab via claim, `window.open`, `noopener` popup, `target=_blank` from a popup window, opener closes before adoption, service-worker window, operator Ctrl+T in an agent window, restored page, close tab, close view, renderer crash spanning views, host crash; invariants of §3.4). *Docs*: `docs/contributing/architecture.md`.

### T1a — Templates core

*Scope*: §2 without checkpoints, versions and keys (the full v9 migration, the template store, the identity split); §3.1–§3.8, §3.10, §3.11 (host with preferences and sandbox, supervisor with crash, idle, age recycle, operator stop and stale processes, windows created in the background, attribution with N views, close, crash fan-out, pipeline with `TemplateAdmission` and the launch budget, the chain with the self-origin guard, flags, displays); §4; §5 (`list_templates`, `launch_session.template`, option rules, sealing with redaction, tracing off, the tool table, the vault refusal, clipboard chords, screenshot fallback); §6 (access with `access-rule.ts`, default access, maintenance exclusion, scopes `templates:*`, capacity with the per-session page cap); §7.1 steps 1–5 through the CLI and REST only (learned cookies, unlisted sign-ins; Finish writes no version yet); §7.2 `create|finish|list|rm`; the follow-ups from the 0.2.3 fixes (T0 above); the T1a routes and codes of §11.1 and §12; the testing seam and HTTPS fixture sites (§14); `xvfb-run -a` in the Linux `integration` and `e2e` jobs (06).

*Acceptance*:
- Three agents launch from one template on fixture sites; each gets its own background window (on Xvfb, `xdotool getwindowfocus` is unchanged by each launch); `list_tabs` of each shows only its pages; a `target=_blank` link, a `window.open` popup and a popup whose opener closed first land in the opener's session; a tab opened from a popup window lands in the opener's session whatever window it appears in; a page opened with `context.newPage()` by test code (standing in for an operator's Ctrl+T) and a service-worker window are parked; `close_session` closes only that session's windows and the host survives; killing the host's browser fails all three with `SESSION_DEAD` and the host restarts; closing the sentinel by hand recreates it.
- Cookies set by a site in one session are visible to the others; `get_cookies` returns empty values, only the sites' cookies and `sealed: true`; `evaluate` answers `EVALUATE_DISABLED`; `set_cookies` and `save_storage_state` answer `SESSION_SEALED`; `vault_fill` answers `blocked`; a sentinel cookie value embedded in the page is `[sealed]` in `get_content`; unsealing each flag (for all principals, then for one) changes exactly that behaviour for exactly those sessions; `data:` and `javascript:` are refused.
- Any `launch_options` key and any `context_options` key other than the three per-session ones are refused with `INVALID_ARGUMENTS` naming each; the five defaulted parameters pass.
- The cap, both page caps and the host slot are enforced with the typed codes; an unauthorized principal or harness gets `TEMPLATE_NOT_FOUND` and does not see the template in `list_templates`; an agent cannot see or drive a maintenance session; under `auth=token`, creating a template without `authorized_principals` is refused.
- A recording on a headed Linux desktop and under Xvfb, with one pack-less site confirmed by **I'm signed in**, sets the template `ready` with learned cookie names; Finish lists an unlisted fixture domain and removes its sign-in; after a recording that submits a password form, no save prompt appeared and `Login Data` is empty.
- The identity seed and locale/timezone survive host restarts and a changed `TZ`; the observed identity is recorded at the first start.
- Background tabs and windows report `visible` and take screenshots; the measured sequence that stalled a minimized window (popup, dialog, download, then a screenshot) returns a screenshot through the fallback within 15 s; the live view streams.
- Manual, recorded in the PR: a person completes the Google sign-in in a host (stealth `standard` and `max`; `chromium` and `chrome`; Linux and macOS), or the result is documented and §7.4 is the stated path.

*Tests*: unit (template service, `TemplateAdmission` order, codes and budget, option table, access rule with D-48's `HARNESS_GATE_CASES`, redaction, clipboard chords, supervisor state machine with a fake clock and fake host including operator stop, the `v8.db → v9` migration with fixture and golden, including the operator-token rewrite of §2.5); contract goldens of the table above; HTTP route tests and the auth matrix; integration `templates-live.test.ts` (the acceptance list, real Chromium, headed under Xvfb on Linux CI, headless templates on macOS and Windows), `template-attribution.test.ts` (the property suite's scenarios against real Chromium), `template-sealing.test.ts` (the sealing invariant); Playwright e2e: create a template against the fixture sites with the CLI, sign in through the window, launch from an agent over MCP. *Docs*: `docs/guide/templates.md` (new: concepts, recording, agent usage, what agents can observe, displays, Xvfb and VNC, the HTTP-cache note), `docs/guide/security.md` (templates as credentials, sealing's scope, OS-user agents), `docs/guide/cli.md`, `docs/guide/configuration.md`, `docs/guide/mcp-clients.md` (`list_templates`), `docs/guide/quick-start.md` (templates in three steps), `docs/guide/programmatic-api.md` (templates; the testing seam is internal), `docs/guide/troubleshooting.md` (`no_display`, `host_failed`, identity drift), `docs/guide/faq.md`, `docs/README.md`.

### T1b — Template operations

*Scope*: §2.4 (envelope, key, rotation with `rekey` and `templateKeyPrevious`), §3.2 memory (the host sampler, `SESSION_RESOURCE_LIMIT`), §3.9 (checkpoint slot, carry-forward, size cap, versions and retention), §3.12 (restore as an operation), §7.4 (seed), the remaining T1b routes of §11.1, the `templates` WS topic, the CLI commands of §11.5 except `login`/`probe`, `doctor` (§11.9 without `site packs`), purge and init (§11.10), metrics and spans of §11.7 for T1b, audit (§11.8).

*Acceptance*: a recording's Finish writes version 1, encrypted (the file contains no cookie name in clear text; it decrypts only with the key, the header and the AAD; a swapped file or altered header fails); the checkpoint slot is rewritten every interval and carries origins forward across a host restart (a localStorage-based sign-in survives restart, checkpoint and restore); rolling cookies produce no new versions; a sign-in cookie that disappears produces a `signin_change` version; "Last good" survives retention; restore runs as an operation, closes or waits for sessions as chosen and leaves no plaintext file on disk; seeding from a storage-state file makes the template `ready`; a missing key with existing files records `TEMPLATE_KEY_MISSING` and the host still runs; `rekey` re-encrypts every file and is repeatable; a host above `templateRecycleRss` warns its largest session before draining; `doctor` reports each new check; `purge` warns about orphaned template directories.

*Tests*: envelope unit tests (tampered tag, AAD, header and key id); checkpoint carry-forward and structure hashing; version reasons and retention with a fake clock; key-file creation race (`O_EXCL`); `rekey` interrupted and repeated; restore and seed operations; route tests, auth matrix, WS golden; integration `template-versions.test.ts`. *Docs*: `docs/guide/templates.md` (versions, restore, seeding, backups and keys, rotation), `docs/guide/security.md` (encryption scope per platform), `docs/guide/cli.md`, `docs/guide/configuration.md`, `docs/guide/troubleshooting.md` (key mismatch, missing key).

### T1c — Templates dashboard

*Scope*: §11.4 for templates (list, wizard, template page, confirmations, vocabulary, "Not enabled" state, session page badges, `/system` browsers), with the pack catalog showing domains only until T3a. *Acceptance*: the wizard creates and records a template against the fixture sites; every tab of the template page works over REST and the `templates` topic; the remote-operator banner appears for a non-local client; 04's quality bar (390, 1024, 1440, 1920 px, both themes, keyboard walk, axe) in a real Chrome. *Tests*: component tests with axe for the list, wizard and template page; Playwright e2e: wizard → sign in → Finish → agent launch. *Docs*: `docs/guide/dashboard.md`; `lib/links.ts` entries and website redirects for any short URL the CLI hints print.

### T2 — Health, notifications, re-login

*Scope*: §8 for every site as a generic site (cookie pre-check with learned names; navigation probes and `challenged` arrive with T3a), the pre-launch check (single-flight, after the host is running), the schedule (including starting stopped hosts), re-login by window (queued act button, **Show window**), attention (origin warning) and vault auto-relogin (as `template:<id>`, `PUT …/relogin` with `templates:login` and `vault:write`), notifications and the `template.relogin` act op, digests, version health; the T2 rows of §11 and §12. *Acceptance*: against fixture sites, deleting a learned sign-in cookie produces `signed_out`, a partial set `inconclusive`, all present `signed_in`; a sign-out produces exactly one `template.signed_out` per identity provider that resolves itself after a re-login; the act button from a test channel queues and **Show window** opens it; an auto-relogin fills once through every vault gate, writes one `vault_access` row on its maintenance session with `trigger: 'auto_relogin'`, is refused for a binding that does not list `template:<id>`, and is not retried within 24 h; `TEMPLATE_NEEDS_LOGIN` only when every site is out. *Tests*: probe classifier table tests; scheduler on a fake clock (jitter, sequencing, two-host limit, host start for a probe, single-flight pre-launch); producer tests for the new kinds (contract validation, thread revisions keyed by identity provider, redaction sentinel); the vault broker with a linked binding; integration `template-health.test.ts`; dashboard tests for the Sites and Versions tabs. *Docs*: `docs/guide/templates.md` (health, re-login, idle hosts starting for checks), `docs/guide/notifications.md` (new kinds), `docs/guide/vault.md` (auto-relogin and **Allow this template**).

### T3a — Site packs, local

*Scope*: §9.1–§9.3, §9.5, §9.6, §9.8–§9.10 (the schema in contracts and `refinePack()` in core; `SitePackSource` bundled and local (unsigned files; signed layouts and imports from T4b, with the verifier of T4a); `SitePackRegistry` with local overrides; guards in both paths with `DEFAULT_GUARDS`, write policies, confirmations as `security_intercept` with deadlines and bounds, the stdio rule; challenges with the visibility rule and `DEFAULT_CHALLENGES`; `stop`; navigation probes and the `challenged` outcome in §8.1; migration `0010` with the frozen v1 literals; the bundled packs with live-verified fields; the approval model of §9.6 (approval on first use with provenance, local files approved once per content hash with BrowserHive's copy, bundled versions from a later release pending with their field diff, Apply, Reject, Revert, Pin and Follow, `site_pack_state` and `site_pack_changes`); the Site packs page of §11.4 without the registry parts; `sitepacks list|show|diff|apply|reject|revert|pin|unpin|follow|approve-local|enable|disable|reload|import|verify` for bundled and unsigned packs); the T3a rows of §11 and §12. The classification chips arrive with T3b; until then diffs are shown unclassified. *Acceptance*: a LinkedIn-shaped fixture pack blocks a `GET` logout navigation (`URL_BLOCKED`), a form-`POST`, a `fetch` and a `sendBeacon` logout (network aborts with audit rows), and a click on a `<span>` inside a guarded button (`SITE_ACTION_BLOCKED`); a redirect `/go → 302 /logout` behaves as §3.8 documents; a write under `confirm` is held until approved on `/attention`, aborted on deny or at its deadline, and the session's next tool answers `SITE_OPERATOR_PENDING`; a second write while one is held is aborted; under `stdio` `confirm` blocks; a Cloudflare-style interstitial raises one `security_intercept`, holds the session's tools, permits takeover input and resumes after resolution; fixture pages with an invisible reCAPTCHA v3 anchor and a Turnstile badge raise nothing; an agent's own `navigate` to a challenge URL changes no health; `stop` holds the site until **Clear stop**; probes produce all four outcomes against redirecting, landmark, challenge and timing-out fixtures; every row of §9.10 is refused or inert; adding a site in the wizard shows the bundled pack's provenance, version and SHA-256 and records its approval; a simulated newer release lists its bundled version as pending and the template keeps the approved one until **Apply**, and **Revert** restores it; an unsigned local file is inactive until approved, an edited file shows "Changed since approval — review" with the diff while the approved content keeps applying, and `approve-local` with a stale hash is refused; the release notes of the T3a release and `docs/guide/upgrading.md` state that v10 cannot be downgraded without restoring the pre-upgrade backup, and the migration test proves an older binary refuses the upgraded database. Manual, recorded in each pack's `verified`: every shipped field confirmed against a live signed-in session. *Tests*: schema and refinement tables (every constraint and bound, the pseudo-class allow-list); the approval state machine (approval on first use with provenance, a newer bundled version pending until Apply, Reject, Revert, Pin, Follow defaults, local files approved per SHA-256 with the approved copy applying after an edit, `approve-local` with a stale hash refused); the malicious-pack corpus; request-guard and element-guard integration with the fixture server; challenge detection with fixture pages; the `v9.db → v10` migration with the `operator_requests` rebuild (data preserved, CHECK extended, `min_reader_version` 10, v1 DDL unchanged); `registry.test.ts` over `registry/packs/*.json`; dashboard tests for the catalog and pack pages. *Docs*: `docs/guide/site-packs.md` (new: purpose, what a pack contains, approval and provenance, write policies and the stance rule, challenges, local packs and their approval, what guards cannot see, verifying a pack), `docs/guide/templates.md`, `docs/guide/security.md`, `docs/guide/upgrading.md` (v10 cannot be downgraded without restoring the pre-upgrade backup), `docs/guide/stealth.md` (pinned identity per template).

### T3b — Strategies and classification

*Scope*: §9.4 (every behaviour and stealth strategy; `pace-writes` and pacing; `stealth-profile` checks at creation, site add and approval; `single-focus`; `webrtc-policy` with host restart; `device-bound-session` on responses), §9.7 (`classifyPackChange`, default deny, restrictive, revocation semantics for bundled and local sources), classification chips on pending versions and diffs, `GET /site-packs/strategies`. *Acceptance*: each strategy's observable effect on the fixture sites (`serialize-site` → `TEMPLATE_BUSY` `pace` after 30 s; `active-hours` → `retry_after_ms`; `launch-spacing` waits then refuses; `human-dwell` delays; `pace-writes` holds then aborts; `entry-warmup` loads the entry path with the chosen referrer; `single-focus` leaves one focused page per site; `webrtc-policy` restarts the host with the flag; `stealth-profile` refuses a template below the floor); the classifier per field including every default-deny path; a pending bundled version shows its classification; `sitePacks=false` disables every pack. *Tests*: classifier per field; each strategy with a fake clock; integration `site-pack-strategies.test.ts`; dashboard tests for the History tab and diffs. *Docs*: `docs/guide/site-packs.md` (strategies, classification, approvals), `docs/guide/stealth.md` (stealth strategies).

### T4a — Registry publishing

*Scope*: §10.1, §10.2, §10.7, §10.8: the `registry/` folder with the bundled packs, `scripts/registry-build.ts`, the `registry-check`, `registry-build` and `registry-sign` jobs (environment `registry-signing` restricted to `main`, owner review, no dependency install in the signing job), `registry-resign.yml`, `scripts/registry-keys.ts`, the website build and `_headers`, the pinned trust root and the core verifier, and `sitepacks verify` for signed layouts. *Acceptance*: a pull request changing a pack shows its classification in the job summary; a merge produces a signed registry on a preview deployment that `sitepacks verify` accepts with the test key and a release build refuses; tampering with the artefact between build and sign fails the sign job; workflow lint passes. *Tests*: the signing scripts' round trip; verifier unit tests; workflow lint. *Docs*: `docs/contributing/registry.md` (new: proposing a pack change, review, key operations).

### T4b — Registry client and the update experience

*Scope*: §10.3–§10.6, §10.9 (the automatic check of the signed index only, verification on download, the ETag rule, cache, Download & review and Download all, auto-update for followed registry candidates, follow-driven badges and `site_pack.update_pending`, revocation, import and export of signed layouts, `sitepacks check|download|export` and signed `import`, the release snapshot), D-55's disclosure in `doctor`, the wizard and `docs/guide/security.md`. *Acceptance*: against a local static server holding a signed test registry (through `testing.sitePacksTrustRoot`): the automatic check downloads only `keys.json`, `index.json` and their signatures (asserted by the server's request log), with or without templates; a newer version appears as Available with its notes for followed packs only; **Download & review** fetches exactly that file, verifies it and shows the classified diff; **Apply** makes it approved and **Revert** restores the previous one; with auto-update on, a tightening candidate of a followed pack is downloaded and applied and a loosening one waits; **Download all** fetches every missing listed version; an expired index, a rolled-back index, a fast-forwarded index, an index from an online key past `not_after`, an index issued in the future, a wrong online key, a swapped pack file, an oversized file and an unknown key are each refused with the state unchanged; a revoked version with a looser fallback stays in force and opens a decision; `304` costs no download; an ETag that is not the body's hash is never echoed; requests carry no cookie, query or version; with `sitePacksUpdateCheck=false` no request is made (asserted by a server that fails the test on any request); `sitepacks export` then `import` on an offline host yields the same candidates; a signed layout dropped into `sitePacksDir` is queued like an import. *Tests*: unit tests for every verification step and the floors; `registry-client.test.ts` against a `Bun.serve` fake registry; dashboard tests for the Updates tab with axe; a Playwright path banner → Updates → Approve. *Docs*: `docs/guide/site-packs.md` (updates, approval, air-gapped use, mirrors), `docs/guide/security.md` (outbound request, trust chain).

### T5 — Later

The deferred items of §16, each as its own spec change and PR series.

---

## 18. Decided by the owner (2026-11-08)

The questions this spec raised were answered by the owner on 2026-11-08; the spec implements the answers:

1. **Schema v10 is accepted as incompatible** (§9.9): downgrading below the T3a release needs the pre-upgrade backup; the release notes and `docs/guide/upgrading.md` say so (T3a acceptance).
2. **Agents learn what they can and cannot do, never how templates work or that other sessions exist** (§5): no shared-browser wording, no session counts, no `mode`, capacity errors without other sessions.
3. **Every bundled pack version needs an operator's approval** (§9.6): adding a site approves the version shown with its provenance; later bundled versions wait as pending updates.
4. **The update check is automatic and on by default, and downloads only the signed index**; downloading and applying a pack version need the operator (Download & review, Apply, Revert), auto-update stays off by default, and a per-pack **Follow updates** setting (automatic: followed while a template uses the pack) limits pending updates and notifications (§10.4, §10.6, §11.4).
5. **Unsigned local packs need no signature but an operator's approval once per content hash**; a changed file waits for approval again while the approved content keeps applying (§9.6, §10.5).
