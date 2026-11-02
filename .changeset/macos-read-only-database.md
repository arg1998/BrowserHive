---
"browserhive": patch
---

On macOS, read-only commands now work on a database that was just restored or copied.

- **`admin tokens list`, `db status`, `db backup`, `purge` and `doctor` no longer fail with `DB_OPEN_FAILED`** ("unable to open database file") on macOS when the database has no `-wal`/`-shm` files beside it, as after `browserhive db restore` or after copying the database. macOS's own SQLite cannot create those files from a read-only connection; BrowserHive now opens such a file without the read-only flag while still refusing every write, and never migrates it.
