/** @module infra/notifications/discord — the Discord adapter (spec 03 §9.5, D-38, D-40, D-41): a pure renderer to one embed plus action rows (link buttons; interactive act buttons in bot mode), the webhook transport (send with `?wait=true`, edit keeping the screenshot, delete) and the bot transport (the same through the bot REST API, presses over the gateway). */

import type { Block, Inline, NotificationMessage } from '@browserhive/contracts/notifications';
import {
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelRenderer,
  ChannelSendError,
  type ChannelSendResult,
  type ChannelSetup,
  type LinkBuilder,
  type NotificationChannel,
  type NotificationImageReader,
  type PlatformMessageRef,
  type PressSource,
  type RenderContext,
  type RenderedRequest,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import { DISCORD_API_BASE, type DiscordGatewayHub } from './discord-gateway.ts';
import {
  callPlatform,
  type FailureRefiner,
  type FetchFn,
  multipart,
  type PlatformAnswer,
  substituteSecrets,
} from './http.ts';
import {
  bodyBlocks,
  clipText,
  firstImage,
  LOCAL_LINKS_LABEL,
  openLinks,
  SCREENSHOT_FILENAME,
  severityMark,
} from './render-common.ts';

/** Discord's embed limits. */
export const DISCORD_LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  total: 6000,
  buttonsPerRow: 5,
  buttonLabel: 80,
} as const;

/** Webhook mode: link buttons only (D-38). */
export const DISCORD_WEBHOOK_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: false,
  charts: false,
  images: true,
  actButtons: false,
  openLinks: true,
  edit: true,
  delete: true,
  replies: false,
  deleteWindowMs: null,
  maxTitleChars: 120,
  maxTextChars: 3500,
  maxButtons: 5,
};

/** Bot mode with act buttons on: interactive buttons, presses over the gateway (D-38, D-41). */
export const DISCORD_BOT_CAPABILITIES: ChannelCapabilities = {
  ...DISCORD_WEBHOOK_CAPABILITIES,
  actButtons: true,
};

/** Embed colour per severity, and for settled states. */
export function discordColor(message: Pick<NotificationMessage, 'severity' | 'state'>): number {
  if (message.state === 'resolved') return 0x22c55e;
  if (message.state === 'expired') return 0x6b7280;
  switch (message.severity) {
    case 'info':
      return 0x3b82f6;
    case 'warn':
      return 0xf59e0b;
    case 'error':
      return 0xef4444;
    case 'critical':
      return 0xd946ef;
  }
}

/**
 * Escapes Discord markdown (and mention/timestamp syntax) in user text. A heading, list or quote
 * marker is escaped only where a line starts (`lineStart` says whether the text itself begins a
 * line); an ordered-list marker is escaped on its dot (`1\.`), since a backslash before a digit
 * shows as a backslash.
 */
export function escapeMarkdown(text: string, lineStart = true): string {
  return text
    .replace(/([\\*_~`|<>[\]()])/g, '\\$1')
    .replace(
      /(^|\n)(\s*)(?:([#+-])|(\d+)\.)/g,
      (match, nl: string, ws: string, mark, digits, offset: number) => {
        if (offset === 0 && nl === '' && !lineStart) return match;
        return mark !== undefined ? `${nl}${ws}\\${mark}` : `${nl}${ws}${digits}\\.`;
      },
    );
}

function inlineNode(node: Inline, links: LinkBuilder, lineStart: boolean): string {
  switch (node.type) {
    case 'text':
      return escapeMarkdown(node.text, lineStart);
    case 'bold':
      return `**${escapeMarkdown(node.text)}**`;
    case 'italic':
      return `*${escapeMarkdown(node.text)}*`;
    case 'code':
      return `\`${node.text.replace(/`/g, 'ʼ')}\``;
    case 'link':
      return links.local
        ? escapeMarkdown(node.text, lineStart)
        : `[${escapeMarkdown(node.text)}](${links.url(node.path).replace(/\)/g, '%29')})`;
    case 'time':
      return `<t:${Math.floor(node.at / 1000)}:${node.style === 'relative' ? 'R' : 't'}>`;
  }
}

