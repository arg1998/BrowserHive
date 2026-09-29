---
"browserhive": minor
---

Answer from your phone: Approve, Reject and Mark resolved right in Telegram, Discord and ntfy, and richer Telegram messages.

- **Answer without opening the dashboard.** Switch on **Answer from the chat** for a channel, and a notification that waits for you carries buttons that act: **Mark resolved** and **Reject** for an attention request, **Approve** and **Deny** for a vault fill. Press one and BrowserHive does what the same button in the dashboard does, then edits the message: the buttons disappear and it says who answered ("Resolved on Telegram by … after 42 s"). Off by default.
- **Only the right person, only once.** On Telegram and Discord only the accounts on the channel's allow-list may press; by default that is the person who connected the chat, and anyone else is told their id so you can add them. Every button works once, for 24 hours, only in its own chat, and only while the request still waits. Every press is listed under the new **Notifications → Actions**. The agent learns that you answered from Telegram, Discord or ntfy, never your chat identity.
- **Discord bot mode.** A Discord channel can now use a bot instead of a webhook, the only way to press buttons in Discord. The wizard walks through the Developer Portal, builds the invite link with the minimal permissions, lists your servers and channels, and links your account with a **This is me** button. The channel card shows whether the bot is connected.
- **ntfy answers through a second topic.** Give an ntfy channel a reply topic, and its buttons make your phone post the answer there; BrowserHive listens and updates the notification. Works on Android and iOS.
- **Nothing to expose.** Every connection goes out from your machine (Telegram long polling, the Discord gateway, an ntfy subscription). Presses made while BrowserHive was stopped are handled at the next start when the platform kept them. The webhook channel carries the act actions as they are, and your receiver answers through the REST API.
- **Telegram Rich Messages.** Telegram notifications now have a heading, the facts as a table, real tables, collapsible quotes and coloured buttons, with the screenshot inside the message. If Telegram refuses one, the classic format is sent instead.
- **Setup and terminal.** Startup channels take `actButtons=true` and `allow=<user ids>`, `mode=bot` for Discord and `reply=` for ntfy. `browserhive channels list` shows whether answers reach BrowserHive.
- New REST endpoints: `GET /api/v1/channels/actions` and the Discord bot setup under `/api/v1/channels/discord/…`; channels report `connection`; the `channels` WebSocket topic adds `action.recorded`. The database moves to schema v6 (three new tables; an older release still opens it).
