/** @module infra/notifications/telegram-setup — the setup-only Telegram calls of the connect flow (spec 03 §4.8.1): the bot's username and the wait for `/start <code>`, which goes through the bot's shared update poller (Telegram answers 409 to two concurrent `getUpdates`, D-41). */

import {
  ChannelSendError,
  type TelegramSetup,
  type TelegramStart,
} from '../../ports/notification-channel.ts';
import { callPlatform, type FetchFn } from './http.ts';
import { refineTelegram, TELEGRAM_API_BASE } from './telegram.ts';
import { TelegramUpdatesHub } from './telegram-updates.ts';

/** Options of {@link createTelegramSetup}. */
export interface TelegramSetupOptions {
  readonly fetch?: FetchFn;
  readonly apiBase?: string;
  /** Wall clock (epoch ms); injectable for tests. */
  readonly now?: () => number;
  /** The update pollers shared with the channels' act buttons (a private one otherwise). */
  readonly updates?: TelegramUpdatesHub;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function nameOf(user: Record<string, unknown> | null): string {
  if (user === null) return '';
  const first = typeof user['first_name'] === 'string' ? user['first_name'] : '';
  const last = typeof user['last_name'] === 'string' ? user['last_name'] : '';
  const full = `${first} ${last}`.trim();
  if (full !== '') return full;
  return typeof user['username'] === 'string' ? `@${user['username']}` : '';
}

/**
 * Whether a message text is `/start <code>` (or `/start@<bot> <code>`, as groups send it).
 *
 * @returns True for this code.
 */
export function isStartCommand(text: string, code: string): boolean {
  const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)\s*$/.exec(text.trim());
  return match?.[1] === code;
}

/**
 * The Telegram setup calls over the Bot API.
 *
 * @returns The setup port.
 */
export function createTelegramSetup(options: TelegramSetupOptions = {}): TelegramSetup {
  const base = (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const fetchFn = options.fetch ?? fetch;
  const updates =
    options.updates ??
    new TelegramUpdatesHub({
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.apiBase !== undefined && { apiBase: options.apiBase }),
      ...(options.now !== undefined && { now: options.now }),
    });
  const call = (
    token: string,
    method: string,
    body: unknown,
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ) =>
    callPlatform(
      {
        url: `${base}/bot${token}/${method}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
        ...(signal !== undefined && { signal }),
      },
      { fetch: fetchFn, secrets: [token], platform: 'Telegram', refine: refineTelegram },
    );

  return {
    async botUsername(token: string): Promise<string> {
      const answer = await call(token, 'getMe', {});
      const result = obj(obj(answer.json)?.['result']);
      const username = result?.['username'];
      if (typeof username !== 'string' || username === '') {
        throw new ChannelSendError('rejected', 'Telegram getMe returned no username');
      }
      return username;
    },

    async waitForStart(token, code, { signal, deadline }): Promise<TelegramStart | null> {
      const message = await updates.waitForMessage(
        token,
        (m) => typeof m['text'] === 'string' && isStartCommand(m['text'], code),
        { signal, deadline },
      );
      if (message === null) return null;
      const chat = obj(message['chat']);
      const from = obj(message['from']);
      const chatId = chat?.['id'];
      if (typeof chatId !== 'number' && typeof chatId !== 'string') return null;
      const type = typeof chat?.['type'] === 'string' ? chat['type'] : 'private';
      const title =
        typeof chat?.['title'] === 'string' ? chat['title'] : nameOf(chat) || String(chatId);
      const thread = message['message_thread_id'];
      const userId = from?.['id'];
      return {
        chat: {
          id: String(chatId),
          title,
          type,
          threadId:
            typeof thread === 'number' && message['is_topic_message'] === true
              ? String(thread)
              : null,
        },
        user:
          typeof userId === 'number' || typeof userId === 'string'
            ? { id: String(userId), name: nameOf(from) || String(userId) }
            : null,
      };
    },
  };
}
