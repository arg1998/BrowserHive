/** @module infra/notifications/ntfy — the ntfy adapter (spec 03 §9.5): a pure renderer to a JSON publish (or a `PUT` upload when a screenshot is attached) with priority, tags, click and `view` actions, and the transport (send, replace by sequence id, delete). */

import type { Block, NotificationMessage } from '@browserhive/contracts/notifications';
import { NTFY_DEFAULT_SERVER } from '@browserhive/contracts/notifications';
import {
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelRenderer,
  ChannelSendError,
  type ChannelSendResult,
  type NotificationChannel,
  type NotificationImageReader,
  type PlatformMessageRef,
  type RenderContext,
  type RenderedRequest,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import { callPlatform, type FetchFn, type PlatformAnswer, substituteSecrets } from './http.ts';
import {
  bodyBlocks,
  clipText,
  firstImage,
  LOCAL_LINKS_LABEL,
  openLinks,
  plainRun,
  SCREENSHOT_FILENAME,
} from './render-common.ts';

/** ntfy turns a message longer than 4096 bytes into an attachment; stay well below. */
export const NTFY_MESSAGE_MAX_BYTES = 4000;
/** ntfy allows three action buttons. */
export const NTFY_ACTIONS_MAX = 3;

/**
 * What the ntfy renderer supports: a screenshot, three `view` actions, replace and delete. Rich
 * blocks arrive as blocks and the renderer writes them as plain text itself (fields one per line,
 * quotes in quotation marks), which reads better than `degrade`'s generic flattening.
 */
export const NTFY_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: false,
  images: true,
  actButtons: false,
  openLinks: true,
  edit: true,
  delete: true,
  replies: false,
  deleteWindowMs: null,
  maxTitleChars: 250,
  maxTextChars: 3500,
  maxButtons: NTFY_ACTIONS_MAX,
};

/** ntfy priority: info 3, warn and error 4, critical 5; silent revisions 2 (no sound). */
export function ntfyPriority(message: Pick<NotificationMessage, 'severity' | 'alert'>): number {
  if (!message.alert) return 2;
  switch (message.severity) {
    case 'info':
      return 3;
    case 'warn':
    case 'error':
      return 4;
    case 'critical':
      return 5;
  }
}

/** ntfy tags (emoji short codes): the outcome once settled, else the severity. */
export function ntfyTags(message: Pick<NotificationMessage, 'severity' | 'state'>): string[] {
  if (message.state === 'resolved') return ['white_check_mark'];
  if (message.state === 'expired') return ['hourglass'];
  switch (message.severity) {
    case 'info':
      return ['information_source'];
    case 'warn':
      return ['warning'];
    case 'error':
      return ['rotating_light'];
    case 'critical':
      return ['sos'];
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'text':
    case 'footer':
      return plainRun(b.content);
    case 'heading':
      return b.text;
    case 'fields':
      return b.items.map((i) => `${i.label}: ${plainRun(i.value)}`).join('\n');
    case 'quote':
      return `“${plainRun(b.content)}”`;
    case 'list':
      return b.items
        .map((item, n) => `${b.ordered ? `${n + 1}.` : '•'} ${plainRun(item)}`)
        .join('\n');
    case 'code':
      return b.text;
    case 'table':
    case 'image':
    case 'divider':
      return '';
  }
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8, on a character boundary, with an ellipsis.
 *
 * @returns The clipped text.
 */
export function clipBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  let used = 0;
  const budget = maxBytes - 3;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return `${out}…`;
}

/** The plain-text body of a message: summary, then the blocks. */
export function ntfyText(message: NotificationMessage): string {
  const parts: string[] = [];
  if (message.summary.trim() !== '' && message.summary !== message.title)
    parts.push(message.summary);
  for (const b of bodyBlocks(message)) {
    const text = blockText(b);
    if (text !== '') parts.push(text);
  }
  return clipBytes(parts.join('\n\n'), NTFY_MESSAGE_MAX_BYTES);
}

interface ViewAction {
  action: 'view';
  label: string;
  url: string;
  clear: boolean;
}

/**
 * The topic of a channel as rendered: the literal topic, or `{secret:topic}` when it lives in a
 * variable (the transport substitutes it; the preview shows the variable's name).
 */
function topicOf(target: Readonly<Record<string, string>>): string {
  const literal = target['topic'];
  return literal !== undefined && literal !== '' ? literal : '{secret:topic}';
}

/**
 * The ntfy renderer. Without a screenshot: `POST /` JSON `{topic, title, message, priority, tags,
 * click, actions, markdown: false, sequence_id}`. With one: `PUT /<topic>/<sequence_id>` with the
 * JPEG as the body and the fields as query parameters (`actions` as JSON). The sequence id is the
 * notification id, so a revision replaces the phone's notification.
 */
