---
"browserhive": minor
---

Notifications now follow what they announce, and the groundwork for sending them to your phone is in place.

- **A notification keeps its place as things change.** When you resolve an attention request or a vault confirmation, reject it, or it times out, its notification shows the outcome (**resolved**, **expired**) as a small pill in the bell and on the Notifications page, instead of staying as if it were still waiting. A toast still on screen for it closes. A recovered subsystem marks its degradation notification resolved the same way.
- **Richer notification data in the API.** `GET /api/v1/notifications` and the `notifications` WebSocket topic add `kind`, `category`, `severity`, `state`, `revision` and `thread` to every notification. Existing fields are unchanged.
- **Safer text.** An agent's attention reason and other text copied into a notification now go through the same redaction as the logs, and page addresses lose their query strings.
- **Foundations for Telegram, Discord and ntfy.** Every notification is also a versioned message document, whose JSON Schema is published in the reference docs. Delivery to chat apps goes through a new outbox in the database, with retries and a circuit breaker, so nothing is lost when a service is down. No channel can be configured yet; with none configured nothing changes and nothing extra runs.
- The database upgrades on start (schema v5: new columns on notifications and three new tables; a backup is written first). Older releases can still open it. Existing notifications are classified from what they already recorded; nothing is invented for them.
