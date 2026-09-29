/** @module infra/notifications/telegram-setup — the setup-only Telegram calls of the connect flow (spec 03 §4.8.1): the bot's username and the wait for `/start <code>` over `getUpdates` long polling. The persistent callback loop of act buttons is N2's. */

import {
  ChannelSendError,
  type TelegramSetup,
  type TelegramStart,
} from '../../ports/notification-channel.ts';
import { callPlatform, type FetchFn } from './http.ts';
import { refineTelegram, TELEGRAM_API_BASE } from './telegram.ts';

/** Longest single `getUpdates` wait (seconds). */
const LONG_POLL_S = 25;

/** Options of {@link createTelegramSetup}. */
export interface TelegramSetupOptions {
  readonly fetch?: FetchFn;
  readonly apiBase?: string;
  /** Wall clock (epoch ms); injectable for tests. */
  readonly now?: () => number;
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
  const now = options.now ?? Date.now;
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
      let offset: number | undefined;
      while (!signal.aborted && now() < deadline) {
        const wait = Math.max(0, Math.min(LONG_POLL_S, Math.floor((deadline - now()) / 1000)));
        let answer: Awaited<ReturnType<typeof call>>;
        try {
          answer = await call(
            token,
            'getUpdates',
            {
              ...(offset !== undefined && { offset }),
              timeout: wait,
              allowed_updates: ['message', 'my_chat_member'],
            },
            (wait + 10) * 1000,
            signal,
          );
        } catch (err) {
          if (signal.aborted) return null;
          throw err;
        }
        if (signal.aborted) return null;
        const updates = obj(answer.json)?.['result'];
        if (!Array.isArray(updates)) continue;
        for (const raw of updates) {
          const update = obj(raw);
          const id = update?.['update_id'];
          if (typeof id === 'number') offset = id + 1;
          const message = obj(update?.['message']);
          const text = message?.['text'];
          if (message === null || typeof text !== 'string' || !isStartCommand(text, code)) continue;
          const chat = obj(message['chat']);
          const from = obj(message['from']);
          const chatId = chat?.['id'];
          if (typeof chatId !== 'number' && typeof chatId !== 'string') continue;
          const type = typeof chat?.['type'] === 'string' ? chat['type'] : 'private';
          const title =
            typeof chat?.['title'] === 'string' ? chat['title'] : nameOf(chat) || String(chatId);
          const thread = message['message_thread_id'];
          // Acknowledge what was read, so the next connect does not see this /start again.
          await call(token, 'getUpdates', { offset, timeout: 0 }).catch(() => undefined);
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
        }
      }
      return null;
    },
  };
}
