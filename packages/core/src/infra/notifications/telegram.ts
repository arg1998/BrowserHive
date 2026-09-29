/** @module infra/notifications/telegram — the Telegram Bot API adapter (spec 03 §9.5, D-40, D-41): a pure renderer to Rich Messages (`sendRichMessage` / `editMessageText` with `rich_message`) with an inline keyboard of links and act buttons, the classic `sendMessage`/`sendPhoto` HTML renderer kept as the fallback, and the transport (send with fallback, edit in the message's own format, delete within 48 h, presses through the bot's update poller). */

import type {
  Block,
  Inline,
  NotificationAction,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import { TELEGRAM_DELETE_WINDOW_MS } from '@browserhive/contracts/notifications';
import type { Logger } from '../../ports/logger.ts';
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
  plainRun,
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

/** Visible characters a Rich Message may hold (Bot API 10.1). */
export const TELEGRAM_RICH_MAX = 32_768;
/** The media id of the screenshot inside a Rich Message (`tg://photo?id=shot`). */
export const RICH_PHOTO_ID = 'shot';

/**
 * What the Telegram renderer supports. Rich Messages draw headings, tables (bordered), fields
 * (compact tables), expandable quotes, code and footers natively (D-40); the classic fallback
 * writes tables as lines. The text budget keeps messages readable on a phone; a classic caption is
 * clipped to 1024 by the renderer itself. Act buttons depend on the channel's rules
 * ({@link telegramCapabilities}).
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: true,
  charts: false,
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

/**
 * The capabilities of a Telegram channel: act buttons when its rules switch them on (presses
 * arrive through the bot's update poller, D-41).
 *
 * @returns The capabilities.
 */
export function telegramCapabilities(setup: Pick<ChannelSetup, 'rules'>): ChannelCapabilities {
  return setup.rules.act_buttons === true
    ? { ...TELEGRAM_CAPABILITIES, actButtons: true }
    : TELEGRAM_CAPABILITIES;
}

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
        piece = linksAsText(links)
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
    case 'table': {
      // Rich Messages draw tables; the classic fallback writes one line per row.
      const out: Frag[] = [];
      let left = budget;
      for (const row of block.rows) {
        const cells = row.map((cell, i) => `${block.columns[i] ?? ''}: ${plainRun(cell)}`);
        const line = plain(`• ${cells.join(' · ')}`, left);
        if (line.visible === 0) break;
        out.push(line);
        left -= line.visible + 1;
      }
      return lines(out);
    }
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
    case 'chart':
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
  const local = linksAsText(links) ? localLinks(message, links) : EMPTY;
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

/**
 * Whether Telegram accepts `url` in a URL button or an `<a href>`: it refuses hosts without a dot
 * (`localhost`, a bare machine name) and IPv6 literals ("Wrong HTTP URL"), and accepts domains and
 * IPv4 addresses (checked against the Bot API on 2026-09-28).
 */
export function telegramAcceptsUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host.startsWith('[')) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes('.');
}

/** Links go into the text instead of buttons: local links, or a base Telegram would refuse. */
function linksAsText(links: LinkBuilder): boolean {
  return links.local || !telegramAcceptsUrl(links.url('/'));
}

function localLinks(message: NotificationMessage, links: LinkBuilder): Frag {
  const resolved = openLinks(message, links);
  if (resolved.length === 0) return EMPTY;
  return lines([
    wrap('b', plain(links.local ? `🖥 ${LOCAL_LINKS_LABEL}` : '🔗 Links', 64)),
    ...resolved.map((l) => concat([plain(`${l.label}: `, 64), wrap('code', plain(l.url, 2048))])),
  ]);
}

/** One inline keyboard button. */
interface KeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  style?: 'success' | 'danger' | 'primary';
}

/**
 * The colour of a button: an act button's affirmative answer is green (`success`), a destructive
 * one red; a primary link is blue. Others keep the app's default.
 */
function buttonStyle(action: NotificationAction): KeyboardButton['style'] | undefined {
  if (action.style === 'danger') return 'danger';
  if (action.style === 'primary') return action.kind === 'act' ? 'success' : 'primary';
  return undefined;
}

