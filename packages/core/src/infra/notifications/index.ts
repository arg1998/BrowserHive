/** @module infra/notifications — the platform adapters of the notification channels (spec 03 §9.5, §9.6, D-40, D-41): the renderers (shared with the preview), the transports as registry factories, the press listeners (Telegram poller, Discord gateway, ntfy reply topic), the Telegram and Discord setup calls, the screenshot store and the `publicUrl` probe. The only code that calls a platform. */

import type { Logger } from '../../ports/logger.ts';
import type {
  ChannelRenderer,
  NotificationChannel,
  NotificationImageReader,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import { createDiscordChannel, discordRenderer } from './discord.ts';
import type { DiscordGatewayHub } from './discord-gateway.ts';
import type { FetchFn } from './http.ts';
import { createNtfyChannel, ntfyRenderer } from './ntfy.ts';
import { createTelegramChannel, telegramRenderer } from './telegram.ts';
import type { CursorStore, TelegramUpdatesHub } from './telegram-updates.ts';
import { createWebhookChannel, webhookRenderer } from './webhook.ts';

export {
  createDiscordChannel,
  DISCORD_BOT_CAPABILITIES,
  DISCORD_LIMITS,
  DISCORD_WEBHOOK_CAPABILITIES,
  type DiscordChannelDeps,
  discordCapabilities,
  discordRenderer,
} from './discord.ts';
export {
  CLAIM_PREFIX,
  DISCORD_API_BASE,
  DiscordGatewayHub,
  type DiscordGatewayOptions,
  type GatewaySocket,
} from './discord-gateway.ts';
export { createDiscordSetup, type DiscordSetupOptions } from './discord-setup.ts';
export { callPlatform, classifyFailure, type FetchFn, retryAfterMs, scrubDetail } from './http.ts';
export {
  createNotificationImageStore,
  IMAGE_REF_RE,
  type ImageStoreOptions,
} from './image-store.ts';
export {
  createNtfyChannel,
  NTFY_CAPABILITIES,
  type NtfyChannelDeps,
  ntfyCapabilities,
  ntfyRenderer,
} from './ntfy.ts';
export { createNtfyReplySource, type NtfyReplyOptions } from './ntfy-replies.ts';
export { LOCAL_LINKS_LABEL } from './render-common.ts';
export {
  createTelegramChannel,
  escapeHtml,
  isRichRef,
  RICH_PHOTO_ID,
  richPhotoFileId,
  TELEGRAM_API_BASE,
  TELEGRAM_CAPABILITIES,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_RICH_MAX,
  TELEGRAM_TEXT_MAX,
  type TelegramChannelDeps,
  telegramAcceptsUrl,
  telegramCapabilities,
  telegramClassicRenderer,
  telegramRenderer,
  telegramRichHtml,
} from './telegram.ts';
export { createTelegramSetup, type TelegramSetupOptions } from './telegram-setup.ts';
export {
  type CursorStore,
  TELEGRAM_ALLOWED_UPDATES,
  TelegramUpdatesHub,
  type TelegramUpdatesOptions,
} from './telegram-updates.ts';
export { createUrlProbe, type UrlProbeOptions } from './url-probe.ts';
export {
  createWebhookChannel,
  SIGNATURE_HEADER,
  signBody,
  TIMESTAMP_HEADER,
  WEBHOOK_CAPABILITIES,
  type WebhookChannelDeps,
  webhookCapabilities,
  webhookRenderer,
} from './webhook.ts';

/** The renderer of every platform with an adapter, by kind (the preview uses the same ones). */
export const CHANNEL_RENDERERS: ReadonlyMap<string, ChannelRenderer> = new Map([
  ['telegram', telegramRenderer],
  ['discord', discordRenderer],
  ['ntfy', ntfyRenderer],
  ['webhook', webhookRenderer],
]);

/** Reads a channel secret by variable name (`ChannelFactoryContext` of the registry). */
export interface SecretContext {
  secret(envName: string): string | null;
}

/** Builds one channel's adapter; structurally the registry's `ChannelAdapterFactory`. */
export type PlatformAdapterFactory = (
  channel: NotificationChannelRecord,
  context: SecretContext,
) => NotificationChannel;

/** Dependencies shared by the factories. */
export interface ChannelFactoriesDeps {
  readonly images: NotificationImageReader;
  readonly fetch?: FetchFn;
  /** Base URLs of the platforms (the fakes pass their own). */
  readonly apiBases?: { readonly telegram?: string; readonly discord?: string };
  /** The Telegram update pollers (act-button presses, D-41). */
  readonly telegramUpdates?: TelegramUpdatesHub;
  /** The Discord gateway connections (bot mode, D-38). */
  readonly discordGateway?: DiscordGatewayHub;
  /** Where the ntfy reply subscriptions resume. */
  readonly cursors?: CursorStore;
  readonly logger?: Logger;
}

/**
 * Reads a secret parameter of a channel: the variable it names, or an error naming what is missing
 * (the registry records the adapter as absent and the API shows the message as the problem).
 */
function secretOf(
  channel: NotificationChannelRecord,
  context: SecretContext,
  param: string,
  required: boolean,
): string | null {
  const name = channel.secretRefs[param];
  if (name === undefined) {
    if (required) throw new Error(`channel '${channel.name}' names no variable for ${param}`);
    return null;
  }
  const value = context.secret(name);
  if (value === null && required) throw new Error(`${name} is not set`);
  if (value === null) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The adapter factories per kind, for `ChannelRegistry({ factories })`.
 *
 * @returns telegram, discord, ntfy and webhook factories.
 */
export function channelFactories(
  deps: ChannelFactoriesDeps,
): ReadonlyMap<string, PlatformAdapterFactory> {
  const fetchFn = deps.fetch;
  return new Map<string, PlatformAdapterFactory>([
    [
      'telegram',
      (channel, context) =>
        createTelegramChannel(channel, {
          token: secretOf(channel, context, 'token', true) ?? '',
          images: deps.images,
          ...(fetchFn !== undefined && { fetch: fetchFn }),
          ...(deps.apiBases?.telegram !== undefined && { apiBase: deps.apiBases.telegram }),
          ...(deps.telegramUpdates !== undefined && { updates: deps.telegramUpdates }),
          ...(deps.logger !== undefined && { logger: deps.logger }),
        }),
    ],
    [
      'discord',
      (channel, context) =>
        createDiscordChannel(
          channel,
          channel.mode === 'bot'
            ? {
                botToken: secretOf(channel, context, 'token', true) ?? '',
                images: deps.images,
                ...(fetchFn !== undefined && { fetch: fetchFn }),
                ...(deps.apiBases?.discord !== undefined && { apiBase: deps.apiBases.discord }),
                ...(deps.discordGateway !== undefined && { gateway: deps.discordGateway }),
              }
            : {
                webhookUrl: secretOf(channel, context, 'webhook', true) ?? '',
                images: deps.images,
                ...(fetchFn !== undefined && { fetch: fetchFn }),
              },
        ),
    ],
    [
      'ntfy',
      (channel, context) =>
        createNtfyChannel(channel, {
          token: secretOf(channel, context, 'token', false),
          topic: secretOf(channel, context, 'topic', false),
          replyTopic: secretOf(channel, context, 'reply_topic', false),
          replyToken: secretOf(channel, context, 'reply_token', false),
          images: deps.images,
          ...(fetchFn !== undefined && { fetch: fetchFn }),
          ...(deps.cursors !== undefined && { cursors: deps.cursors }),
          ...(deps.logger !== undefined && { logger: deps.logger }),
        }),
    ],
    [
      'webhook',
      (channel, context) =>
        createWebhookChannel(channel, {
          url: secretOf(channel, context, 'url', false),
          secret: secretOf(channel, context, 'secret', false),
          ...(fetchFn !== undefined && { fetch: fetchFn }),
        }),
    ],
  ]);
}
