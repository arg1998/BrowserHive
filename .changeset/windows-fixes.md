---
"browserhive": patch
---

Windows fixes: a clean stop from the console, the Bitwarden vault, full-profile saves, and browser memory metrics.

- **Ctrl+Break and closing the console window stop BrowserHive cleanly** on Windows (sessions closed, database flushed), like Ctrl+C. Before, both ended the process at once.
- **The database file is released as soon as BrowserHive stops**, including after a failed start (for example a port already in use). On Windows the data directory used to stay locked until the process exited.
- **The Bitwarden vault works on Windows.** `bw` now gets the locations it needs there (`APPDATA`, where it keeps its login, plus `LOCALAPPDATA`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP` and `PATHEXT`), and on every platform `BITWARDENCLI_APPDATA_DIR` when you set it. Still no credentials in its environment besides `BW_SESSION`.
- **`save_full_profile` on a live session** skips the lock files a running browser holds and the temporary files it deletes while the snapshot is taken, instead of failing with `INTERNAL_ERROR`. On Windows, where a running browser locks its cookie database, it fails with the new `PROFILE_FILE_LOCKED` error naming the file and pointing to `save_storage_state`, instead of `INTERNAL_ERROR`.
- **`browserhive.browser.rss_bytes` reports on Windows too** (the working set of each session's browser and all its processes, every 10 seconds).
- **Session, trace and profile folders are removed reliably on Windows**, waiting out the moment a just-closed browser still holds its files.
