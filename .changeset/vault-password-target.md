---
"browserhive": patch
---

`vault_fill` now types the password only into a password input. Before the credential is fetched, and again immediately before each value is typed, `password_selector` must match exactly one visible, enabled, writable `<input type="password">`, and `username_selector` exactly one text input (not a password, hidden, file, checkbox, radio or button input). Otherwise the fill returns `blocked` with the new reason `password_target_invalid`, nothing is fetched from the vault, and the Vault log records which field was wrong and why. Previously an agent could point `password_selector` at a search box or another visible field and read the password back with `snapshot` or `screenshot`.

Behaviour change: a fill whose selectors match a `textarea`, a `contenteditable` element, several elements, or a field that is not on the page yet is now refused instead of attempted. Wait for the login form before calling `vault_fill`. A site's own "show password" control can still reveal a filled password; `require_no_evaluate`, `redact_username` and `dashboard_confirm` remain the per-entry hardening.
