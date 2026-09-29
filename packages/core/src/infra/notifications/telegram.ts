/** @module infra/notifications/telegram — the Telegram Bot API adapter (spec 03 §9.5, D-40): a pure renderer to classic `sendMessage`/`sendPhoto` with `parse_mode: HTML` and an inline keyboard, plus the transport (send, edit text or caption, delete within 48 h). */

import type { Block, Inline, NotificationMessage } from '@browserhive/contracts/notifications';
import { TELEGRAM_DELETE_WINDOW_MS } from '@browserhive/contracts/notifications';
import {
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelRenderer,
  ChannelSendError,
  type ChannelSendResult,
  type LinkBuilder,
  type NotificationChannel,
  type NotificationImageReader,
  type PlatformMessageRef,
  type RenderContext,
  type RenderedRequest,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import {
  callPlatform,
  type FailureRefiner,
  type FetchFn,
  multipart,
  type PlatformAnswer,
} from './http.ts';
import {
  bodyBlocks,
  clipText,
  firstImage,
  LOCAL_LINKS_LABEL,
  openLinks,
  SCREENSHOT_FILENAME,
  severityMark,
  utcTime,
} from './render-common.ts';

/** Public Bot API base. */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Visible characters of a text message (after entity parsing). */
export const TELEGRAM_TEXT_MAX = 4096;
/** Visible characters of a photo caption. */
export const TELEGRAM_CAPTION_MAX = 1024;
/** Buttons per keyboard row: two keep labels like "Open in BrowserHive" readable on a phone. */
const BUTTONS_PER_ROW = 2;

/**
 * What the Telegram renderer supports. Rich blocks render natively (bold headings and labels,
 * expandable quotes, `<pre>`); tables become lists through `degrade`. The text budget leaves
 * room for the title line and the keyboard-less link section; a caption is clipped to 1024 by the
 * renderer itself.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: false,
  images: true,
  actButtons: false,
  openLinks: true,
  edit: true,
  delete: true,
  replies: true,
  deleteWindowMs: TELEGRAM_DELETE_WINDOW_MS,
  maxTitleChars: 120,
  maxTextChars: 3500,
  maxButtons: 6,
};

/** Escapes text for Telegram HTML: only `<`, `>` and `&` (spec 03 §9.5). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/** A rendered fragment and its visible length. */
interface Frag {
  readonly html: string;
  readonly visible: number;
}

const EMPTY: Frag = { html: '', visible: 0 };

function frag(html: string, visible: number): Frag {
  return { html, visible };
}

function concat(parts: readonly Frag[], separator = ''): Frag {
  const kept = parts.filter((p) => p.visible > 0 || p.html !== '');
  return {
    html: kept.map((p) => p.html).join(separator),
    visible:
      kept.reduce((n, p) => n + p.visible, 0) + Math.max(0, kept.length - 1) * separator.length,
  };
}

/** Plain text, clipped to `budget` visible characters. */
function plain(text: string, budget: number): Frag {
  const t = clipText(text, Math.max(0, budget));
  return frag(escapeHtml(t), t.length);
}

function wrap(tag: string, inner: Frag, attrs = ''): Frag {
  if (inner.visible === 0) return EMPTY;
  return frag(`<${tag}${attrs}>${inner.html}</${tag}>`, inner.visible);
}

/** An inline run with a visible budget; text leaves are clipped, never tags. */
function inlineRun(run: readonly Inline[], links: LinkBuilder, budget: number): Frag {
  const out: Frag[] = [];
  let left = budget;
  for (const node of run) {
    if (left <= 0) break;
    let piece: Frag;
    switch (node.type) {
      case 'text':
        piece = plain(node.text, left);
        break;
      case 'bold':
        piece = wrap('b', plain(node.text, left));
        break;
      case 'italic':
        piece = wrap('i', plain(node.text, left));
        break;
      case 'code':
        piece = wrap('code', plain(node.text, left));
        break;
      case 'link': {
        const label = plain(node.text, left);
        piece = links.local
          ? label
          : wrap('a', label, ` href="${escapeAttr(links.url(node.path))}"`);
        break;
      }
      case 'time': {
        const fallback = utcTime(node.at);
        if (fallback.length > left) {
          piece = EMPTY;
          left = 0;
          break;
        }
        const format = node.style === 'relative' ? 'r' : 't';
        piece = frag(
          `<tg-time unix="${Math.floor(node.at / 1000)}" format="${format}">${escapeHtml(fallback)}</tg-time>`,
          fallback.length,
        );
        break;
      }
    }
    out.push(piece);
    left -= piece.visible;
  }
  return concat(out);
}

function lines(items: readonly Frag[]): Frag {
  return concat(items, '\n');
}

/** One block with a visible budget (`null` when it has nothing to show). */
function renderBlock(block: Block, links: LinkBuilder, budget: number): Frag {
  switch (block.type) {
    case 'text':
      return inlineRun(block.content, links, budget);
    case 'heading':
      return wrap('b', plain(block.text, budget));
    case 'fields': {
      const out: Frag[] = [];
      let left = budget;
      for (const item of block.items) {
        const label = `${item.label}:`;
        if (left <= label.length + 2) break;
        const line = concat([
          wrap('b', plain(label, left)),
          plain(' ', 1),
          inlineRun(item.value, links, left - label.length - 1),
        ]);
        out.push(line);
        left -= line.visible + 1;
      }
      return lines(out);
    }
    case 'quote': {
      const inner = inlineRun(block.content, links, budget);
      return wrap('blockquote', inner, block.collapsible ? ' expandable' : '');
    }
    case 'list': {
      const out: Frag[] = [];
      let left = budget;
      block.items.forEach((item, i) => {
        const bullet = block.ordered ? `${i + 1}. ` : '• ';
        if (left <= bullet.length + 1) return;
        const line = concat([plain(bullet, left), inlineRun(item, links, left - bullet.length)]);
        out.push(line);
        left -= line.visible + 1;
      });
      return lines(out);
    }
    case 'table':
      // `degrade` turns tables into lists for this renderer (tables: false).
      return EMPTY;
    case 'code': {
      const inner = plain(block.text, budget);
      if (block.language !== null && /^[A-Za-z0-9_+-]{1,32}$/.test(block.language)) {
        return wrap('pre', wrap('code', inner, ` class="language-${block.language}"`));
      }
      return wrap('pre', inner);
    }
    case 'footer':
      return wrap('i', inlineRun(block.content, links, budget));
    case 'image':
    case 'divider':
      return EMPTY;
  }
}

/** The HTML text of a message within `limit` visible characters. */
export function telegramHtml(
  message: NotificationMessage,
  links: LinkBuilder,
  limit: number,
): string {
  const header = concat([
    plain(`${severityMark(message)} `, 4),
    wrap('b', plain(message.title, 120)),
  ]);
  const local = links.local ? localLinks(message, links) : EMPTY;
  const reserve = local.visible > 0 ? local.visible + 2 : 0;
  const parts: Frag[] = [];
  let used = header.visible;
  const room = () => limit - used - reserve;
  const summaryText = message.summary.trim();
  let cut = false;
  const head: Frag[] = [header];
  if (summaryText !== '' && summaryText !== message.title) {
    const summary = plain(summaryText, room() - 1);
    head.push(summary);
    used += summary.visible + 1;
    if (summary.visible < summaryText.length) cut = true;
  }
  parts.push(lines(head));
  for (const block of bodyBlocks(message)) {
    if (cut || room() < 24) {
      cut = true;
      break;
    }
    const rendered = renderBlock(block, links, room() - 2);
    if (rendered.visible === 0) continue;
    parts.push(rendered);
    used += rendered.visible + 2;
  }
  if (cut && room() >= 3) parts.push(plain('…', 1));
  if (local.visible > 0) parts.push(local);
  return concat(parts, '\n\n').html;
}

function localLinks(message: NotificationMessage, links: LinkBuilder): Frag {
  const resolved = openLinks(message, links);
  if (resolved.length === 0) return EMPTY;
  return lines([
    wrap('b', plain(`🖥 ${LOCAL_LINKS_LABEL}`, 64)),
    ...resolved.map((l) => concat([plain(`${l.label}: `, 64), wrap('code', plain(l.url, 2048))])),
  ]);
}

/** The inline keyboard of a message (URL buttons; callback buttons where act buttons are on). */
function keyboard(
  message: NotificationMessage,
  links: LinkBuilder,
  capabilities: ChannelCapabilities,
  context: RenderContext,
): { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } {
  const buttons: { text: string; url?: string; callback_data?: string }[] = [];
  for (const action of message.actions) {
    if (action.kind === 'open') {
      if (!links.local) buttons.push({ text: action.label, url: links.url(action.path) });
    } else if (capabilities.actButtons) {
      buttons.push({ text: action.label, callback_data: context.actToken(action.id) });
    }
  }
  const rows: { text: string; url?: string; callback_data?: string }[][] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  }
  return { inline_keyboard: rows };
}

