# Notifications

BrowserHive tells you when something needs you or went wrong: an agent asked for help, a vault fill waits for your approval, a session crashed, tools keep failing, or BrowserHive itself is degraded. Notifications are stored in the database, so they survive reloads and restarts, and they appear in the dashboard's bell, as toasts and on the **Notifications** page.

This page explains what produces a notification, how one changes over its life, and the delivery machinery that sends notifications to chat apps such as Telegram, Discord and ntfy. That delivery is being built in stages: this release lays the foundations, and the first channels arrive next.

## What BrowserHive notifies about

| What happened | Kind | Category | Severity |
|---|---|---|---|
| An agent called `request_attention` ([human takeover](attention.md)) | `attention.requested` | needs you | warn |
| A vault fill waits for your confirmation ([vault](vault.md)) | `vault.confirm` | needs you | warn |
| A session crashed | `session.crashed` | problems | error |
| A session was reaped because its lease expired | `session.reaped` | problems | warn |
| Tools failed (grouped per session: "shop · 12 tool errors") | `tool.errors` | problems | warn |
| A subsystem is degraded (for example the retention sweep failed) | `system.degraded` | system | error |
| A notification channel keeps failing | `channel.broken` | system | error |

Routine events are deliberately silent: a session opening, a page visit, a clean close. Agents cannot send notifications themselves: every notification comes from something BrowserHive observed. The `request_attention` tool is how an agent reaches you.

## A notification has a life

A notification keeps its identity while the thing it announces changes. When you resolve an attention request, reject it, or it times out, the same notification moves to **resolved** or **expired** instead of a second one appearing. The dashboard shows that outcome as a small pill on the row (**resolved**, **expired**, or **closed** when the agent stopped waiting) and closes the toast if it is still on screen. The row keeps its place in the list. A growing group of tool errors updates its count in place.

Every change is a new **revision** of the notification's message. Each revision is complete, so whoever shows it never has to merge changes. That is also what lets a chat message be edited in place later, silently: only a new notification makes noise.

Notifications from before this release keep working; they get the new fields, derived from what they already recorded, and nothing is invented for them.

## The message contract

Every notification is also a `NotificationMessage`: a small, versioned JSON document with a title and summary, structured blocks (text, facts, lists, tables, images, code), up to five buttons, and what it is about (session, tool, error code). Links in it are dashboard paths. BrowserHive owns this contract; every channel renders it and none reads BrowserHive's internals. The JSON Schema is published at [notification-message.schema.json](../reference/notification-message.schema.json), so you can build your own consumer from the generic webhook channel when it arrives.

Before a message is stored or sent, BrowserHive removes known secrets and credential-shaped text from every field and strips query strings from URLs, the same redaction the logs get ([security](security.md)). A channel can be set to carry less: only titles and facts, or only counts.

## How delivery to other apps works

Delivery is designed so that nothing is silently lost and nothing waits on a slow chat service:

- **An outbox in the database.** When a notification is created or changes, the jobs that deliver it to each channel are written in the same database transaction. A worker sends them afterwards. If BrowserHive stops mid-way, it picks up at the next start. This guarantees at-least-once delivery: an edit or a delete can safely be repeated, and in the rare case of a crash in the middle of sending a new message, that message can arrive twice.
- **Edits instead of spam.** When a notification changes, its chat message is edited in place, at most once every 3 seconds. Edits never make a sound.
- **Retries.** A failed send is retried with growing pauses, honouring the platform's "retry after". It gives up after 8 attempts or 24 hours.
- **A circuit breaker.** After 5 failures in a row, the channel is marked **broken**, you get an in-app notification about it, and its deliveries pause. A failing channel is never reported as a BrowserHive degradation: that report would be sent through the same failing channel.
- **Catching up.** After an outage only the latest state of each notification is sent, and a pile of routine updates collapses into one message that says how many you missed.
- **A log for every decision.** Each delivery is logged, including the ones a channel's rules filtered out and why, so "why didn't I get it?" always has an answer. The log is kept for 30 days.
- **Messages that clean up after themselves.** A channel can delete its messages after a time you choose per category, or once they are resolved. BrowserHive does the deleting, because no chat platform offers a timer for bot messages. The default is to keep everything.

Your own accounts, no servers: BrowserHive never runs a relay or a shared bot. You create your own Telegram bot, Discord webhook or ntfy topic, and every connection goes out from your machine. Tokens stay in environment variables; BrowserHive stores only the variable names, so a database backup never contains a token.

## Retention

Read or dismissed notifications are kept for 30 days, others for 90. Delivery history is kept for 30 days. Configured channels are never pruned; `browserhive purge` lists them with everything else in the database.

## Channels

Placeholder: the channel setup guides are written with the channels release.

### Telegram

Placeholder: create a bot with @BotFather and connect a chat.

### Discord

Placeholder: create a webhook in a channel's Integrations settings.

### ntfy

Placeholder: pick a server and a topic, then subscribe on your phone.

### Webhook

Placeholder: receive the notification contract, signed with HMAC SHA-256.

### Public address

Placeholder: set `publicUrl` so links open on your phone.

### Screenshots

Placeholder: opt-in screenshots per category, with form-field masking.

### Self-destruct

Placeholder: per-category message TTL and delete when resolved.

### Startup channels

Placeholder: channels declared with `--notificationChannel`.

### Delivery log

Placeholder: every delivery, and why a notification was not sent.
