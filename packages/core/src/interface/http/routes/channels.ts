/** @module interface/http/routes/channels — notification channels: CRUD, pause/resume, test send, preview, the delivery log, the environment check, the Telegram connect flow, the Discord bot setup and the act-button audit (spec 03 §4.8.1). */

import {
  ActionsPage,
  ActionsQuery,
  ChannelEnvQuery,
  ChannelEnvResponse,
  ChannelIdParams,
  ChannelInput,
  ChannelPatch,
  ChannelPreview,
  ChannelPreviewRequest,
  ChannelResponse,
  ChannelsResponse,
  ChannelTestResponse,
  DeliveriesPage,
  DeliveriesQuery,
  DeliveryDetailResponse,
  DeliverySeqParams,
  DiscordBotInfo,
  DiscordBotRequest,
  DiscordChannelsRequest,
  DiscordChannelsResponse,
  DiscordConnectParams,
  DiscordConnectRequest,
  DiscordConnectResponse,
  DiscordConnectStatus,
  OkResponse,
  TelegramConnectParams,
  TelegramConnectRequest,
  TelegramConnectResponse,
  TelegramConnectStatus,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { appliedFilters } from '../serializers/page.ts';

const tags = ['channels'];

/** Channel routes. */
export const CHANNEL_ROUTES = [
  defineRoute({
    operationId: 'listChannels',
    tags,
    summary:
      'Every notification channel (dashboard and startup) with its state; never a secret value.',
    request: {},
    responses: { 200: ChannelsResponse },
    async handler({ services, ctx }) {
      return reply(200, { data: [...(await services.channels.list())], now: ctx.now });
    },
  }),
  defineRoute({
    operationId: 'createChannel',
    tags,
    summary: 'Create a channel. Secrets are environment variable names, never values (D-33).',
    request: { body: ChannelInput },
    responses: { 201: ChannelResponse },
    errors: ['CHANNEL_NAME_TAKEN', 'CHANNEL_KIND_UNAVAILABLE'],
    async handler({ input, services }) {
      return reply(201, { channel: await services.channels.create(input.body) });
    },
  }),
  defineRoute({
    operationId: 'previewChannel',
    tags,
    summary: 'Render a sample notification exactly as the channel would send it. Sends nothing.',
    request: { body: ChannelPreviewRequest },
    responses: { 200: ChannelPreview },
    errors: ['CHANNEL_NOT_FOUND', 'CHANNEL_KIND_UNAVAILABLE'],
    async handler({ input, services }) {
      return reply(200, services.channels.preview(input.body));
    },
  }),
  defineRoute({
    operationId: 'listDeliveries',
    tags,
    summary:
      'The delivery log newest first: every send, edit and delete, and why anything was not sent.',
    request: { query: DeliveriesQuery },
    responses: { 200: DeliveriesPage },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const page = await services.channels.deliveries({
        limit: q.limit,
        ...(q.cursor !== undefined && { cursor: q.cursor }),
        ...(q.channel_id !== undefined && { channelId: q.channel_id }),
        ...(q.notification_id !== undefined && { notificationId: q.notification_id }),
        ...(q.status !== undefined && { statuses: q.status }),
        ...(q.op !== undefined && { ops: q.op }),
        ...(q.kind !== undefined && { kinds: q.kind }),
      });
      return reply(200, {
        data: [...page.items],
        page: { next_cursor: page.nextCursor, limit: q.limit },
        applied: { filters: appliedFilters(q), sort: { key: 'seq', dir: 'desc' } },
        meta: { now: ctx.now },
      });
    },
  }),
  defineRoute({
    operationId: 'getDelivery',
    tags,
    summary: 'One delivery with the message as that channel is shown it (redacted).',
    request: { params: DeliverySeqParams },
    responses: { 200: DeliveryDetailResponse },
    errors: ['DELIVERY_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, await services.channels.delivery(input.params.seq));
    },
  }),
  defineRoute({
    operationId: 'checkChannelEnv',
    tags,
    summary: 'Whether each named environment variable is set in the server (never its value).',
    request: { query: ChannelEnvQuery },
    responses: { 200: ChannelEnvResponse },
    async handler({ input, services }) {
      return reply(200, { vars: services.channels.env(input.query.names) });
    },
  }),
  defineRoute({
    operationId: 'startTelegramConnect',
    tags,
    summary: 'Start the one-tap Telegram connect: a t.me link and a 2-minute wait for /start.',
    request: { body: TelegramConnectRequest },
    responses: { 200: TelegramConnectResponse },
    errors: ['CHANNEL_NOT_READY', 'CHANNEL_PLATFORM_ERROR'],
    rateLimit: { limit: 6, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      return reply(200, await services.channels.telegramConnect(input.body.token_env));
    },
  }),
  defineRoute({
    operationId: 'getTelegramConnect',
    tags,
    summary: 'State of a Telegram connect: waiting, connected (with the chat), expired or failed.',
    request: { params: TelegramConnectParams },
    responses: { 200: TelegramConnectStatus },
    async handler({ input, services }) {
      return reply(200, services.channels.telegramConnectStatus(input.params.connect_id));
    },
  }),
  defineRoute({
    operationId: 'getDiscordBot',
    tags,
    summary:
      'Who the Discord bot is, its invite link (minimal permissions) and the servers it is in.',
    request: { body: DiscordBotRequest },
    responses: { 200: DiscordBotInfo },
    errors: ['CHANNEL_NOT_READY', 'CHANNEL_PLATFORM_ERROR'],
    rateLimit: { limit: 20, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      return reply(200, await services.channels.discordBot(input.body.token_env));
    },
  }),
  defineRoute({
    operationId: 'listDiscordChannels',
    tags,
    summary: "The text channels of one of the Discord bot's servers (the channel picker).",
    request: { body: DiscordChannelsRequest },
    responses: { 200: DiscordChannelsResponse },
    errors: ['CHANNEL_NOT_READY', 'CHANNEL_PLATFORM_ERROR'],
    rateLimit: { limit: 20, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      return reply(
        200,
        await services.channels.discordChannels(input.body.token_env, input.body.guild_id),
      );
    },
  }),
  defineRoute({
    operationId: 'startDiscordConnect',
    tags,
    summary:
      'Link your Discord account: the bot posts a "This is me" button and waits 2 minutes for it.',
    request: { body: DiscordConnectRequest },
    responses: { 200: DiscordConnectResponse },
    errors: ['CHANNEL_NOT_READY', 'CHANNEL_PLATFORM_ERROR'],
    rateLimit: { limit: 6, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      return reply(
        200,
        await services.channels.discordConnect(input.body.token_env, input.body.channel_id),
      );
    },
  }),
  defineRoute({
    operationId: 'getDiscordConnect',
    tags,
    summary:
      'State of a Discord account link: waiting, connected (with the user), expired, failed.',
    request: { params: DiscordConnectParams },
    responses: { 200: DiscordConnectStatus },
    async handler({ input, services }) {
      return reply(200, services.channels.discordConnectStatus(input.params.connect_id));
    },
  }),
  defineRoute({
    operationId: 'listChannelActions',
    tags,
    summary:
      'The act-button audit newest first: who pressed what, from which chat, and the outcome.',
    request: { query: ActionsQuery },
    responses: { 200: ActionsPage },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const page = await services.channels.actions({
        limit: q.limit,
        ...(q.cursor !== undefined && { cursor: q.cursor }),
        ...(q.channel_id !== undefined && { channelId: q.channel_id }),
        ...(q.notification_id !== undefined && { notificationId: q.notification_id }),
        ...(q.outcome !== undefined && { outcomes: q.outcome }),
      });
      return reply(200, {
        data: [...page.items],
        page: { next_cursor: page.nextCursor, limit: q.limit },
        applied: { filters: appliedFilters(q), sort: { key: 'seq', dir: 'desc' } },
        meta: { now: ctx.now },
      });
    },
  }),
  defineRoute({
    operationId: 'getChannel',
    tags,
    summary: 'One channel.',
    request: { params: ChannelIdParams },
    responses: { 200: ChannelResponse },
    errors: ['CHANNEL_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, { channel: await services.channels.get(input.params.channel_id) });
    },
  }),
  defineRoute({
    operationId: 'updateChannel',
    tags,
    summary: 'Edit a dashboard channel (startup channels are read-only).',
    request: { params: ChannelIdParams, body: ChannelPatch },
    responses: { 200: ChannelResponse },
    errors: [
      'CHANNEL_NOT_FOUND',
      'CHANNEL_READ_ONLY',
      'CHANNEL_NAME_TAKEN',
      'CHANNEL_KIND_UNAVAILABLE',
    ],
    async handler({ input, services }) {
      return reply(200, {
        channel: await services.channels.update(input.params.channel_id, input.body),
      });
    },
  }),
  defineRoute({
    operationId: 'deleteChannel',
    tags,
    summary: 'Delete a dashboard channel and its delivery log.',
    request: { params: ChannelIdParams },
    responses: { 200: OkResponse },
    errors: ['CHANNEL_NOT_FOUND', 'CHANNEL_READ_ONLY'],
    async handler({ input, services }) {
      await services.channels.remove(input.params.channel_id);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'pauseChannel',
    tags,
    summary: 'Pause a channel; its pending deliveries are suppressed.',
    request: { params: ChannelIdParams },
    responses: { 200: ChannelResponse },
    errors: ['CHANNEL_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, { channel: await services.channels.pause(input.params.channel_id) });
    },
  }),
  defineRoute({
    operationId: 'resumeChannel',
    tags,
    summary: 'Resume a paused or broken channel.',
    request: { params: ChannelIdParams },
    responses: { 200: ChannelResponse },
    errors: ['CHANNEL_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, { channel: await services.channels.resume(input.params.channel_id) });
    },
  }),
  defineRoute({
    operationId: 'testChannel',
    tags,
    summary: 'Send a real test message through the channel now; the result says why it failed.',
    request: { params: ChannelIdParams },
    responses: { 200: ChannelTestResponse },
    errors: ['CHANNEL_NOT_FOUND', 'CHANNEL_NOT_READY'],
    rateLimit: { limit: 10, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      return reply(200, await services.channels.test(input.params.channel_id));
    },
  }),
];
