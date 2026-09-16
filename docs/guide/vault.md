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

BrowserHive runs `bw` with a minimal environment (`PATH`, `HOME`, `BW_SESSION`), passes entry names after `--` so they can never be read as options, and applies a timeout to every call.

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

Use **origin tester** on the Vault page to check which entries would fill on a given URL for a given session slug.

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

Failures are returned, not thrown:

| `status` | `reason` examples |
|---|---|
| `blocked` | `vault_disabled`, `not_authorized`, `evaluate_required_off`, `dashboard_denied`, `confirm_timeout`, `form_action_mismatch` |
| `origin_mismatch` | the page is not on an allowed origin |
| `auth_failed` | `entry_not_found`, `backend_error`, `fill_failed`, `submit_failed` |

Only [`VAULT_NOT_CONFIGURED`](../reference/errors.md#VAULT_NOT_CONFIGURED) and [`VAULT_LOCKED`](../reference/errors.md#VAULT_LOCKED) are raised as errors. `clear_after_fill` defaults to `false`: the credential stays in the form unless the page navigates away.

## 6. Confirmations

For entries with `dashboard_confirm`, the fill blocks until an operator decides. The request appears on the Vault page, on the session's page and as a notification, with the session, target URL and requesting tool. **Approve** lets the fill continue; **Deny** returns `blocked` / `dashboard_denied` to the agent. A deny reason is written to the audit log only, never sent to the agent.

A confirmation that nobody answers within `--attentionTimeout` (default 6 h) is denied with `confirm_timeout`. Closing the session or disconnecting the agent cancels it. Under `--transport stdio` there is no dashboard, so these entries are always denied.

## 7. Audit

Every fill and every rejected listing writes one row to the **Vault log**: time, entry, result, origin check, whether `evaluate` was enabled, session, page URL and the reason. It never contains credentials.

## Hardening checklist

- Prefer `manual` folders and narrow origins.
- Use `require_no_evaluate` for sensitive entries, or run with `--allowEvaluate false`.
- Use `clear_after_fill: true` in your agent's prompts.
- Use `dashboard_confirm` for anything that moves money.
- Remember that the live view and screenshots show raw pixels.
