---
"browserhive": patch
---

`vault_fill` now types the password only into a password input. Before the credential is fetched, and again immediately before each value is typed, `password_selector` must match exactly one visible, enabled, writable `<input type="password">`, and `username_selector` exactly one text input (not a password, hidden, file, checkbox, radio or button input). Otherwise the fill returns `blocked` with the new reason `password_target_invalid`, nothing is fetched from the vault, and the Vault log records which field was wrong and why. Previously an agent could point `password_selector` at a search box or another visible field and read the password back with `snapshot` or `screenshot`.

Behaviour change: a fill whose selectors match a `textarea`, a `contenteditable` element or several elements is now refused instead of attempted. As before, `vault_fill` waits up to 30 seconds for the password field to appear, so login forms rendered after the page loads still fill. A password field that never appears still returns `auth_failed` / `fill_failed`, but now nothing is fetched from the vault first. A site's own "show password" control can still reveal a filled password; `require_no_evaluate`, `redact_username` and `dashboard_confirm` remain the per-entry hardening.
