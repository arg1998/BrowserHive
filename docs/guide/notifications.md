# Notifications

BrowserHive tells you when something needs you or went wrong: an agent asked for help, a vault fill waits for your approval, a session crashed, tools keep failing, or BrowserHive itself is degraded. Notifications are stored in the database, so they survive reloads and restarts, and they appear in the dashboard's bell, as toasts and on the **Notifications** page.

BrowserHive can also put them on your phone: through your own Telegram bot, a Discord webhook, an ntfy topic or a webhook of your own. This page explains what produces a notification, how one changes over its life, how to set up each channel, and what leaves your machine.

- [Channels: set one up in two minutes](#channels)
- [Public address: links that open on your phone](#public-address)
- [Screenshots](#screenshots), [self-destruct](#self-destruct), [startup channels](#startup-channels), [the delivery log](#delivery-log)
- [What leaves your machine](#what-leaves-your-machine)

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

Every notification is also a `NotificationMessage`: a small, versioned JSON document with a title and summary, structured blocks (text, facts, lists, tables, images, code), up to five buttons, and what it is about (session, tool, error code). Links in it are dashboard paths. BrowserHive owns this contract; every channel renders it and none reads BrowserHive's internals. The JSON Schema is published at [notification-message.schema.json](../reference/notification-message.schema.json), so you can build your own consumer from the [webhook channel](#webhook).

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

## Channels

A channel is one place notifications go: a Telegram chat, a Discord channel, an ntfy topic or a URL of yours. Add one in the dashboard under **Notifications → Channels → Add channel**. The wizard walks through five steps:

1. **Platform.** Telegram, Discord, ntfy or Webhook.
2. **Credentials.** Pick the name of an environment variable that will hold the token, such as `BH_TELEGRAM_TOKEN` (any name that does not start with `BROWSERHIVE_`, which configuration keys use). The wizard shows the exact line for how you run BrowserHive (a shell, systemd, Docker) and a live **set ✓ / missing ✗** check. Set the variable and restart BrowserHive; the wizard keeps your draft across the restart.
3. **Connect.** The platform-specific part, below.
4. **What to send.** Pick a preset (*Needs me now*, *Problems*, *Wrap-ups* or *Everything*) or open **Advanced** for minimum severity, session name patterns, harness, quiet hours with a time zone, the [content level](#what-leaves-your-machine), [screenshots](#screenshots) and [self-destruct](#self-destruct).
5. **Preview and test.** See the message exactly as it will look (drawn from the same code that sends it), save, then **Send test**. The test message has an **Open dashboard** button: tap it on your phone to check that links reach you ([public address](#public-address)).

Each channel card shows its status, the last delivery and the last 24 hours (sent, failed, filtered). You can pause, resume, edit, duplicate, delete and test it there. There is no limit on channels; every matching channel gets its own copy.

Secrets are never stored: a channel holds the **name** of the environment variable, BrowserHive reads the value when it starts, and the dashboard only ever says whether it is set. Changing a token is a change to the environment plus a restart.

### Telegram

1. In Telegram, open a chat with **@BotFather**, send `/newbot`, choose a display name and a username ending in `bot`. BotFather answers with a token like `123456789:AA…`.
2. Put it in a variable where BrowserHive runs, for example `export BH_TELEGRAM_TOKEN='123456789:AA…'`, and restart BrowserHive.
3. In the wizard's **Connect** step, tap the one-time link (or scan its QR code with your phone). It opens a chat with your bot and sends `/start`. BrowserHive waits up to two minutes for it and fills in the chat by itself. For a group, use **Add to a group** instead, pick the group, and the bot posts there. For a forum topic, send the start link inside that topic.

Messages use Telegram's HTML formatting. A notification with a screenshot is a photo with a caption (Telegram allows 1 024 characters in a caption; longer messages end with "… Open in BrowserHive"). Buttons are links. When an attention request is resolved, the message is edited in place, silently, and its buttons disappear.

Telegram lets a bot delete its own messages for **48 hours** only, so self-destruct timers on a Telegram channel go up to 47 hours. Telegram's own auto-delete timer (chat settings → Auto-delete messages) is a good backstop.

### Discord

1. In Discord, open the channel's settings: **Edit Channel → Integrations → Webhooks → New Webhook**. Name it, optionally set an avatar, then **Copy Webhook URL**.
2. Put the URL in a variable, for example `export BH_DISCORD_WEBHOOK='https://discord.com/api/webhooks/…'`, and restart BrowserHive. The URL is the secret: anyone who has it can post to your channel.
3. In the wizard, choose **Webhook** mode. There is nothing else to connect.

Messages are an embed: a coloured bar by severity, the facts as fields, the screenshot as the embed image, and link buttons below. Edits are silent; deletes work at any age.

**Webhook or bot?** A Discord channel uses one mode. Webhook mode takes thirty seconds and needs no connection, but its buttons can only open links. Bot mode (a Developer Portal application with a bot token) is the only way to press **Approve** or **Reject** right in Discord, and keeps one outbound connection to Discord while BrowserHive runs. Bot mode arrives with act buttons in a later release; the wizard's **What's the difference?** panel shows both message styles side by side.

### ntfy

[ntfy](https://ntfy.sh) is a free, open-source push service with apps for Android and iOS. You can use the public server `ntfy.sh` or host your own.

1. Install the ntfy app on your phone.
2. In the wizard, keep the server (`https://ntfy.sh`) or enter your own, and keep the suggested random topic (for example `bh-7f3kq9x2`) or type one. **On a public server the topic is the password**: anyone who knows it can read your notifications, so keep it long and random. You can also keep it in a variable (`topic` from `BH_NTFY_TOPIC`).
3. Scan the QR code with your phone (or tap **Subscribe** in the app and enter the server and topic).
4. For a protected server or topic, create an access token in ntfy and put it in a variable such as `BH_NTFY_TOKEN`.

Priority follows severity (a critical notification is urgent). Buttons are "view" actions (at most three). A revision replaces the notification on the phone; a self-destruct deletes it. On ntfy.sh, attachments (screenshots) are stored on the public server for three hours and their links are not documented to be private: for screenshots, a self-hosted ntfy is the better choice. A self-hosted server without an attachment cache refuses uploads; BrowserHive then sends the text alone.

### Webhook

The webhook channel POSTs the [message contract](#the-message-contract) itself as JSON, so you can build your own consumer (Home Assistant, n8n, a script):

```json
{
  "schema": 1,
  "event": "notification",
  "op": "send",
  "delivered_at": 1790642672932,
  "channel": { "id": "nc-…", "name": "ops" },
  "links": { "take-over": "https://bh.example.net/sessions/…?live=1&takeover=1" },
  "local_links": false,
  "message": { "schema": 1, "id": "n-…", "revision": 1, "kind": "attention.requested", "…": "…" }
}
```

A revision is POSTed again with `op: "edit"` and a higher `message.revision`; keep the highest. When you set a signing secret (`secret` from a variable such as `BH_WEBHOOK_SECRET`), each request carries `X-BrowserHive-Timestamp` and `X-BrowserHive-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with your secret. Only `http:` and `https:` URLs are accepted, redirects are followed only on the same scheme and host, and a private address (your LAN) is allowed with a warning, because the request comes from inside your network.

## Public address

Links in a notification ("Take over", "Open session") must open somewhere your phone can reach. By default they point at this computer (`http://127.0.0.1:9876/…`) and are labelled **Open on this computer**; they work on the machine running BrowserHive and nowhere else.

Set `publicUrl` to the address where you made the dashboard reachable, and every link becomes `publicUrl + path`:

```sh
browserhive --admin --publicUrl https://browserhive.example.net
# or BROWSERHIVE_PUBLIC_URL=https://…, or "publicUrl" in browserhive.config.json
```

BrowserHive provides no tunnel or proxy; use what you already have:

- **Tailscale (nothing exposed to the internet).** Install Tailscale on the computer and your phone, then either browse to the machine's Tailscale name directly (`--host 0.0.0.0 --auth token --publicUrl http://my-box.tail1234.ts.net:9876`) or let Tailscale proxy it with HTTPS: `tailscale serve --bg 9876` and `--publicUrl https://my-box.tail1234.ts.net`.
- **A reverse proxy with your domain** (Caddy, nginx, Traefik) forwarding to `127.0.0.1:9876`, ideally behind an access layer such as Cloudflare Access or your proxy's own login.
- **Cloudflare Tunnel** (`cloudflared tunnel --url http://127.0.0.1:9876`) with Cloudflare Access in front.

The host of `publicUrl` is trusted automatically: you do not need to add it to `allowedHosts`, and the CSRF check accepts its origin even when your proxy rewrites the `Host` header to the upstream address. Links never carry a token; opening one still needs the dashboard login. BrowserHive warns when `publicUrl` is plain `http:` on a host that is not your own machine.

**Checking it.** The System page and `browserhive doctor` fetch `<publicUrl>/health` and compare an id that changes at every start:

| Result | Meaning |
|---|---|
| ✓ Points to this BrowserHive | The address reaches this instance. |
| ✗ Points elsewhere | Another server (or another BrowserHive) answered. |
| ! Behind a login | A login page or an access proxy answered, so it cannot be confirmed from here. That is expected with Cloudflare Access. |
| ! Not reachable from this machine | Nothing answered from here. It may still work from outside, for example behind a router without hairpin NAT. |

The final proof is the **Open dashboard** button of a test message, tapped on your phone.

## Screenshots

A notification can carry a screenshot of what the agent was looking at. Screenshots are **off** by default and switched on per channel and category (in the wizard's **Advanced** step). They are taken for three things only:

- **An attention request**, CAPTCHA hand-offs included: a picture of the page when the agent asked for help.
- **A vault fill waiting for confirmation**: the login page and the site being filled, taken **before** the fill starts (the fill waits for your approval). BrowserHive never takes a screenshot during or after a fill, or while a secret is being typed.
- **A crashed session**: its last stored screenshot, if it has one.

Screenshots need the content level **full**, and BrowserHive never takes them when `recordToolResults` is `none`. **Mask form fields** (on by default when you enable screenshots) blacks out inputs, text areas and menus before the picture is taken; a crash's stored frame cannot be masked, so a masking channel gets no crash screenshot. Screenshots are JPEG files in the data directory, readable only by you, and are removed after 7 days.

## Self-destruct

No chat platform lets a bot set a timer on a message, so BrowserHive deletes its messages itself:

- **Delete after** a time you choose per category (for example: needs-you after 2 hours, problems after 1 day, reports never). The default is never.
- **Delete when resolved**, per category, off by default: the message goes away once the request is resolved.

The deadline is stored with the message, so a deletion that fell due while BrowserHive was stopped happens at the next start. Telegram only allows deleting within 48 hours; a Telegram message that became older while BrowserHive was off is logged as `could_not_delete: too_old`. Deleting removes the message for everyone in the chat, but it cannot take back a lock-screen preview someone already saw.

## Startup channels

For a server or a container you can declare channels on the command line; they exist from the first start without any clicking. Repeat the flag for several channels:

```sh
export BH_TG_TOKEN='123456789:AA…'
browserhive --admin \
  --notificationChannel "telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456789" \
  --notificationChannel "ntfy:name=pager,topic=env:BH_NTFY_TOPIC,categories=needs-you+problems,min=warn"
```

- Secrets are always written `env:NAME`. A token typed into the flag is refused (exit 64), because other users of the machine can read process arguments.
- Rules use the same names as the dashboard: `categories`, `min`, `sessions`, `harness`, `content`, `quiet=22:00-07:00` with `tz`, `ttl.needs-you=2h`, `deleteWhenResolved`, `images`, `maskImages`. Every parameter is listed in the [command-line guide](cli.md#notification-channels).
- The flag has no environment-variable or config-file spelling. Startup channels appear in the dashboard with a **from startup** badge. You can pause them there, but you edit them by changing the flag and restarting. A startup channel whose name a dashboard channel already uses stops the start with an error, so neither silently wins.

## Delivery log

**Notifications → Delivery log** lists every send, edit and delete, live: time, channel, notification, revision, status, attempts and how long the platform took. Filter by channel, status, operation or kind. Open a row to see the notification's journey on every channel and the message exactly as that channel was shown it. Every row that was not delivered says why in a sentence: filtered by the channel's rules, quiet hours, the channel was paused, the platform refused the token, the message had been deleted in the chat, and so on. The same answers are in `GET /api/v1/channels/deliveries`.

From a terminal:

```sh
browserhive channels list                     # status, target, variables, last delivery, 24 h counts
browserhive channels test phone               # a real test message; exit 1 when the platform refused it
browserhive channels preview phone --sample vault-confirm   # the request a send would make; sends nothing
```

These talk to the running server (`--url`, with `--token` for an operator API token or `--cookie`), like `browserhive admin tokens --url`.

## What leaves your machine

A channel sends notifications to a service you chose, so each one has a **content level**:

| Level | What it sends |
|---|---|
| `counts` | The kind of event, a count and the session name. Nothing typed by an agent, no page addresses. |
| `titles` (default) | Adds the title, the summary and the facts (session, tool, error code, page address without query string). |
| `full` | Adds the agent's own words (the attention reason), longer details, and allows [screenshots](#screenshots). |

At every level, BrowserHive first removes registered secrets and credential-shaped text and strips query strings and fragments from URLs ([security](security.md)). Channel tokens never reach a log line, the database or the delivery log.

## Retention

Read or dismissed notifications are kept for 30 days, others for 90. Delivery history is kept for 30 days. Configured channels are never pruned; `browserhive purge` lists them with everything else in the database.
