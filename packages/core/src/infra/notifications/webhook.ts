/** @module infra/notifications/webhook — the generic webhook adapter (spec 03 §9.5, D-32): posts the `NotificationMessage` contract itself in a small envelope, signed with HMAC-SHA256 when a secret is set; operator-supplied URLs get no scheme or host changing redirects. */

import { createHmac } from 'node:crypto';
import { NOTIFICATION_SCHEMA_VERSION } from '@browserhive/contracts/notifications';
import {
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelRenderer,
  ChannelSendError,
  type ChannelSendResult,
  type NotificationChannel,
  type PlatformMessageRef,
  type RenderContext,
  type RenderedRequest,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import { callPlatform, type FetchFn } from './http.ts';

/** Header carrying `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const SIGNATURE_HEADER = 'X-BrowserHive-Signature';
/** Header carrying the send time (epoch ms), so a receiver can refuse replays. */
export const TIMESTAMP_HEADER = 'X-BrowserHive-Timestamp';

/** What the generic webhook supports: the whole contract, no images, no delete. */
export const WEBHOOK_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: true,
  images: false,
  actButtons: false,
  openLinks: true,
  edit: true,
  delete: false,
  replies: false,
  deleteWindowMs: null,
  maxTitleChars: 120,
  maxTextChars: 100_000,
  maxButtons: 5,
};

/** The URL of the channel as rendered: the literal URL, or `{secret:url}` from a variable. */
function urlOf(target: Readonly<Record<string, string>>): string {
  const literal = target['url'];
  return literal !== undefined && literal !== '' ? literal : '{secret:url}';
}

/**
 * The webhook renderer: `POST <url>` with `{schema, event: 'notification', op, delivered_at,
 * channel, links, local_links, message}`. `channel` and `delivered_at` are filled by the transport
 * at send time (the renderer is pure, so the preview shows `null` and the message's update time).
 */
export const webhookRenderer: ChannelRenderer = {
  kind: 'webhook',
  capabilities: () => WEBHOOK_CAPABILITIES,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    const { message, links } = delivery;
    const linkMap: Record<string, string> = {};
    for (const action of message.actions) {
      if (action.kind === 'open') linkMap[action.id] = links.url(action.path);
      else linkMap[action.id] = links.url(action.fallback.path);
    }
    return [
      {
        method: 'POST',
        path: urlOf(context.target),
        encoding: 'json',
        body: {
          schema: NOTIFICATION_SCHEMA_VERSION,
          event: 'notification',
          op: context.op,
          delivered_at: message.at.updated,
          channel: null,
          links: linkMap,
          local_links: links.local,
          message,
        },
        headers: {},
        file: null,
      },
    ];
  },
};

/**
 * The signature of a raw body: `sha256=<hex>`.
 *
 * @returns The header value.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** What the webhook transport needs besides the channel row. */
export interface WebhookChannelDeps {
  /** The URL from a variable (when `target.url` is empty). */
  readonly url: string | null;
  /** The HMAC key, or `null` for unsigned posts. */
  readonly secret: string | null;
  readonly fetch?: FetchFn;
  /** Send time (epoch ms); defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * A generic webhook channel. Only `http:`/`https:` URLs are accepted; a redirect is followed only
 * when it keeps the scheme and host. Private addresses are allowed (the caller warns).
 *
 * @returns The adapter.
 */
export function createWebhookChannel(
  record: NotificationChannelRecord,
  deps: WebhookChannelDeps,
): NotificationChannel {
  const literal = record.target['url'];
  const target = literal !== undefined && literal !== '' ? literal : deps.url;
  if (target === null || target === '') throw new Error(`channel '${record.name}' has no URL`);
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`channel '${record.name}' has an invalid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`channel '${record.name}': only http and https URLs are allowed`);
  }
  const secrets = [
    ...(deps.url === null ? [] : [deps.url]),
    ...(deps.secret === null ? [] : [deps.secret]),
  ];
  const options = { fetch: deps.fetch ?? fetch, secrets, platform: 'Webhook' };
  const now = deps.now ?? Date.now;

  async function post(
    delivery: ChannelDelivery,
    op: 'send' | 'edit',
    ref: PlatformMessageRef | null,
  ) {
    const context: RenderContext = {
      mode: null,
      target: record.target,
      op,
      ref,
      actToken: () => {
        throw new ChannelSendError('rejected', 'webhooks carry no act buttons');
      },
    };
    const [request] = webhookRenderer.render(delivery, context);
    if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
    const sentAt = now();
    const body = JSON.stringify({
      ...request.body,
      delivered_at: sentAt,
      channel: { id: record.channelId, name: record.name },
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (deps.secret !== null) {
      headers[TIMESTAMP_HEADER] = String(sentAt);
      headers[SIGNATURE_HEADER] = signBody(deps.secret, body);
    }
    await callPlatform(
      { url: parsed.toString(), method: 'POST', headers, body, redirects: 'same-origin' },
      options,
    );
  }

  return {
    id: record.channelId,
    name: record.name,
    kind: 'webhook',
    capabilities: WEBHOOK_CAPABILITIES,
    async send(delivery: ChannelDelivery): Promise<ChannelSendResult> {
      await post(delivery, 'send', null);
      return { ref: { notification_id: delivery.message.id, revision: delivery.message.revision } };
    },
    async edit(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult> {
      await post(delivery, 'edit', ref);
      return { ref: { notification_id: delivery.message.id, revision: delivery.message.revision } };
    },
  };
}
