/** @module contracts/http/channels — notification channels: CRUD, test send, preview, the delivery log, the environment check and the Telegram connect flow (spec 03 §4.8.1, D-33, D-37, D-38, D-39) */
import { z } from 'zod';
import {
  NotificationActionOutcome,
  NotificationChannelKind,
  NotificationChannelSource,
  NotificationChannelStatus,
  NotificationDeliveryOp,
  NotificationDeliveryStatus,
  NotificationKind,
  NotificationListenerState,
} from '../enums/index.ts';
import { NotificationId } from '../ids/index.ts';
import {
  NotificationChannelName,
  NotificationChannelRules,
  NotificationChannelSecretRefs,
  NotificationChannelTarget,
  SecretEnvName,
} from '../notifications/channel.ts';
import { NotificationMessage } from '../notifications/message.ts';
import { AvailableChannelKind, PreviewSample } from '../notifications/platforms.ts';
import { Count, Cursor, csv, DurationMs, EpochMs, limitQuery, page } from './common.ts';

/** Channel id (`nc-…`). */
export const ChannelId = z.string().regex(/^nc-[A-Za-z0-9_-]{4,64}$/, 'a channel id (nc-…)');
/** Channel id. */
export type ChannelId = z.infer<typeof ChannelId>;

/** What a platform adapter can render (spec 03 §9.3), in wire form. */
export const ChannelCapabilitiesDto = z.object({
  rich_blocks: z.boolean(),
  tables: z.boolean(),
  images: z.boolean(),
  act_buttons: z.boolean(),
  open_links: z.boolean(),
  edit: z.boolean(),
  delete: z.boolean(),
  replies: z.boolean(),
  /** How long after sending a message may still be deleted; `null` = no limit. */
  delete_window_ms: DurationMs.nullable(),
  max_title_chars: Count,
  max_text_chars: Count,
  max_buttons: Count,
});
/** Adapter capabilities. */
export type ChannelCapabilitiesDto = z.infer<typeof ChannelCapabilitiesDto>;

/** Whether one secret variable a channel names is set in the server's environment (never its value). */
export const ChannelSecretState = z.object({
  param: z.string(),
  env: z.string(),
  set: z.boolean(),
});
/** Secret variable state. */
export type ChannelSecretState = z.infer<typeof ChannelSecretState>;

/** Delivery counts of one channel. */
export const ChannelStats = z.object({
  sent_24h: Count,
  failed_24h: Count,
  suppressed_24h: Count,
  /** Jobs waiting (`pending`, `retrying`, `sending`). */
  pending: Count,
  last_delivery_at: EpochMs.nullable(),
  last_status: NotificationDeliveryStatus.nullable(),
});
/** Delivery counts of one channel. */
export type ChannelStats = z.infer<typeof ChannelStats>;

/** State of a channel's press listener (Telegram poller, Discord gateway, ntfy reply subscription; D-41). */
export const ChannelConnection = z.object({
  state: NotificationListenerState,
  /** When the listener entered this state. */
  since: EpochMs,
  /** Why it is offline or reconnecting ("the token was refused"); `null` when connected. */
  detail: z.string().nullable(),
});
/** Press listener state. */
export type ChannelConnection = z.infer<typeof ChannelConnection>;

/** One configured channel as the API shows it. Never carries a secret value. */
export const ChannelView = z.object({
  channel_id: ChannelId,
  name: z.string(),
  kind: NotificationChannelKind,
  mode: z.string().nullable(),
  /** `startup` channels come from `--notificationChannel` and are read-only (D-39). */
  source: NotificationChannelSource,
  status: NotificationChannelStatus,
  target: NotificationChannelTarget,
  /** Short, lossy rendering of where it sends ("chat …3456", "ntfy.sh/bh-alerts"). */
  target_hint: z.string(),
  secret_refs: NotificationChannelSecretRefs,
  secrets: z.array(ChannelSecretState),
  rules: NotificationChannelRules,
  /** `null` when no adapter could be built. */
  capabilities: ChannelCapabilitiesDto.nullable(),
  /** The adapter is built and every required variable is set. */
  ready: z.boolean(),
  /** Why it is not ready, or a warning (a private webhook target); `null` when fine. */
  problem: z.string().nullable(),
  failure_count: Count,
  last_error: z.string().nullable(),
  last_ok_at: EpochMs.nullable(),
  last_failure_at: EpochMs.nullable(),
  created_at: EpochMs,
  updated_at: EpochMs,
  stats: ChannelStats,
  /** The press listener, or `null` when the channel receives no presses (act buttons off). */
  connection: ChannelConnection.nullable(),
});
/** One configured channel. */
export type ChannelView = z.infer<typeof ChannelView>;