function isPhotoRef(ref: PlatformMessageRef | null): boolean {
  return ref !== null && (ref['photo'] === 1 || ref['photo'] === '1');
}

/**
 * The Telegram renderer: one request per send or edit.
 * - send: `sendPhoto` (multipart, caption ≤ 1024) when the message carries a screenshot, else
 *   `sendMessage` (≤ 4096);
 * - edit: `editMessageCaption` for a photo message, else `editMessageText`, always with the
 *   keyboard (an empty one removes the buttons).
 */
export const telegramRenderer: ChannelRenderer = {
  kind: 'telegram',
  capabilities: () => TELEGRAM_CAPABILITIES,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    const { message, links } = delivery;
    const chat = context.target['chat_id'] ?? '';
    const thread = context.target['thread_id'];
    const markup = keyboard(message, links, TELEGRAM_CAPABILITIES, context);
    if (context.op === 'edit' && context.ref !== null) {
      const photo = isPhotoRef(context.ref);
      const html = telegramHtml(message, links, photo ? TELEGRAM_CAPTION_MAX : TELEGRAM_TEXT_MAX);
      const target = {
        chat_id: context.ref['chat_id'] ?? chat,
        message_id: context.ref['message_id'],
      };
      return [
        {
          method: 'POST',
          path: photo ? 'editMessageCaption' : 'editMessageText',
          encoding: 'json',
          body: photo
            ? { ...target, caption: html, parse_mode: 'HTML', reply_markup: markup }
            : {
                ...target,
                text: html,
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                reply_markup: markup,
              },
          headers: {},
          file: null,
        },
      ];
    }
    const image = firstImage(message);
    const common: Record<string, unknown> = {
      chat_id: chat,
      ...(thread !== undefined && thread !== '' && { message_thread_id: Number(thread) }),
      parse_mode: 'HTML',
      disable_notification: !message.alert,
      ...(markup.inline_keyboard.length > 0 && { reply_markup: markup }),
      ...(delivery.replyTo !== null &&
        delivery.replyTo['message_id'] !== undefined && {
          reply_parameters: {
            message_id: Number(delivery.replyTo['message_id']),
            allow_sending_without_reply: true,
          },
        }),
    };
    if (image !== null) {
      return [
        {
          method: 'POST',
          path: 'sendPhoto',
          encoding: 'multipart',
          body: { ...common, caption: telegramHtml(message, links, TELEGRAM_CAPTION_MAX) },
          headers: {},
          file: { ref: image.ref, name: SCREENSHOT_FILENAME, content_type: 'image/jpeg' },
        },
      ];
    }
    return [
      {
        method: 'POST',
        path: 'sendMessage',
        encoding: 'json',
        body: {
          ...common,
          text: telegramHtml(message, links, TELEGRAM_TEXT_MAX),
          link_preview_options: { is_disabled: true },
        },
        headers: {},
        file: null,
      },
    ];
  },
};