function inline(run: readonly Inline[], links: LinkBuilder): string {
  return run.map((node, i) => inlineNode(node, links, i === 0)).join('');
}

function block(b: Block, links: LinkBuilder): string {
  switch (b.type) {
    case 'text':
      return inline(b.content, links);
    case 'heading':
      return `**${escapeMarkdown(b.text)}**`;
    case 'fields':
      return b.items
        .map((i) => `**${escapeMarkdown(i.label)}:** ${inline(i.value, links)}`)
        .join('\n');
    case 'quote':
      return inline(b.content, links)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'list':
      return b.items
        .map((item, n) => `${b.ordered ? `${n + 1}.` : '-'} ${inline(item, links)}`)
        .join('\n');
    case 'code': {
      const lang =
        b.language !== null && /^[A-Za-z0-9_+-]{1,32}$/.test(b.language) ? b.language : '';
      return `\`\`\`${lang}\n${b.text.replace(/```/g, "'''")}\n\`\`\``;
    }
    case 'footer':
      return `-# ${inline(b.content, links)}`;
    case 'table':
    case 'image':
    case 'divider':
    case 'chart':
      return '';
  }
}

interface Embed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  image?: { url: string };
  footer: { text: string };
  timestamp: string;
}

/** The embed of a message (limits enforced). */
export function discordEmbed(
  message: NotificationMessage,
  links: LinkBuilder,
  imageName: string | null,
): Embed {
  const title = clipText(`${severityMark(message)} ${message.title}`, DISCORD_LIMITS.title);
  const fields: { name: string; value: string; inline: boolean }[] = [];
  const paragraphs: string[] = [];
  if (message.summary.trim() !== '' && message.summary !== message.title) {
    paragraphs.push(escapeMarkdown(message.summary));
  }
  for (const b of bodyBlocks(message)) {
    if (b.type === 'fields') {
      for (const item of b.items) {
        const value = clipText(inline(item.value, links) || '—', DISCORD_LIMITS.fieldValue);
        if (fields.length < DISCORD_LIMITS.fields) {
          fields.push({
            name: clipText(item.label, DISCORD_LIMITS.fieldName),
            value,
            inline: true,
          });
        } else {
          paragraphs.push(`**${escapeMarkdown(item.label)}:** ${value}`);
        }
      }
      continue;
    }
    const text = block(b, links);
    if (text !== '') paragraphs.push(text);
  }
  if (links.local) {
    const resolved = openLinks(message, links);
    if (resolved.length > 0) {
      paragraphs.push(
        [
          `**🖥 ${LOCAL_LINKS_LABEL}**`,
          ...resolved.map((l) => `${escapeMarkdown(l.label)}: \`${l.url}\``),
        ].join('\n'),
      );
    }
  }
  const footer = 'BrowserHive';
  const first = openLinks(message, links)[0];
  // Keep the whole embed under the 6000-character total: fields go first, then the description.
  let budget = DISCORD_LIMITS.total - title.length - footer.length;
  const kept: typeof fields = [];
  for (const f of fields) {
    const cost = f.name.length + f.value.length;
    if (cost > budget - 200) break;
    kept.push(f);
    budget -= cost;
  }
  const description = clipText(
    paragraphs.join('\n\n'),
    Math.min(DISCORD_LIMITS.description, Math.max(0, budget)),
  );
  return {
    title,
    ...(description !== '' && { description }),
    ...(!links.local && first !== undefined && { url: first.url }),
    color: discordColor(message),
    ...(kept.length > 0 && { fields: kept }),
    ...(imageName !== null && { image: { url: `attachment://${imageName}` } }),
    footer: { text: footer },
    timestamp: new Date(message.at.updated).toISOString(),
  };
}

type Button =
  | { type: 2; style: 5; label: string; url: string }
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string };

/**
 * Action rows: link buttons, and in bot mode interactive act buttons (an affirmative answer green,
 * a destructive one red, others grey). Act actions survive `degrade` only where presses arrive.
 */