/**
 * The inline keyboard of a message: URL buttons, and a callback button for every act action (they
 * survive `degrade` only where the channel receives presses).
 */
function keyboard(
  message: NotificationMessage,
  links: LinkBuilder,
  context: RenderContext,
): { inline_keyboard: KeyboardButton[][] } {
  const buttons: KeyboardButton[] = [];
  for (const action of message.actions) {
    const style = buttonStyle(action);
    if (action.kind === 'open') {
      if (!linksAsText(links)) {
        buttons.push({ text: action.label, url: links.url(action.path), ...(style && { style }) });
      }
    } else {
      buttons.push({
        text: action.label,
        callback_data: context.actToken(action.id),
        ...(style && { style }),
      });
    }
  }
  const rows: KeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  }
  return { inline_keyboard: rows };
}

function isPhotoRef(ref: PlatformMessageRef | null): boolean {
  return ref !== null && (ref['photo'] === 1 || ref['photo'] === '1');
}

/** Whether a message ref was sent as a Rich Message (messages from before N2 were not). */
export function isRichRef(ref: PlatformMessageRef | null): boolean {
  return ref !== null && (ref['rich'] === 1 || ref['rich'] === '1');
}

/**
 * The classic Telegram renderer (the fallback, D-40): one request per send or edit.
 * - send: `sendPhoto` (multipart, caption ≤ 1024) when the message carries a screenshot, else
 *   `sendMessage` (≤ 4096);
 * - edit: `editMessageCaption` for a photo message, else `editMessageText`, always with the
 *   keyboard (an empty one removes the buttons).
 */
