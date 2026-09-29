---
"browserhive": minor
---

Notifications on your phone: Telegram, Discord, ntfy and webhook channels, with screenshots, live updates and messages that delete themselves.

- **Get a message when an agent needs you.** Add a channel under **Notifications → Channels**: a Telegram bot (one-tap connect, no chat id to look up), a Discord webhook, an ntfy topic (scan a QR code with the ntfy app) or a webhook of your own. A wizard shows the exact line to set the token for how you run BrowserHive, checks that it is set, previews the message exactly as it will look, and sends a test. Presets pick what to send (*Needs me now*, *Problems*, *Wrap-ups*); **Advanced** adds minimum severity, session patterns, harness, quiet hours with a time zone and the content level.
- **Messages keep up.** When you resolve an attention request, the chat message is edited in place, silently, and its buttons disappear; a growing group of tool errors updates its count. Every send, edit and delete is in the new **Delivery log**, live, with a sentence for anything that was not sent ("quiet hours", "the platform refused the token").
- **Screenshots, when you want them.** Off by default, per channel and category: the page when an agent asked for help (CAPTCHAs included), the login page before a vault fill (never during one), a crashed session's last frame. Form fields can be masked.
- **Self-destruct.** Delete messages after a time you choose per category, or once they are resolved. Telegram only allows 48 hours, so its timers stop at 47.
- **Links that open on your phone.** The new `publicUrl` key (`--publicUrl`, `BROWSERHIVE_PUBLIC_URL`) is the address where you reach the dashboard (a Tailscale name, your reverse proxy, a Cloudflare tunnel). Notification links use it, its host is trusted without `allowedHosts`, and the CSRF check accepts it even when your proxy rewrites `Host`. The System page and `browserhive doctor` check that it really reaches this BrowserHive.
- **Your accounts, your tokens.** BrowserHive runs no servers or shared bots. Tokens stay in environment variables; channels store only the variable names, so a database backup never contains one.
- **For servers and containers**, declare channels at startup with `--notificationChannel "telegram:name=phone,token=env:BH_TG_TOKEN,chat=123456"` (repeatable; a token typed into the flag is refused). They show in the dashboard with a "from startup" badge.
- **From a terminal:** `browserhive channels list`, `channels test <name>` and `channels preview <name>`; `browserhive doctor` checks every channel's variables and `publicUrl`.
- New REST endpoints under `/api/v1/channels` (scopes `channels:read`, `channels:write`), `GET /api/v1/system/public-url`, a `channels` WebSocket topic, and `instance_id` in `GET /health`.