export function discordComponents(
  message: NotificationMessage,
  links: LinkBuilder,
  context: RenderContext,
): { type: 1; components: Button[] }[] {
  const buttons: Button[] = [];
  for (const action of message.actions) {
    const label = clipText(action.label, DISCORD_LIMITS.buttonLabel);
    if (action.kind === 'open') {
      if (!links.local) buttons.push({ type: 2, style: 5, label, url: links.url(action.path) });
    } else if (context.mode === 'bot') {
      const style = action.style === 'primary' ? 3 : action.style === 'danger' ? 4 : 2;
      buttons.push({ type: 2, style, label, custom_id: context.actToken(action.id) });
    }
  }
  const rows: { type: 1; components: Button[] }[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += DISCORD_LIMITS.buttonsPerRow) {
    rows.push({ type: 1, components: buttons.slice(i, i + DISCORD_LIMITS.buttonsPerRow) });
  }
  return rows;
}

/**
 * The capabilities of a Discord channel: act buttons in bot mode when its rules switch them on.
 *
 * @returns The capabilities.
 */
export function discordCapabilities(
  setup: Pick<ChannelSetup, 'mode' | 'rules'>,
): ChannelCapabilities {
  return setup.mode === 'bot' && setup.rules.act_buttons === true
    ? DISCORD_BOT_CAPABILITIES
    : DISCORD_WEBHOOK_CAPABILITIES;
}

/** Where a request goes: the webhook URL (`{secret:webhook}`), or the bot API channel path. */
function messagesPath(context: RenderContext): string {
  if (context.mode === 'bot') {
    return `/channels/${context.target['channel_id'] ?? '{channel_id}'}/messages`;
  }
  return '{secret:webhook}';
}

/**
 * The Discord renderer. Webhook sends go to `{secret:webhook}?wait=true&with_components=true`
 * (the path placeholder is the secret webhook URL); bot sends to `/channels/{id}/messages`. A
 * screenshot makes the request multipart (`payload_json` + `files[0]`, shown as the embed image).
 * Edits `PATCH …/messages/{id}` list the attachment to keep.
 */
export const discordRenderer: ChannelRenderer = {
  kind: 'discord',
  capabilities: discordCapabilities,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    const { message, links } = delivery;
    const bot = context.mode === 'bot';
    const image = firstImage(message);
    const components = discordComponents(message, links, context);
    const base = {
      content: null,
      allowed_mentions: { parse: [] as string[] },
      components,
    };
    if (context.op === 'edit' && context.ref !== null) {
      const kept = context.ref['attachment_id'];
      const keptName = context.ref['attachment_name'];
      const path = bot
        ? `${messagesPath(context)}/${context.ref['message_id']}`
        : `{secret:webhook}/messages/${context.ref['message_id']}?with_components=true`;
      if (image !== null && kept !== undefined) {
        const name = String(keptName ?? SCREENSHOT_FILENAME);
        return [
          {
            method: 'PATCH',
            path,
            encoding: 'json',
            body: {
              ...base,
              embeds: [discordEmbed(message, links, name)],
              attachments: [{ id: String(kept) }],
            },
            headers: {},
            file: null,
          },
        ];
      }
      if (image !== null) {
        return [
          {
            method: 'PATCH',
            path,
            encoding: 'multipart',
            body: {
              payload_json: {
                ...base,
                embeds: [discordEmbed(message, links, SCREENSHOT_FILENAME)],
                attachments: [{ id: 0, filename: SCREENSHOT_FILENAME }],
              },
            },
            headers: {},
            file: { ref: image.ref, name: SCREENSHOT_FILENAME, content_type: 'image/jpeg' },
          },
        ];
      }
      return [
        {
          method: 'PATCH',
          path,
          encoding: 'json',
          body: { ...base, embeds: [discordEmbed(message, links, null)], attachments: [] },
          headers: {},
          file: null,
        },
      ];
    }
    const path = bot ? messagesPath(context) : '{secret:webhook}?wait=true&with_components=true';
    if (image !== null) {
      return [
        {
          method: 'POST',
          path,
          encoding: 'multipart',
          body: {
            payload_json: {
              ...base,
              embeds: [discordEmbed(message, links, SCREENSHOT_FILENAME)],
              attachments: [{ id: 0, filename: SCREENSHOT_FILENAME }],
            },
          },
          headers: {},
          file: { ref: image.ref, name: SCREENSHOT_FILENAME, content_type: 'image/jpeg' },
        },
      ];
    }
    return [
      {
        method: 'POST',
        path,
        encoding: 'json',
        body: { ...base, embeds: [discordEmbed(message, links, null)] },
        headers: {},
        file: null,
      },
    ];
  },
};

