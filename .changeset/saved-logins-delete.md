---
"browserhive": minor
---

Saved logins can now be deleted.

- **For agents:** a new MCP tool, `delete_saved_auth {name}`, deletes one of the caller's own saved logins of either kind, together with its identity seed. A name the caller has not saved answers `AUTH_STATE_NOT_FOUND`, whether it does not exist or belongs to another principal. The catalog grows to 44 tools; existing tools are unchanged.
- **Dashboard:** a new **Saved logins** page, in the sidebar next to Vault, lists every principal's saved logins with these columns:
  - kind (Cookies & storage, or Full profile);
  - owner;
  - size;
  - when it was saved;
  - the session it came from, linked while that session still exists.

  Deleting one asks first, naming the login and its owner. The page updates live.
- **REST:** `GET /api/v1/auth-states` (`sessions:read`) lists them. `DELETE /api/v1/auth-states/{owner}/{name}` (`sessions:write`) deletes one, writes an operator audit row, and answers 404 when it does not exist. The WebSocket gains an `auth-states` topic.
- **CLI:** `browserhive saved-logins list` and `browserhive saved-logins rm <name> [--owner <subject>]` work against a running server, like `channels`.

Sessions already restored from a deleted login keep running. BrowserHive still never expires saved logins by itself. Fixes #57.