/** Path params `{channel_id}`. */
export const ChannelIdParams = z.strictObject({ channel_id: ChannelId });
/** Path params `{channel_id}`. */
export type ChannelIdParams = z.infer<typeof ChannelIdParams>;

/** `POST /channels` body. Secrets are environment variable NAMES (D-33). */
export const ChannelInput = z.strictObject({
  name: NotificationChannelName,
  kind: AvailableChannelKind,
  /** Discord: `webhook` (default) or `bot` (D-38). */
  mode: z.string().max(32).nullable().optional(),
  target: NotificationChannelTarget.default({}),
  secret_refs: z.record(z.string().max(64), z.string().max(256)).default({}),
  rules: NotificationChannelRules.default({}),
});
/** `POST /channels` body. */
export type ChannelInput = z.infer<typeof ChannelInput>;

/** `PATCH /channels/{id}` body: any subset of the input except `kind`. */
export const ChannelPatch = z.strictObject({
  name: NotificationChannelName.optional(),
  mode: z.string().max(32).nullable().optional(),
  target: NotificationChannelTarget.optional(),
  secret_refs: z.record(z.string().max(64), z.string().max(256)).optional(),
  rules: NotificationChannelRules.optional(),
});
/** `PATCH /channels/{id}` body. */
export type ChannelPatch = z.infer<typeof ChannelPatch>;

/** `GET /channels` body. */
export const ChannelsResponse = z.object({ data: z.array(ChannelView), now: EpochMs });
/** `GET /channels` body. */
export type ChannelsResponse = z.infer<typeof ChannelsResponse>;

/** One channel. */
export const ChannelResponse = z.object({ channel: ChannelView });
/** One channel. */
export type ChannelResponse = z.infer<typeof ChannelResponse>;

/** One outbox job / delivery log row (D-34). */
export const DeliveryRow = z.object({
  seq: z.number().int().positive(),
  channel_id: z.string(),
  channel_name: z.string().nullable(),
  channel_kind: z.string().nullable(),
  notification_id: NotificationId,
  notification_kind: NotificationKind.nullable(),
  notification_title: z.string().nullable(),
  revision: z.number().int().min(1),
  op: NotificationDeliveryOp,
  status: NotificationDeliveryStatus,
  /** Suppression, supersede or failure reason (`filtered`, `quiet_hours`, `rate_limited`, …). */
  reason: z.string().nullable(),
  attempts: Count,
  next_attempt_at: EpochMs.nullable(),
  last_error: z.string().nullable(),
  duration_ms: DurationMs.nullable(),
  /** The platform coordinates of the message (message id, chat id, sequence id). */
  message_ref: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
  created_at: EpochMs,
  updated_at: EpochMs,
});
/** One delivery log row. */
export type DeliveryRow = z.infer<typeof DeliveryRow>;

/** `GET /channels/deliveries` query (keyset on `seq`, newest first). */
export const DeliveriesQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: limitQuery(200, 50),
  channel_id: ChannelId.optional(),
  notification_id: NotificationId.optional(),
  status: csv(NotificationDeliveryStatus),
  op: csv(NotificationDeliveryOp),
  kind: csv(NotificationKind),
});
/** `GET /channels/deliveries` query. */
export type DeliveriesQuery = z.infer<typeof DeliveriesQuery>;

/** `GET /channels/deliveries` body. */
export const DeliveriesPage = page(DeliveryRow);
/** `GET /channels/deliveries` body. */
export type DeliveriesPage = z.infer<typeof DeliveriesPage>;

/** Path params `{seq}`. */
export const DeliverySeqParams = z.strictObject({ seq: z.coerce.number().int().positive() });

/** `GET /channels/deliveries/{seq}` body. */
export const DeliveryDetailResponse = z.object({
  delivery: DeliveryRow,
  /** The notification's current message as this channel is shown it; `null` when unavailable. */
  message: NotificationMessage.nullable(),
});
/** `GET /channels/deliveries/{seq}` body. */
export type DeliveryDetailResponse = z.infer<typeof DeliveryDetailResponse>;

