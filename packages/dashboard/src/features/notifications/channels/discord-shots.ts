/** @module features/notifications/channels/discord-shots — the screenshot slot of the "What's the
 * difference?" panel (D-38, plan §6).
 *
 * The panel always draws both Discord styles live, side by side, from the preview endpoint
 * (`mode: webhook` and `mode: bot`), so they match the current renderer and theme. When the owner
 * captures real screenshots of BrowserHive's OWN messages in a Discord test server, they can be
 * added here and the panel shows them under the live previews:
 *
 * 1. Save the images as `packages/dashboard/public/discord/webhook-message.png` and
 *    `packages/dashboard/public/discord/bot-message.png` (PNG or WebP, about 900 px wide, light or
 *    dark Discord theme). They are BrowserHive's own messages, so no third-party rights apply;
 *    never use images copied from Discord's site or the web.
 * 2. Set the paths below (`/discord/webhook-message.png`) and write alt text that describes what
 *    the picture shows.
 *
 * `null` means "no screenshot yet": only the live previews are shown.
 */

/** One real screenshot of a BrowserHive message in Discord. */
export interface DiscordShot {
  /** Path under the dashboard's public directory (`/discord/webhook-message.png`). */
  readonly src: string;
  readonly alt: string;
}

/** Screenshots per mode; `null` until the owner adds them. */
export const DISCORD_SHOTS: {
  readonly webhook: DiscordShot | null;
  readonly bot: DiscordShot | null;
} = {
  webhook: null,
  bot: null,
};
