---
'browserhive': patch
---

`save_full_profile` no longer freezes the server while it zips a large profile, and restoring with `restore_profile` no longer loads the whole archive into memory (#58). Both now stream the profile in small slices, so other sessions, MCP clients and the dashboard keep responding. On a 160 MB profile, the longest pause dropped from about 6 seconds to under 20 ms, and memory growth dropped from about 600 MB to under 30 MB.

Behaviour changes:

- Full-profile snapshots now leave out the browser's regenerable caches (`Cache`, `Code Cache`, `GPUCache`, shader and Dawn caches, `component_crx_cache`, and the service worker's `CacheStorage` and `ScriptCache`). Logins are not affected: cookies, local storage, IndexedDB, session storage, saved passwords and preferences are kept. Snapshots are much smaller as a result, and a restored session starts with a cold cache.
- A snapshot is written to a temporary file and renamed into place when it is complete. A save that fails no longer leaves a partial archive and no longer replaces the previous snapshot of that name.
- Restored profile files are created owner-only (0600), and each file is checked against its CRC, so a damaged archive fails the launch instead of restoring corrupt data.

Snapshots saved by earlier versions restore unchanged.