/** `POST /channels/{id}/test` body. */
export const ChannelTestResponse = z.object({
  ok: z.boolean(),
  delivery: DeliveryRow.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
/** `POST /channels/{id}/test` body. */
export type ChannelTestResponse = z.infer<typeof ChannelTestResponse>;

/** `POST /channels/preview` body: a saved channel, or a draft. */
export const ChannelPreviewRequest = z
  .strictObject({
    channel_id: ChannelId.optional(),
    kind: AvailableChannelKind.optional(),
    mode: z.string().max(32).nullable().optional(),
    target: NotificationChannelTarget.optional(),
    /**
     * A draft's secret parameters as variable NAMES (never values): decide capabilities (an ntfy
     * reply topic from a variable) and show the names in the rendered paths. Entries that are not
     * valid variable names are ignored.
     */
    secret_refs: z.record(z.string().max(64), z.string().max(256)).optional(),
    rules: NotificationChannelRules.optional(),
    sample: PreviewSample.default('attention'),
  })
  .refine((b) => (b.channel_id === undefined) !== (b.kind === undefined), {
    message: 'give channel_id or kind, not both',
  });
/** `POST /channels/preview` body. */
export type ChannelPreviewRequest = z.infer<typeof ChannelPreviewRequest>;

/** One platform request a renderer produced; secrets in the path are replaced by variable names. */
export const PlatformRequest = z.object({
  /** `POST`, `PUT`, `PATCH`, `DELETE`. */
  method: z.string(),
  /** Platform method or path (`sendPhoto`, `/webhooks/{BH_DISCORD_WEBHOOK}`, `/bh-alerts`). */
  path: z.string(),
  /** `json`, `multipart` (a file part plus fields) or `binary` (a file body, fields as query). */
  encoding: z.enum(['json', 'multipart', 'binary']),
  /** JSON body, or the non-file fields of a multipart/binary request. */
  body: z.record(z.string(), z.unknown()),
  /** Headers that carry content (ntfy `X-*`); never an Authorization header. */
  headers: z.record(z.string(), z.string()),
  /** The attached file, if any (never its bytes). */
  file: z.object({ name: z.string(), content_type: z.string() }).nullable(),
});
/** One platform request. */
export type PlatformRequest = z.infer<typeof PlatformRequest>;

/** `POST /channels/preview` response. Pure: nothing was sent. */
export const ChannelPreview = z.object({
  kind: AvailableChannelKind,
  mode: z.string().nullable(),
  sample: PreviewSample,
  capabilities: ChannelCapabilitiesDto,
  /** The message as the channel receives it (content level, image rule, degrade applied). */
  message: NotificationMessage,
  /** The request(s) a send makes, in order. */
  requests: z.array(PlatformRequest),
  /** Links point at this computer (no `publicUrl`). */
  local_links: z.boolean(),
  notes: z.array(z.string()),
});
/** `POST /channels/preview` response. */
export type ChannelPreview = z.infer<typeof ChannelPreview>;

/** `GET /channels/env` query. */
export const ChannelEnvQuery = z.strictObject({
  names: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(SecretEnvName).min(1).max(16),
  ),
});
/** `GET /channels/env` query. */
export type ChannelEnvQuery = z.infer<typeof ChannelEnvQuery>;

/** `GET /channels/env` body. */
export const ChannelEnvResponse = z.object({
  vars: z.array(z.object({ name: z.string(), set: z.boolean() })),
});
/** `GET /channels/env` body. */
export type ChannelEnvResponse = z.infer<typeof ChannelEnvResponse>;

/** `POST /channels/telegram/connect` body. */
export const TelegramConnectRequest = z.strictObject({ token_env: SecretEnvName });
/** `POST /channels/telegram/connect` body. */
export type TelegramConnectRequest = z.infer<typeof TelegramConnectRequest>;

/** `POST /channels/telegram/connect` response. */
export const TelegramConnectResponse = z.object({
  connect_id: z.string(),
  bot_username: z.string(),
  /** Opens a private chat with the bot and sends `/start <code>`. */
  link: z.string(),
  /** Adds the bot to a group and sends `/start <code>` there. */
  group_link: z.string(),
  expires_at: EpochMs,
});
/** `POST /channels/telegram/connect` response. */
export type TelegramConnectResponse = z.infer<typeof TelegramConnectResponse>;

/** Path params `{connect_id}`. */
export const TelegramConnectParams = z.strictObject({
  connect_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

/** `GET /channels/telegram/connect/{connect_id}` response. */
export const TelegramConnectStatus = z.object({
  status: z.enum(['waiting', 'connected', 'expired', 'failed']),
  chat: z
    .object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      thread_id: z.string().nullable(),
    })
    .nullable(),
  /** Who sent `/start` (the first allow-list entry for act buttons, N2). */
  user: z.object({ id: z.string(), name: z.string() }).nullable(),
  error: z.string().nullable(),
  expires_at: EpochMs,
});
/** `GET /channels/telegram/connect/{connect_id}` response. */
export type TelegramConnectStatus = z.infer<typeof TelegramConnectStatus>;

/** One act-button press (the audit, D-41). Never carries a token. */
export const ActionRow = z.object({
  seq: z.number().int().positive(),
  at: EpochMs,
  channel_id: z.string(),
  channel_name: z.string(),
  channel_kind: z.string(),
  notification_id: z.string().nullable(),
  notification_title: z.string().nullable(),
  action_id: z.string(),
  action_label: z.string().nullable(),
  op: z.string(),
  /** `telegram:<user id>`, `discord:<user id>` or `ntfy:topic-b`. */
  actor: z.string(),
  actor_name: z.string().nullable(),
  outcome: NotificationActionOutcome,
  /** The answer shown to the presser, or the failure. */
  detail: z.string().nullable(),
});
/** One act-button press. */
export type ActionRow = z.infer<typeof ActionRow>;

/** `GET /channels/actions` query (keyset on `seq`, newest first). */
export const ActionsQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: limitQuery(200, 50),
  channel_id: ChannelId.optional(),
  notification_id: NotificationId.optional(),
  outcome: csv(NotificationActionOutcome),
});
/** `GET /channels/actions` query. */
export type ActionsQuery = z.infer<typeof ActionsQuery>;