/**
 * Telegram's 400 descriptions: a vanished message, one too old to delete, an unchanged edit
 * (harmless), a bot removed from the chat (auth), and a bot with a webhook set (rejected with a
 * sentence the operator can act on).
 */
export const refineTelegram: FailureRefiner = (answer) => {
  const d = answer.detail.toLowerCase();
  if (d.includes('message is not modified')) return 'ok';
  if (
    d.includes('message to edit not found') ||
    d.includes('message to delete not found') ||
    d.includes('message_id_invalid')
  ) {
    return new ChannelSendError('message_gone', `Telegram: ${answer.detail}`);
  }
  if (d.includes("message can't be deleted") || d.includes('message can not be deleted')) {
    return new ChannelSendError('too_old', `Telegram: ${answer.detail}`);
  }
  if (
    d.includes('bot was blocked') ||
    d.includes('bot was kicked') ||
    d.includes('not enough rights')
  ) {
    return new ChannelSendError('auth', `Telegram: ${answer.detail}`);
  }
  if (answer.status === 409 && d.includes('webhook')) {
    return new ChannelSendError(
      'rejected',
      'Telegram: this bot has a webhook set, so it cannot be polled; remove it with deleteWebhook',
    );
  }
  return null;
};

/** What the Telegram transport needs besides the channel row. */
export interface TelegramChannelDeps {
  /** The bot token (resolved from the channel's `token` variable). */
  readonly token: string;
  readonly images: NotificationImageReader;
  readonly fetch?: FetchFn;
  /** Bot API base; the fakes pass their own. */
  readonly apiBase?: string;
}