export const ntfyRenderer: ChannelRenderer = {
  kind: 'ntfy',
  capabilities: () => NTFY_CAPABILITIES,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    const { message, links } = delivery;
    const topic = topicOf(context.target);
    const sequence =
      context.op === 'edit' && context.ref !== null && context.ref['sequence_id'] !== undefined
        ? String(context.ref['sequence_id'])
        : message.id;
    const resolved = openLinks(message, links).slice(0, NTFY_ACTIONS_MAX);
    const actions: ViewAction[] = resolved.map((l, i) => ({
      action: 'view',
      label: links.local && i === 0 ? LOCAL_LINKS_LABEL : clipText(l.label, 40),
      url: l.url,
      clear: false,
    }));
    const fields = {
      title: clipText(message.title, NTFY_CAPABILITIES.maxTitleChars),
      message: ntfyText(message),
      priority: ntfyPriority(message),
      tags: ntfyTags(message),
      ...(resolved[0] !== undefined && { click: resolved[0].url }),
      ...(actions.length > 0 && { actions }),
    };
    const image = firstImage(message);
    if (image !== null) {
      return [
        {
          method: 'PUT',
          path: `/${topic}/${sequence}`,
          encoding: 'binary',
          body: { ...fields, filename: SCREENSHOT_FILENAME },
          headers: {},
          file: { ref: image.ref, name: SCREENSHOT_FILENAME, content_type: 'image/jpeg' },
        },
      ];
    }
    return [
      {
        method: 'POST',
        path: '/',
        encoding: 'json',
        body: { topic, ...fields, markdown: false, sequence_id: sequence },
        headers: {},
        file: null,
      },
    ];
  },
};

/**
 * The query string of a binary (upload) publish: every field as text, lists comma-joined, the
 * actions as JSON.
 *
 * @returns `?title=…&message=…`.
 */
export function ntfyQuery(fields: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (key === 'actions') params.set(key, JSON.stringify(value));
    else if (Array.isArray(value)) params.set(key, value.join(','));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** What the ntfy transport needs besides the channel row. */
export interface NtfyChannelDeps {
  /** Access token, when the server or topic is protected. */
  readonly token: string | null;
  /** The topic from a variable (when `target.topic` is empty). */
  readonly topic: string | null;
  readonly images: NotificationImageReader;
  readonly fetch?: FetchFn;
}

function refOf(answer: PlatformAnswer, sequence: string): PlatformMessageRef {
  const json = answer.json as Record<string, unknown> | null;
  const id = json?.['id'];
  return {
    ...(typeof id === 'string' && { id }),
    sequence_id: typeof json?.['sequence_id'] === 'string' ? json['sequence_id'] : sequence,
  };
}

/**
 * An ntfy channel. The ref stores the sequence id (never the topic, which may be a secret); the
 * transport knows the topic.
 *
 * @returns The adapter.
 */
export function createNtfyChannel(
  record: NotificationChannelRecord,
  deps: NtfyChannelDeps,
): NotificationChannel {
  const server = (record.target['server'] ?? NTFY_DEFAULT_SERVER).replace(/\/+$/, '');
  const literal = record.target['topic'];
  const topic = literal !== undefined && literal !== '' ? literal : deps.topic;
  if (topic === null || topic === '') throw new Error(`channel '${record.name}' has no ntfy topic`);
  const resolvedTopic: string = topic;
  const secrets = [
    ...(deps.token === null ? [] : [deps.token]),
    ...(deps.topic === null ? [] : [deps.topic]),
  ];
  const options = { fetch: deps.fetch ?? fetch, secrets, platform: 'ntfy' };
  const auth: Record<string, string> =
    deps.token === null ? {} : { authorization: `Bearer ${deps.token}` };
  const context = (op: 'send' | 'edit', ref: PlatformMessageRef | null): RenderContext => ({
    mode: null,
    target: record.target,
    op,
    ref,
    actToken: () => {
      throw new ChannelSendError('rejected', 'act buttons are not available on ntfy yet');
    },
  });

  async function publish(request: RenderedRequest): Promise<PlatformAnswer> {
    const path = substituteSecrets(request.path, { topic: resolvedTopic });
    if (request.encoding === 'binary' && request.file !== null) {
      const image = await deps.images.read(request.file.ref);
      if (image !== null) {
        return callPlatform(
          {
            url: `${server}${path}${ntfyQuery(request.body)}`,
            method: 'PUT',
            headers: { ...auth, 'content-type': image.contentType },
            body: new Blob([new Uint8Array(image.bytes)], { type: image.contentType }),
          },
          options,
        );
      }
      // The screenshot is gone (pruned): publish the text alone, keeping the sequence id.
      const [, , sequence = ''] = path.split('/');
      const { filename: _dropped, ...fields } = request.body;
      return callPlatform(
        {
          url: `${server}/`,
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            topic: resolvedTopic,
            ...fields,
            markdown: false,
            sequence_id: sequence,
          }),
        },
        options,
      );
    }
    const body = { ...request.body, topic: resolvedTopic };
    return callPlatform(
      {
        url: `${server}${path}`,
        method: request.method,
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      options,
    );
  }

  return {
    id: record.channelId,
    name: record.name,
    kind: 'ntfy',
    capabilities: NTFY_CAPABILITIES,
    async send(delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = ntfyRenderer.render(delivery, context('send', null));
      if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
      return { ref: refOf(await publish(request), delivery.message.id) };
    },
    async edit(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = ntfyRenderer.render(delivery, context('edit', ref));
      if (request === undefined) return { ref };
      const sequence = String(ref['sequence_id'] ?? delivery.message.id);
      return { ref: refOf(await publish(request), sequence) };
    },
    async delete(ref: PlatformMessageRef): Promise<void> {
      const sequence = String(ref['sequence_id'] ?? '');
      if (sequence === '') throw new ChannelSendError('message_gone', 'ntfy: no sequence id');
      await callPlatform(
        {
          url: `${server}/${encodeURIComponent(resolvedTopic)}/${encodeURIComponent(sequence)}`,
          method: 'DELETE',
          headers: auth,
          addressesMessage: true,
        },
        options,
      );
    },
  };
}