/** A deleted webhook (`10015 Unknown Webhook`) is a credential problem, not a gone message. */
export const refineDiscord: FailureRefiner = (answer) => {
  const code =
    answer.json !== null && typeof answer.json === 'object'
      ? Reflect.get(answer.json, 'code')
      : null;
  if (code === 10015) return new ChannelSendError('auth', 'Discord: the webhook no longer exists');
  if (code === 10008) return new ChannelSendError('message_gone', `Discord: ${answer.detail}`);
  if (code === 50035) {
    // "Invalid Form Body": name the first field Discord refused (it never holds a secret).
    const where = firstFormError(
      answer.json !== null && typeof answer.json === 'object'
        ? Reflect.get(answer.json, 'errors')
        : null,
      [],
    );
    if (where !== null) {
      return new ChannelSendError(
        'rejected',
        `Discord ${answer.status}: ${answer.detail} (${where})`,
      );
    }
  }
  return null;
};

/** The first `path: message` of a Discord form-error tree (`{components: {0: {_errors: […]}}}`). */
function firstFormError(node: unknown, path: readonly string[]): string | null {
  if (node === null || typeof node !== 'object') return null;
  const errors = Reflect.get(node, '_errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const message = Reflect.get(errors[0] as object, 'message');
    return `${path.join('.') || 'body'}: ${typeof message === 'string' ? message.slice(0, 120) : 'invalid'}`;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '_errors') continue;
    const found = firstFormError(value, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

/** What the Discord transport needs besides the channel row. */
export interface DiscordChannelDeps {
  /** Webhook mode: the webhook URL (resolved from the channel's `webhook` variable). */
  readonly webhookUrl?: string;
  /** Bot mode: the bot token (resolved from the channel's `token` variable). */
  readonly botToken?: string;
  readonly images: NotificationImageReader;
  readonly fetch?: FetchFn;
  /** Bot REST base; the fakes pass their own. */
  readonly apiBase?: string;
  /** Bot mode: the gateway connections; the channel's presses arrive through them (D-41). */
  readonly gateway?: DiscordGatewayHub;
}

/**
 * Joins the webhook URL with a rendered path suffix (`/messages/1?with_components=true`), merging
 * query parameters (a webhook URL may carry `?thread_id=`).
 *
 * @returns The absolute URL.
 */
export function webhookUrlFor(webhook: string, rendered: string): string {
  const suffix = rendered.replace(/^\{secret:webhook\}/, '');
  const [path = '', query = ''] = suffix.split('?');
  const url = new URL(webhook);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  for (const [k, v] of new URLSearchParams(query)) url.searchParams.set(k, v);
  return url.toString();
}

function refOf(answer: PlatformAnswer, previous: PlatformMessageRef | null): PlatformMessageRef {
  const json = answer.json as Record<string, unknown> | null;
  const id = json?.['id'];
  if (typeof id !== 'string') {
    if (previous !== null) return previous;
    throw new ChannelSendError('rejected', 'Discord answered without a message id');
  }
  const attachments = Array.isArray(json?.['attachments'])
    ? (json?.['attachments'] as unknown[])
    : [];
  const first = attachments[0] as Record<string, unknown> | undefined;
  return {
    message_id: id,
    ...(typeof json?.['channel_id'] === 'string' && { channel_id: json['channel_id'] }),
    ...(typeof first?.['id'] === 'string' && { attachment_id: first['id'] }),
    ...(typeof first?.['filename'] === 'string' && { attachment_name: first['filename'] }),
  };
}

/**
 * A Discord channel. Webhook mode posts through the webhook URL; bot mode through the bot REST API
 * (`Authorization: Bot …`) and, with act buttons on, listens for presses over the gateway (D-38).
 *
 * @returns The adapter.
 */
export function createDiscordChannel(
  record: NotificationChannelRecord,
  deps: DiscordChannelDeps,
): NotificationChannel {
  const bot = record.mode === 'bot';
  let webhookUrl = '';
  let botToken = '';
  const apiBase = (deps.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, '');
  if (bot) {
    botToken = deps.botToken ?? '';
    if (botToken === '') throw new Error(`channel '${record.name}' has no bot token`);
    if ((record.target['channel_id'] ?? '') === '') {
      throw new Error(`channel '${record.name}' names no Discord channel`);
    }
  } else {
    webhookUrl = deps.webhookUrl ?? '';
    try {
      const parsed = new URL(webhookUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
    } catch {
      throw new Error(`the webhook variable of channel '${record.name}' does not hold a URL`);
    }
  }
  const capabilities = discordCapabilities(record);
  const options = {
    fetch: deps.fetch ?? fetch,
    secrets: bot ? [botToken] : [webhookUrl, new URL(webhookUrl).pathname],
    platform: 'Discord',
    refine: refineDiscord,
  };
  const auth: Record<string, string> = bot ? { authorization: `Bot ${botToken}` } : {};
  const context = (
    op: 'send' | 'edit',
    ref: PlatformMessageRef | null,
    delivery: ChannelDelivery,
  ): RenderContext => ({
    mode: bot ? 'bot' : 'webhook',
    target: record.target,
    op,
    ref,
    actToken: (id) => {
      const payload = delivery.actTokens?.get(id);
      if (payload === undefined)
        throw new ChannelSendError('rejected', 'act button without a token');
      return payload;
    },
  });
  const urlOf = (path: string) =>
    bot ? `${apiBase}${path}` : webhookUrlFor(webhookUrl, substituteSecrets(path, {}));

  async function perform(
    request: RenderedRequest,
    addressesMessage: boolean,
  ): Promise<PlatformAnswer> {
    const url = urlOf(request.path);
    if (request.encoding === 'multipart') {
      const payload = request.body['payload_json'] as Record<string, unknown>;
      const image = request.file === null ? null : await deps.images.read(request.file.ref);
      if (image === null || request.file === null) {
        // The screenshot is gone (pruned): send the embed without it.
        const embeds = (payload['embeds'] as Record<string, unknown>[]).map(
          ({ image: _dropped, ...rest }) => rest,
        );
        return callPlatform(
          {
            url,
            method: request.method,
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, embeds, attachments: [] }),
            addressesMessage,
          },
          options,
        );
      }
      return callPlatform(
        {
          url,
          method: request.method,
          headers: auth,
          body: multipart(
            { payload_json: payload },
            {
              field: 'files[0]',
              bytes: image.bytes,
              name: request.file.name,
              type: image.contentType,
            },
          ),
          addressesMessage,
        },
        options,
      );
    }
    return callPlatform(
      {
        url,
        method: request.method,
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        addressesMessage,
      },
      options,
    );
  }

  const presses: PressSource | undefined =
    bot && capabilities.actButtons && deps.gateway !== undefined
      ? deps.gateway.pressSource(botToken, String(record.target['channel_id']))
      : undefined;

  return {
    id: record.channelId,
    name: record.name,
    kind: 'discord',
    capabilities,
    ...(presses !== undefined && { presses }),
    async send(delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = discordRenderer.render(delivery, context('send', null, delivery));
      if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
      return { ref: refOf(await perform(request, false), null) };
    },
    async edit(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = discordRenderer.render(delivery, context('edit', ref, delivery));
      if (request === undefined) return { ref };
      return { ref: refOf(await perform(request, true), ref) };
    },
    async delete(ref: PlatformMessageRef): Promise<void> {
      const path = bot
        ? `/channels/${record.target['channel_id']}/messages/${ref['message_id']}`
        : `/messages/${ref['message_id']}`;
      await callPlatform(
        {
          url: bot ? `${apiBase}${path}` : webhookUrlFor(webhookUrl, path),
          method: 'DELETE',
          headers: auth,
          addressesMessage: true,
        },
        options,
      );
    },
  };
}