/** `GET /channels/actions` body. */
export const ActionsPage = page(ActionRow);
/** `GET /channels/actions` body. */
export type ActionsPage = z.infer<typeof ActionsPage>;

/** `POST /channels/discord/bot` body. */
export const DiscordBotRequest = z.strictObject({ token_env: SecretEnvName });
/** `POST /channels/discord/bot` body. */
export type DiscordBotRequest = z.infer<typeof DiscordBotRequest>;

/** A Discord server the bot is in. */
export const DiscordGuild = z.object({ id: z.string(), name: z.string() });
/** A Discord server. */
export type DiscordGuild = z.infer<typeof DiscordGuild>;

/** `POST /channels/discord/bot` response: who the bot is, its invite link and its servers. */
export const DiscordBotInfo = z.object({
  application_id: z.string(),
  bot_id: z.string(),
  bot_username: z.string(),
  /** Adds the bot to a server with the minimal permissions (D-38). */
  invite_url: z.string(),
  guilds: z.array(DiscordGuild),
});
/** `POST /channels/discord/bot` response. */
export type DiscordBotInfo = z.infer<typeof DiscordBotInfo>;

/** `POST /channels/discord/channels` body. */
export const DiscordChannelsRequest = z.strictObject({
  token_env: SecretEnvName,
  guild_id: z.string().regex(/^\d{15,21}$/, 'a Discord id'),
});
/** `POST /channels/discord/channels` body. */
export type DiscordChannelsRequest = z.infer<typeof DiscordChannelsRequest>;

/** A text channel of a Discord server. */
export const DiscordTextChannel = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['text', 'announcement']),
  /** The category it is listed under, if any. */
  category: z.string().nullable(),
});
/** A text channel. */
export type DiscordTextChannel = z.infer<typeof DiscordTextChannel>;

/** `POST /channels/discord/channels` response. */
export const DiscordChannelsResponse = z.object({ channels: z.array(DiscordTextChannel) });
/** `POST /channels/discord/channels` response. */
export type DiscordChannelsResponse = z.infer<typeof DiscordChannelsResponse>;

/** `POST /channels/discord/connect` body. */
export const DiscordConnectRequest = z.strictObject({
  token_env: SecretEnvName,
  channel_id: z.string().regex(/^\d{15,21}$/, 'a Discord id'),
});
/** `POST /channels/discord/connect` body. */
export type DiscordConnectRequest = z.infer<typeof DiscordConnectRequest>;

/** `POST /channels/discord/connect` response. */
export const DiscordConnectResponse = z.object({ connect_id: z.string(), expires_at: EpochMs });
/** `POST /channels/discord/connect` response. */
export type DiscordConnectResponse = z.infer<typeof DiscordConnectResponse>;

/** Path params `{connect_id}` of the Discord connect flow. */
export const DiscordConnectParams = z.strictObject({
  connect_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

/** `GET /channels/discord/connect/{connect_id}` response. */
export const DiscordConnectStatus = z.object({
  status: z.enum(['waiting', 'connected', 'expired', 'failed']),
  /** Who pressed "This is me" (the first allow-list entry). */
  user: z.object({ id: z.string(), name: z.string() }).nullable(),
  error: z.string().nullable(),
  expires_at: EpochMs,
});
/** `GET /channels/discord/connect/{connect_id}` response. */
export type DiscordConnectStatus = z.infer<typeof DiscordConnectStatus>;