function messageOf(answer: PlatformAnswer): Record<string, unknown> | null {
  const result =
    answer.json !== null && typeof answer.json === 'object'
      ? Reflect.get(answer.json, 'result')
      : null;
  return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : null;
}

/**
 * A Telegram channel: sends, edits (text or caption) and deletes through the Bot API. A missing
 * screenshot (pruned) degrades to a text message instead of failing.
 *
 * @returns The adapter.
 */
export function createTelegramChannel(
  record: NotificationChannelRecord,
  deps: TelegramChannelDeps,
): NotificationChannel {
  const base = (deps.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const fetchFn = deps.fetch ?? fetch;
  const options = {
    fetch: fetchFn,
    secrets: [deps.token],
    platform: 'Telegram',
    refine: refineTelegram,
  };
  const url = (method: string) => `${base}/bot${deps.token}/${method}`;
  const context = (op: 'send' | 'edit', ref: PlatformMessageRef | null): RenderContext => ({
    mode: record.mode,
    target: record.target,
    op,
    ref,
    actToken: () => {
      throw new ChannelSendError('rejected', 'act buttons are not available on Telegram yet');
    },
  });

  async function perform(
    request: RenderedRequest,
    addressesMessage: boolean,
  ): Promise<PlatformAnswer> {
    if (request.file !== null) {
      const image = await deps.images.read(request.file.ref);
      if (image !== null) {
        return callPlatform(
          {
            url: url(request.path),
            method: request.method,
            body: multipart(request.body, {
              field: 'photo',
              bytes: image.bytes,
              name: request.file.name,
              type: image.contentType,
            }),
            addressesMessage,
          },
          options,
        );
      }
      const { caption, ...rest } = request.body;
      return callPlatform(
        {
          url: url('sendMessage'),
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...rest,
            text: caption,
            link_preview_options: { is_disabled: true },
          }),
          addressesMessage,
        },
        options,
      );
    }
    return callPlatform(
      {
        url: url(request.path),
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        addressesMessage,
      },
      options,
    );
  }

  return {
    id: record.channelId,
    name: record.name,
    kind: 'telegram',
    capabilities: TELEGRAM_CAPABILITIES,
    async send(delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = telegramRenderer.render(delivery, context('send', null));
      if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
      const answer = await perform(request, false);
      const sent = messageOf(answer);
      const chat = sent !== null ? Reflect.get(sent, 'chat') : null;
      const chatId =
        chat !== null && typeof chat === 'object' ? Reflect.get(chat, 'id') : undefined;
      const messageId = sent?.['message_id'];
      if (typeof messageId !== 'number') {
        throw new ChannelSendError('rejected', 'Telegram answered without a message id');
      }
      return {
        ref: {
          chat_id:
            typeof chatId === 'number' || typeof chatId === 'string'
              ? chatId
              : String(record.target['chat_id'] ?? ''),
          message_id: messageId,
          photo: Array.isArray(sent?.['photo']) ? 1 : 0,
        },
      };
    },
    async edit(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult> {
      const [request] = telegramRenderer.render(delivery, context('edit', ref));
      if (request === undefined) return { ref };
      await perform(request, true);
      return { ref };
    },
    async delete(ref: PlatformMessageRef): Promise<void> {
      await callPlatform(
        {
          url: url('deleteMessage'),
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: ref['chat_id'], message_id: ref['message_id'] }),
          addressesMessage: true,
        },
        options,
      );
    },
  };
}