export const telegramClassicRenderer: ChannelRenderer = {
  kind: 'telegram',
  capabilities: telegramCapabilities,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    const { message, links } = delivery;
    const chat = context.target['chat_id'] ?? '';
    const thread = context.target['thread_id'];
    const markup = keyboard(message, links, context);
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

// ---------------------------------------------------------------------------------------------
// Rich Messages (D-40)
// ---------------------------------------------------------------------------------------------

/** Rich HTML text: escaped, newlines kept as `<br>`. */
function richText(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** One inline node as Rich HTML. */
function richNode(node: Inline, links: LinkBuilder): string {
  switch (node.type) {
    case 'text':
      return richText(node.text);
    case 'bold':
      return `<b>${richText(node.text)}</b>`;
    case 'italic':
      return `<i>${richText(node.text)}</i>`;
    case 'code':
      return `<code>${escapeHtml(node.text)}</code>`;
    case 'link':
      return linksAsText(links)
        ? richText(node.text)
        : `<a href="${escapeAttr(links.url(node.path))}">${richText(node.text)}</a>`;
    case 'time': {
      const format = node.style === 'relative' ? 'r' : 't';
      return `<tg-time unix="${Math.floor(node.at / 1000)}" format="${format}">${escapeHtml(utcTime(node.at))}</tg-time>`;
    }
  }
}

/** One inline run as Rich HTML. */
function richInline(run: readonly Inline[], links: LinkBuilder): string {
  return run.map((node) => richNode(node, links)).join('');
}

/** One block as Rich HTML (`''` when it has nothing to show). */
function richBlock(block: Block, links: LinkBuilder): string {
  switch (block.type) {
    case 'text': {
      const inner = richInline(block.content, links);
      return inner === '' ? '' : `<p>${inner}</p>`;
    }
    case 'heading':
      return block.text.trim() === '' ? '' : `<h4>${richText(block.text)}</h4>`;
    case 'fields':
      return `<table compact>${block.items
        .map(
          (item) =>
            `<tr><td><b>${richText(item.label)}</b></td><td>${richInline(item.value, links) || '—'}</td></tr>`,
        )
        .join('')}</table>`;
    case 'quote': {
      const inner = richInline(block.content, links);
      if (inner === '') return '';
      return block.collapsible
        ? `<blockquote expandable>${inner}</blockquote>`
        : `<blockquote>${inner}</blockquote>`;
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((item) => `<li>${richInline(item, links)}</li>`).join('')}</${tag}>`;
    }
    case 'table': {
      const head = `<tr>${block.columns.map((c) => `<th>${richText(c)}</th>`).join('')}</tr>`;
      const rows = block.rows
        .map(
          (row) => `<tr>${row.map((cell) => `<td>${richInline(cell, links)}</td>`).join('')}</tr>`,
        )
        .join('');
      return `<table bordered striped compact>${head}${rows}</table>`;
    }
    case 'code': {
      const code = escapeHtml(block.text);
      if (block.language !== null && /^[A-Za-z0-9_+-]{1,32}$/.test(block.language)) {
        return `<pre><code class="language-${block.language}">${code}</code></pre>`;
      }
      return `<pre>${code}</pre>`;
    }
    case 'divider':
      return '<hr/>';
    case 'chart':
      // Charts arrive as text (`degrade`, capability `charts: false`).
      return '';
    case 'footer': {
      const inner = richInline(block.content, links);
      return inner === '' ? '' : `<footer>${inner}</footer>`;
    }
    case 'image':
      return '';
  }
}

/**
 * The Rich HTML of a message (D-40): the title as a heading with its severity or outcome mark,
 * the summary, the screenshot (a media block named {@link RICH_PHOTO_ID}), the blocks, and the
 * links as text when they only open on this computer.
 *
 * @returns The `rich_message.html` value.
 */
export function telegramRichHtml(
  message: NotificationMessage,
  links: LinkBuilder,
  withImage: boolean,
): string {
  const parts: string[] = [`<h3>${richText(`${severityMark(message)} ${message.title}`)}</h3>`];
  const summary = message.summary.trim();
  if (summary !== '' && summary !== message.title) parts.push(`<p>${richText(summary)}</p>`);
  if (withImage) parts.push(`<img src="tg://photo?id=${RICH_PHOTO_ID}"/>`);
  for (const block of bodyBlocks(message)) {
    const html = richBlock(block, links);
    if (html !== '') parts.push(html);
  }
  if (linksAsText(links)) {
    const resolved = openLinks(message, links);
    if (resolved.length > 0) {
      const title = links.local ? `🖥 ${LOCAL_LINKS_LABEL}` : '🔗 Links';
      parts.push(
        `<p><b>${richText(title)}</b><br>${resolved
          .map((l) => `${richText(l.label)}: <code>${escapeHtml(l.url)}</code>`)
          .join('<br>')}</p>`,
      );
    }
  }
  let html = parts.join('');
  // The text budget of `degrade` keeps messages far below the limit; this is the last guard.
  while (html.length > TELEGRAM_RICH_MAX - 64 && parts.length > 2) {
    parts.splice(parts.length - 2, 1);
    html = parts.join('');
  }
  return html;
}

/**
 * The Telegram renderer (D-40): one Rich Message request per send or edit.
 * - send: `sendRichMessage` (JSON; multipart with the screenshot as `attach://shot` when the
 *   message carries one);
 * - edit: `editMessageText` with `rich_message`, the screenshot re-used by the `file_id` stored in
 *   the ref (or uploaded again), and the keyboard (an empty one removes the buttons). A message
 *   sent classic (its ref has no `rich: 1`) is edited by the classic renderer.
 */
export const telegramRenderer: ChannelRenderer = {
  kind: 'telegram',
  capabilities: telegramCapabilities,
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[] {
    if (context.op === 'edit' && context.ref !== null && !isRichRef(context.ref)) {
      return telegramClassicRenderer.render(delivery, context);
    }
    const { message, links } = delivery;
    const chat = context.target['chat_id'] ?? '';
    const thread = context.target['thread_id'];
    const markup = keyboard(message, links, context);
    const image = firstImage(message);
    const html = telegramRichHtml(message, links, image !== null);
    const fileId =
      context.ref !== null && typeof context.ref['photo_file_id'] === 'string'
        ? context.ref['photo_file_id']
        : null;
    const upload = image !== null && (context.op === 'send' || fileId === null);
    const media =
      image === null
        ? undefined
        : [
            {
              id: RICH_PHOTO_ID,
              media: { type: 'photo', media: upload ? `attach://${RICH_PHOTO_ID}` : fileId },
            },
          ];
    const richMessage = { html, ...(media && { media }), skip_entity_detection: true };
    const file =
      upload && image !== null
        ? { ref: image.ref, name: SCREENSHOT_FILENAME, content_type: 'image/jpeg' }
        : null;
    if (context.op === 'edit' && context.ref !== null) {
      return [
        {
          method: 'POST',
          path: 'editMessageText',
          encoding: file === null ? 'json' : 'multipart',
          body: {
            chat_id: context.ref['chat_id'] ?? chat,
            message_id: context.ref['message_id'],
            rich_message: richMessage,
            reply_markup: markup,
          },
          headers: {},
          file,
        },
      ];
    }
    return [
      {
        method: 'POST',
        path: 'sendRichMessage',
        encoding: file === null ? 'json' : 'multipart',
        body: {
          chat_id: chat,
          ...(thread !== undefined && thread !== '' && { message_thread_id: Number(thread) }),
          rich_message: richMessage,
          disable_notification: !message.alert,
          ...(markup.inline_keyboard.length > 0 && { reply_markup: markup }),
          ...(delivery.replyTo !== null &&
            delivery.replyTo['message_id'] !== undefined && {
              reply_parameters: {
                message_id: Number(delivery.replyTo['message_id']),
                allow_sending_without_reply: true,
              },
            }),
        },
        headers: {},
        file,
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
  /**
   * The bot's update pollers (`TelegramUpdatesHub`): the channel's presses arrive through them (act
   * buttons, D-41).
   */
  readonly updates?: { pressSource(token: string, chatId: string): PressSource };
  readonly logger?: Logger;
}

function messageOf(answer: PlatformAnswer): Record<string, unknown> | null {
  const result =
    answer.json !== null && typeof answer.json === 'object'
      ? Reflect.get(answer.json, 'result')
      : null;
  return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : null;
}

/**
 * The `file_id` of the largest photo a sent Rich Message carries (`rich_message.blocks[].photo`),
 * so an edit can show the screenshot again without uploading it.
 *
 * @returns The file id, or `null`.
 */
export function richPhotoFileId(sent: Record<string, unknown> | null): string | null {
  const blocks = (sent?.['rich_message'] as { blocks?: unknown } | undefined)?.blocks;
  const stack: unknown[] = Array.isArray(blocks) ? [...blocks] : [];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node === null || typeof node !== 'object') continue;
    const photo = (node as Record<string, unknown>)['photo'];
    if (Array.isArray(photo) && photo.length > 0) {
      const largest = photo[photo.length - 1] as Record<string, unknown> | undefined;
      if (typeof largest?.['file_id'] === 'string') return largest['file_id'];
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return null;
}

/** A rich call Telegram refused as such (a 400 on the content, or a server without the method). */
function richRefused(err: unknown): boolean {
  return err instanceof ChannelSendError && err.code === 'rejected';
}

/**
 * A Telegram channel: sends Rich Messages (falling back to classic HTML when Telegram refuses one,
 * D-40), edits each message in the format it was sent in, deletes within 48 h, and listens for its
 * act buttons through the bot's update poller when its rules switch them on (D-41). A missing
 * screenshot (pruned) degrades to a message without it instead of failing.
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
  const capabilities = telegramCapabilities(record);
  const url = (method: string) => `${base}/bot${deps.token}/${method}`;
  // A Bot API server that does not know `sendRichMessage` (404) keeps this channel classic.
  let classicOnly = false;
  const context = (
    op: 'send' | 'edit',
    ref: PlatformMessageRef | null,
    delivery: ChannelDelivery,
  ): RenderContext => ({
    mode: record.mode,
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

  /** The delivery without its screenshot when the image is gone (pruned). */
  async function present(delivery: ChannelDelivery): Promise<ChannelDelivery> {
    const image = firstImage(delivery.message);
    if (image === null || (await deps.images.read(image.ref)) !== null) return delivery;
    return {
      ...delivery,
      message: {
        ...delivery.message,
        blocks: delivery.message.blocks.filter((b) => b.type !== 'image'),
      },
    };
  }

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
              field: request.path === 'sendPhoto' ? 'photo' : RICH_PHOTO_ID,
              bytes: image.bytes,
              name: request.file.name,
              type: image.contentType,
            }),
            addressesMessage,
          },
          options,
        );
      }
      if (request.path === 'sendPhoto') {
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

  function sentRef(answer: PlatformAnswer, rich: boolean, image: boolean): PlatformMessageRef {
    const sent = messageOf(answer);
    const chat = sent !== null ? Reflect.get(sent, 'chat') : null;
    const chatId = chat !== null && typeof chat === 'object' ? Reflect.get(chat, 'id') : undefined;
    const messageId = sent?.['message_id'];
    if (typeof messageId !== 'number') {
      throw new ChannelSendError('rejected', 'Telegram answered without a message id');
    }
    const fileId = rich && image ? richPhotoFileId(sent) : null;
    return {
      chat_id:
        typeof chatId === 'number' || typeof chatId === 'string'
          ? chatId
          : String(record.target['chat_id'] ?? ''),
      message_id: messageId,
      photo: rich ? (image ? 1 : 0) : Array.isArray(sent?.['photo']) ? 1 : 0,
      rich: rich ? 1 : 0,
      ...(fileId !== null && { photo_file_id: fileId }),
    };
  }

  function fallback(err: unknown, op: 'send' | 'edit'): void {
    if (err instanceof ChannelSendError && op === 'send' && /Telegram 404/.test(err.message)) {
      classicOnly = true;
    }
    deps.logger?.warn('rich message refused', {
      channel: record.name,
      op,
      code: err instanceof ChannelSendError ? err.code : 'unavailable',
    });
  }

  const presses: PressSource | undefined =
    capabilities.actButtons && deps.updates !== undefined
      ? deps.updates.pressSource(deps.token, String(record.target['chat_id'] ?? ''))
      : undefined;

  return {
    id: record.channelId,
    name: record.name,
    kind: 'telegram',
    capabilities,
    ...(presses !== undefined && { presses }),
    async send(input: ChannelDelivery): Promise<ChannelSendResult> {
      const delivery = await present(input);
      const image = firstImage(delivery.message) !== null;
      if (!classicOnly) {
        const [request] = telegramRenderer.render(delivery, context('send', null, delivery));
        if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
        try {
          return { ref: sentRef(await perform(request, false), true, image) };
        } catch (err) {
          if (!richRefused(err)) throw err;
          fallback(err, 'send');
        }
      }
      const [request] = telegramClassicRenderer.render(delivery, context('send', null, delivery));
      if (request === undefined) throw new ChannelSendError('rejected', 'nothing to send');
      return { ref: sentRef(await perform(request, false), false, image) };
    },
    async edit(ref: PlatformMessageRef, input: ChannelDelivery): Promise<ChannelSendResult> {
      const delivery = await present(input);
      if (isRichRef(ref)) {
        const [request] = telegramRenderer.render(delivery, context('edit', ref, delivery));
        if (request === undefined) return { ref };
        try {
          const answer = await perform(request, true);
          const fileId = request.file === null ? null : richPhotoFileId(messageOf(answer));
          return { ref: fileId === null ? ref : { ...ref, photo_file_id: fileId } };
        } catch (err) {
          if (!richRefused(err)) throw err;
          fallback(err, 'edit');
        }
        // The rich message becomes a classic text message (its screenshot is dropped).
        const classicRef = { ...ref, photo: 0, rich: 0 };
        const [classic] = telegramClassicRenderer.render(
          delivery,
          context('edit', classicRef, delivery),
        );
        if (classic !== undefined) await perform(classic, true);
        return { ref: classicRef };
      }
      const [request] = telegramClassicRenderer.render(delivery, context('edit', ref, delivery));
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
