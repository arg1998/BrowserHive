---
"browserhive": minor
---

A daily summary and a heads-up when something's off.

- **Daily or weekly digest.** Give a channel a digest (every day, or every week on the day you pick, at the time you pick) and it gets the period in numbers: sessions, tool calls and errors with the rate, attention requests and how fast they were answered, vault fills, blocked requests, the slowest tool against the period before, the top errors, open problems, a small chart of tool calls per hour and a table per harness, with a link to the Overview for exactly that period. The new **Daily digest** preset sets it up in one click.
- **In your time zone.** Each channel has a time zone, BrowserHive's own unless you pick another, and digests and quiet hours follow it through daylight saving time.
- **Nothing lost, nothing spammed.** If BrowserHive was off when a digest was due, the most recent one arrives when it starts again, marked late, with how many earlier ones were skipped. A day with no activity sends nothing (the delivery log says so). A digest due in quiet hours arrives silently.
- **Tell me when something looks off.** An hourly check that stays silent until a threshold is crossed: many tool calls failing, a request waiting too long, sessions at the limit, a spike in blocked requests, BrowserHive degraded. The alert updates itself and says **Back to normal** when things recover, without flapping. Thresholds can be tuned per channel.
- **Send a digest now.** Preview the real digest exactly as your phone will show it, then send it on demand, from the channel card or `POST /api/v1/channels/{id}/digest`.
- **Setup and terminal.** Startup channels take `digest=daily@09:00` (or `weekly:mon@08:30`), `tz=` and `anomaly=on` with `anomaly.*` thresholds; `browserhive channels list` shows each channel's next digest, and `channels preview --sample digest|anomaly` renders the samples.
- **Also:** the Allow this person button explains when you lack `channels:write`, a deleted channel's reply-topic cursor goes with it, the live delivery log no longer shows stale superseded rows, and the public address check reports a proxy's 5xx page as unreachable. The message contract gains the `digest.weekly` kind, a `chart` block and an optional `report` field (schema 1, additive); no database migration.
