---
"browserhive": patch
---

Operator API tokens issued with `scopes` are now limited to those scopes. Before, any token owned by an operator could call every route whatever scopes it was issued with, so a read-only monitoring token could also terminate sessions, change vault policy or issue new tokens.

- A token issued with `POST /auth/tokens {owner_kind: "operator", scopes: [...]}` gets 403 `FORBIDDEN` on routes, WebSocket commands and topics outside its scopes, and on `/mcp` unless it holds `mcp:tools`. `GET /auth/me` shows the scopes it holds.
- Managing tokens, grants, dashboard sessions and the password needs the whole operator: the dashboard, or an operator token that holds every scope. A narrowed token cannot issue a wider one.
- Nothing changes for the dashboard, agent tokens, or operator tokens issued without `scopes`: those hold every operator scope, now including scopes added by later releases. The database moves to schema v8 (compatible, data only): it marks operator tokens issued before this release with the full scope list of their release as "every scope", so a token from 0.1.x also keeps the channel scopes added in 0.2.0.
