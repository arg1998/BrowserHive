---
"browserhive": patch
---

OpenTelemetry now exports the notification, attention, session-launch, WebSocket, write-queue and browser-memory metrics the docs describe.

- **Metrics that were documented but never sent** now reach your collector: `browserhive.attention.wait`, `browserhive.session.launch.duration`, `browserhive.ws.connections`, `browserhive.ws.buffered_bytes`, `browserhive.ws.frames_dropped`, `browserhive.db.dropped_writes`, `browserhive.browser.rss_bytes` (each session's browser with all its processes, every 10 seconds; Linux and macOS) and `browserhive.process.event_loop_lag`.
- **Attributes the docs promised** are now set: `closed_reason` on `browserhive.session.lifetime`, `kind` on `browserhive.attention.open` (vault confirmations count too), `table` on `browserhive.retention.pruned_rows`.
- **The notification metrics** `browserhive.notifications.deliveries`, `.actions` and `.reports` are now in the [telemetry guide](https://browserhive.ai/docs/guide/telemetry). `.reports` now counts on-demand digests as `manual`, as documented, and no longer counts a silent revision of an open in-app anomaly alert.
- **Every metric has a unit** (`ms`, `By`, or a count such as `{call}`), and the guide's table lists each one with its type, unit and attributes. With telemetry off nothing is measured, as before.
