---
"browserhive": patch
---

Agent tokens can no longer be created under the names BrowserHive uses for its own principals: `local`, `browserhive`, `system`, and any name starting with `template:`. Letter case and extra spaces or punctuation do not matter (`Local`, `local `, `-system-` are refused); names that only contain one of them, such as `local-runner`, still work. Previously an agent token named "Local" acted as the `local` principal and owned every session created under `--auth off` and every saved login without an owner. `POST /auth/tokens`, `browserhive admin tokens create` and the dashboard now answer HTTP 400 `VALIDATION_FAILED` with `subject is reserved`, and the dashboard shows it under the name field.

Tokens that an earlier version created under a reserved name keep working: BrowserHive never revokes them for you. `browserhive doctor` has a new `reserved subjects` check, and the server logs `reserved subjects in use` once at startup. Both name each such token by credential id and prefix, and each `BROWSERHIVE_AUTH_TOKENS` entry with a reserved name. Revoke those tokens with `browserhive admin tokens revoke <credential id>` or on the dashboard, and create new ones under other names.
