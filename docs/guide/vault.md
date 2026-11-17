# Vault: logins the model never sees

The vault lets an agent log in to websites without ever handling the password. The agent names an entry and the form fields; BrowserHive fetches the credential from your password manager, checks that it is allowed on this page, types it, and returns only a status. Bitwarden is the supported backend.

Read [the security model](security.md#the-vault-credentials-the-model-never-sees) for the full list of gates and limits.

## 1. Set up Bitwarden

Install the [Bitwarden CLI](https://bitwarden.com/help/cli/) so `bw` is on `PATH`, then log in once:

```bash
bw login
```

For a self-hosted server, run `bw config server https://vault.example.com` first. BrowserHive never asks for your master password: you unlock `bw` yourself and give BrowserHive only the session token.

## 2. Start BrowserHive with the vault

```bash
browserhive --admin --vault bitwarden
```

The vault works without `--admin`, but then you cannot unlock, bind entries or approve confirmations from the dashboard. `browserhive doctor` checks that `bw` is on `PATH`.

## 3. Unlock

The vault starts locked unless a session token is already available. First create a session token in your own terminal (as the same user that runs BrowserHive, so `bw` finds the same login):

```bash
bw unlock --raw
```

`bw` asks for your master password and prints the token. Then either:

- **Dashboard → Vault → Unlock:** paste the token into **Session token**. BrowserHive checks it with `bw status` and keeps it in memory only.
- Export it before starting the server: `export BW_SESSION="$(bw unlock --raw)"`, then `browserhive --admin --vault bitwarden`.

If unlock fails with [`VAULT_UNLOCK_FAILED`](../reference/errors.md#VAULT_UNLOCK_FAILED), the token has expired or belongs to another login (for example after `bw lock` or `bw logout`). Run `bw unlock --raw` again and paste the new token.

**Lock** discards the token. **Sync** pulls changes from the Bitwarden server. While the vault is locked, `vault_fill` fails with [`VAULT_LOCKED`](../reference/errors.md#VAULT_LOCKED), which tells the agent to wait for an operator.

BrowserHive runs `bw` with a minimal environment (`PATH`, `HOME`, `BW_SESSION`, and `BITWARDENCLI_APPDATA_DIR` when set; on Windows also `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP` and `PATHEXT`, because the CLI keeps its login under `%APPDATA%` there), passes entry names after `--` so they can never be read as options, and applies a timeout to every call.

## 4. Decide what agents may use

Nothing is fillable until you allow it. There are two levels, both on the dashboard's Vault page.

### Folder policies

Each Bitwarden folder (plus "no folder") has an access mode:

| Mode | Effect |
|---|---|
| `manual` (default) | Only entries with an explicit binding are fillable. |
| `allow_all` | Every entry in the folder with at least one login URI is fillable. Its allowed origins are the hostnames of its URIs. |
| `reject_all` | Nothing in the folder is fillable, even with a binding. |

An `allow_all` policy also sets who may use it (all sessions, or session slug globs such as `shop-*`) and folder-wide flags (below). If two entries in an `allow_all` folder have the same name, neither is fillable until you rename one or bind it manually.

### Bindings

A binding makes one entry fillable under a stable **handle** (for example `work.github`), which is the `entry_name` agents pass. Each binding has:

| Field | Meaning |
|---|---|
| Allowed origins | Where the credential may be typed. `github.com` matches that hostname; `*.example.com` matches `example.com` and every subdomain, compared on the registrable domain; `example.com/login*` restricts the path. Ports are ignored. |
| Authorized sessions | Session slug globs (`shop-*`), or all sessions. |
| Authorized principals | With `--auth token`, which agent tokens may use it; empty means any. Both the slug and the principal must match. |
| `dashboard_confirm` | Every fill waits for an operator to approve it on the dashboard. |
| `require_no_evaluate` | The fill is refused unless `evaluate` is disabled for the session. |
| `redact_username` | The username is redacted from tool results too, not only the password. |
| Harnesses | Which agent harnesses may use it; all by default. See [Harness restrictions](#harness-restrictions). |

### Harness restrictions

A binding or a folder policy can also name the **harnesses** that may use it: the agent client connected over MCP, such as Claude Code, OpenCode, Codex or Cursor. BrowserHive recognises many of them on its own and shows the harness on every session ([how harnesses are recognised](mcp-clients.md#harness-identity)).

For example, to let only your coding agents use the deployment credentials, open the **Deploy** folder on the Vault page and, under **Harnesses**, choose **OpenCode** and **Claude Code**. A fill from a session launched by any other harness, or by a client BrowserHive could not identify, is then refused, even when the principal and slug rules allow it.

How the list works:

- **All harnesses** (the default) is the same as no list: nothing changes.
- A list allows only the harnesses it names. **Unknown** stands for sessions whose client could not be identified; leave it out to refuse them.
- An **empty list allows nothing**. The editor warns you when you untick the last harness.
- **Custom names** (**+ Add custom name**) are for harnesses BrowserHive does not know. They are **case-sensitive** and must equal the name the client declares: the `X-BH-Agent-Harness` header, the `BROWSERHIVE_HARNESS` variable, `?harness=` on the URL or `_meta['ai.browserhive/harness']`. The editor offers the names it has seen declared on this daemon, and warns when a custom name looks like a built-in harness (`Claude-Code` only matches a client that declares exactly `Claude-Code`; the built-in **Claude Code** matches however it was recognised).
- A folder's list applies to every entry in the folder, including its bindings. When both the binding and its folder have a list, both must allow the harness.
- The harness is the one the session was **launched** with. A client that changes its declared name halfway through a session is still judged by the name it launched with. Sessions from before this feature have no declared name, so only built-in harnesses and **Unknown** can match them.

The agent sees a harness refusal exactly like any other: `vault_fill` returns `blocked` / `not_authorized`, and `vault_list_available` leaves the entry out. Only the [Vault log](#7-audit) records the real reason, `harness_not_allowed`, with the session's harness and declared name.

> **What this does and does not protect against.** The harness name is reported by the client, and any client can claim any name. A harness list prevents mistakes, such as the wrong agent picking up the wrong credentials; it does not stop a client that lies. For a real boundary, give each agent its own API token (`browserhive admin tokens create <name>`, see [authentication tokens](mcp-clients.md#authentication-tokens)) and list its principal under **Authorized principals**. The editor reminds you when every recent session shares one principal.

The `harnesses` field is part of the binding and policy JSON (`null` or missing means all harnesses, `[]` none) and round-trips through **Export** and **Import**.

Use the **Tester** tab on the Vault page to check which entries would fill on a given URL, for a given session slug and harness. It runs the same checks as a real fill, in the same order, and tells you which one refused. To check a harness list, pick a **Harness** (or **Unknown**), and add the **Declared name** when a custom name is involved; a declared name on its own is read the way a client's declaration would be. With no harness picked, harness lists are not checked, and the tester says which bindings have one.

Bindings and policies are stored in the database. **Export** and **Import** (merge or replace) move them as JSON, for backups or editing by hand. Edits use optimistic concurrency: if someone else changed a binding since you loaded it, saving returns [`CONFLICT`](../reference/errors.md#CONFLICT) and the dashboard reloads it.

## 5. What the agent does

List the entries usable on the current page. Passing the domain the agent believes it is on lets BrowserHive catch a page that is not what the agent thinks:

```jsonc
vault_list_available({ "session_id": "shop-a1b2c3d4", "url": "github.com" })
// → { "entries": [{ "entry_name": "work.github", "allowed_origins": ["github.com"], "redact_username": false, "require_no_evaluate": false }],
//     "scope": "page", "scoped_to": "github.com" }
```

The listing never reveals which entries require confirmation or which sessions are authorized. If the declared domain does not match the real page, the result is empty with `scope: "rejected"`, and the attempt is audited.

Fill:

```jsonc
vault_fill({
  "session_id": "shop-a1b2c3d4",
  "entry_name": "work.github",
  "username_selector": "#login_field",
  "password_selector": "#password",
  "submit_selector": "input[type=submit]",
  "clear_after_fill": true
})
// → { "status": "success", "redacted": true }
```

The selectors must name the real login fields, because the password is typed only into a password input:

- `password_selector` must match exactly one `<input type="password">` that is visible, enabled and not read-only;
- `username_selector` must match exactly one `<input>` that takes text: not a `password`, `hidden`, `file`, `checkbox`, `radio`, `submit`, `button`, `image` or `reset` input. It is checked only when the entry has a username to type.

A `textarea`, a `contenteditable` element, a search box as the password field, or a selector that matches several elements is refused with `blocked` / `password_target_invalid`, before the credential is fetched from the backend. The check runs again immediately before each value is typed, so a page that swaps the field after the first check is refused too.

Before the check, `vault_fill` waits up to 30 seconds for the password field to become visible, so a login form that a single-page app renders after the page loads still fills. A password field that never becomes visible (missing, or hidden) returns `auth_failed` / `fill_failed`, as earlier versions did after their 30-second fill timeout; nothing is fetched from the vault.

Failures are returned, not thrown:

| `status` | `reason` examples |
|---|---|
| `blocked` | `vault_disabled`, `not_authorized`, `evaluate_required_off`, `password_target_invalid`, `dashboard_denied`, `confirm_timeout`, `form_action_mismatch` |
| `origin_mismatch` | the page is not on an allowed origin |
| `auth_failed` | `entry_not_found`, `backend_error`, `fill_failed`, `submit_failed` |

Only [`VAULT_NOT_CONFIGURED`](../reference/errors.md#VAULT_NOT_CONFIGURED) and [`VAULT_LOCKED`](../reference/errors.md#VAULT_LOCKED) are raised as errors. `clear_after_fill` defaults to `false`: the credential stays in the form unless the page navigates away.

## 6. Confirmations

For entries with `dashboard_confirm`, the fill blocks until an operator decides. The request appears on the Vault page, on the session's page and as a notification, with the session, target URL and requesting tool. **Approve** lets the fill continue; **Deny** returns `blocked` / `dashboard_denied` to the agent. A deny reason is written to the audit log only, never sent to the agent.

A confirmation that nobody answers within `--attentionTimeout` (default 6 h) is denied with `confirm_timeout`. Closing the session or disconnecting the agent cancels it. Under `--transport stdio` there is no dashboard, so these entries are always denied.

## 7. Audit

Every fill and every rejected listing writes one row to the **Vault log**: time, entry, result, origin check, whether `evaluate` was enabled, session, page URL and the reason. A fill refused by a harness list says `harness_not_allowed`, with the session's harness, its declared name and whether the binding or the folder refused it. A fill refused with `password_target_invalid` records which field (`username` or `password`), what was wrong (`not_password_input`, `not_text_input`, `multiple_matches`, `no_match`, `hidden`, `disabled`, `readonly`, or `unverifiable` when the page could not be inspected) and whether it was caught before the fetch (`pre_fetch`) or just before typing (`pre_fill`). It never contains credentials.

## Signing template sites in again

Agents cannot use the vault in [session template](templates.md) sessions: a fill there would sign in every session of the template. BrowserHive itself can, though: when a template's site is signed out, it can fill a vault login into the site's sign-in page in a background window of the template's browser, on the machine running BrowserHive. This is **auto-relogin** ([the other ways to sign in again](templates.md#signing-in-again)). It suits sites with a plain username-and-password form; a site that asks for a code or a security key needs you in a [window](templates.md#in-a-window).

### Link a login to a site

On the template page, link a binding to the site, or call:

```bash
curl -X PUT http://127.0.0.1:9876/api/v1/templates/tp-…/sites/linkedin.com/relogin \
  -H "Authorization: Bearer $BH_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"vault_handle":"work.linkedin","auto_relogin":true,"allow_template":true,
       "form":{"path":"/login","username":"#username","password":"#password","submit":"button[type=submit]"}}'
```

It needs the scopes `templates:login` and `vault:write`.

| Field | Meaning |
|---|---|
| `vault_handle` | The binding's handle. `null` unlinks the login and turns auto-relogin off. |
| `auto_relogin` | Sign the site in again by itself when a check finds it signed out. Off: only when you ask, from the template page or with `browserhive templates login <name> --site <site> --method vault`. |
| `form` | Where the sign-in form is. Until site packs describe sites, a template site needs it: `path` (the sign-in page on the site, default `/`), `username` and `password` (CSS selectors), `submit` (the sign-in button) and `next` (the button between the username and password steps of a two-step form). |
| `allow_template` | **Allow this template**: adds `template:<template_id>` to the binding's authorized principals, nothing else. This **widens who can use the credential** (to BrowserHive's own sign-in sessions of that template, never an agent's), so the dashboard asks first. |

The answer says whether the binding lets the template fill (`binding_allows_template`) and, when it does not, why (`binding_problems`): `binding_not_found`, `principals_open`, `principal_not_listed` or `harness_list`.

### The same rules as any fill

Linking a login does not authorize anything by itself. The fill runs as the principal `template:<template_id>`, in a BrowserHive session of the template (slug `relogin`) with no harness, through every rule of a [binding](#bindings):

- **The principal must be listed by name.** A binding whose authorized principals are empty (any principal) does not count (`principals_open`): list `template:<template_id>`, which **Allow this template** does.
- **The session.** A binding's session rule (slug globs or all sessions) is met by the template's own re-login session: BrowserHive keys it on the session being a maintenance session of that template, never on its slug, so no agent session named `relogin` gains anything. `template:<template_id>` is a reserved subject: no token can be it.
- **No harness list.** A template fill has no harness, so a binding (or its folder) with a [harness list](#harness-restrictions) refuses it.
- **Origins and fields.** The sign-in page must be on the binding's allowed origins, and the password goes only into a password input ([what the agent does](#5-what-the-agent-does)).
- **Confirmation.** With `dashboard_confirm`, the fill waits for you to approve it like any [confirmation](#6-confirmations).

A refusal fails the re-login with the reason (for example `not_authorized`) on the template page and as a `template.relogin_failed` [notification](notifications.md#template-sign-ins).

### When it runs

- With `auto_relogin` on, a check that finds the site signed out starts one fill. A "couldn't tell" result never does.
- **One attempt per sign-out.** If the site is signed out again within 24 hours of an automatic attempt, BrowserHive does not try again: it sends `template.relogin_failed` and leaves the site to you, because signing in again and again is how accounts get locked.
- On success, the site is checked, a `relogin` version is saved and the sign-out notification resolves.

### What is recorded

Each fill writes one row to the [Vault log](#7-audit), on the re-login's own BrowserHive session (owned by the template's owner), with `trigger: auto_relogin` and the principal that linked the binding. Like every row, it never contains the credential.

## Hardening checklist

- Prefer `manual` folders and narrow origins.
- Use `require_no_evaluate` for sensitive entries, or run with `--allowEvaluate false`.
- Use `clear_after_fill: true` in your agent's prompts.
- Use `dashboard_confirm` for anything that moves money.
- Know the remaining limit of the password-input rule: a site's own "show password" control turns the filled field into plain text, and an agent can click it and read the password back with `snapshot` or `screenshot`. For entries where that matters, set `redact_username` and `require_no_evaluate`, and use `dashboard_confirm`.
- Give each agent its own token and authorize principals; use harness lists on top, to keep agents away from credentials that are not theirs.
- Remember that the live view and screenshots show raw pixels.
