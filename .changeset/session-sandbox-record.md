---
"browserhive": minor
---

Closed sessions now keep showing whether they ran inside Chromium's sandbox, and with which browser version.

- **Recorded at launch.** When a session's browser starts, BrowserHive stores whether it runs sandboxed and the browser's real version with the session. Under the default `--sandbox auto` the answer depends on the browser and the machine (on Ubuntu, Google Chrome sandboxes and the bundled Chromium falls back), so it is recorded rather than worked out later.
- **In the dashboard.** A session's Details tab shows the browser version and a **sandboxed** / **not sandboxed** state for finished sessions too, not only while they run. Sessions from before this release show **not recorded**, with a note that this does not mean the sandbox was off; a session whose browser never started shows **not launched**.
- **In the API.** `browser: { version, sandboxed }` on `GET /api/v1/sessions` and `GET /api/v1/sessions/{id}` is now filled for closed sessions from what was recorded at launch. It is still left out when nothing was recorded, so read a missing `browser` as "unknown", never as "not sandboxed".
- The database upgrades on start (schema v4, two new columns, a backup is written first); older releases can still open it. Nothing is guessed for existing sessions.
