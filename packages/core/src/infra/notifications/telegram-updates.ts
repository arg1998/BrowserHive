/** @module infra/notifications/telegram-updates — one `getUpdates` long-poll loop per Telegram bot token (spec 03 §9.6, D-41): act-button presses (`callback_query`) go to the channel of their chat, `/start` messages to the setup's waiters; the next offset is stored after each update, so a restart neither loses nor repeats a press. Outbound only (D-33). */

import { ACTION_PAYLOAD_RE } from '@browserhive/contracts/notifications';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  ChannelSendError,
  type ListenerStatus,
  type PressHandler,
  type PressSource,
} from '../../ports/notification-channel.ts';
import { callPlatform, type FetchFn } from './http.ts';
import { refineTelegram, TELEGRAM_API_BASE } from './telegram.ts';

/** Where the pollers keep their offsets (`notification_cursors`). */
export interface CursorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Options of {@link TelegramUpdatesHub}. */
export interface TelegramUpdatesOptions {
  readonly fetch?: FetchFn;
  readonly apiBase?: string;
  readonly cursors?: CursorStore;
  readonly logger?: Logger;
  /** Wall clock (epoch ms). */
  readonly now?: () => number;
  /** Seconds one `getUpdates` waits (Telegram's long poll); default 25. */
  readonly pollSeconds?: number;
  /** How long a poller outlives its last channel (a registry reload re-subscribes); default 5 s. */
  readonly lingerMs?: number;
  /** First and longest wait between failed polls; default 1 s and 30 s. */
  readonly backoffMs?: { readonly min: number; readonly max: number };
  /** Wait after `auth` or a 409 (another poller, a webhook); default 5 min and 30 s. */
  readonly offlineRetryMs?: { readonly auth: number; readonly conflict: number };
}

/** The update types the pollers ask for (the setting persists on Telegram's side). */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' ? (value as Json) : null;
}

function nameOf(user: Json | null): string | null {
  if (user === null) return null;
  const first = typeof user['first_name'] === 'string' ? user['first_name'] : '';
  const last = typeof user['last_name'] === 'string' ? user['last_name'] : '';
  const full = `${first} ${last}`.trim();
  if (full !== '') return full;
  return typeof user['username'] === 'string' ? `@${user['username']}` : null;
}

interface Subscriber {
  readonly chatId: string;
  readonly handler: PressHandler;
  readonly onStatus: (status: ListenerStatus) => void;
}

interface Waiter {
  match(message: Json): boolean;
  resolve(message: Json | null): void;
}

/** The token's public half: the bot id before the colon (never the secret). */
function botIdOf(token: string): string {
  const id = token.split(':')[0] ?? '';
  return /^\d+$/.test(id) ? id : 'unknown';
}

class BotPoller {
  readonly subscribers = new Set<Subscriber>();
  readonly waiters = new Set<Waiter>();
  private status: ListenerStatus;
  private running = false;
  private abort: AbortController | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen: string[] = [];

  constructor(
    private readonly token: string,
    private readonly hub: TelegramUpdatesHub,
    private readonly opts: Required<
      Omit<TelegramUpdatesOptions, 'cursors' | 'logger' | 'fetch'>
    > & {
      readonly fetch: FetchFn;
      readonly cursors: CursorStore | null;
      readonly logger: Logger | null;
    },
  ) {
    this.status = { state: 'connecting', since: opts.now(), detail: null };
  }

  current(): ListenerStatus {
    return this.status;
  }

  wake(): void {
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.running) return;
    this.running = true;
    this.setStatus('connecting', null);
    void this.loop().finally(() => {
      this.running = false;
    });
  }

  release(): void {
    if (this.subscribers.size > 0 || this.waiters.size > 0) return;
    if (this.lingerTimer !== null) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.subscribers.size > 0 || this.waiters.size > 0) return;
      this.halt();
    }, this.opts.lingerMs);
  }

  halt(): void {
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.abort?.abort();
    this.running = false;
    for (const waiter of this.waiters) waiter.resolve(null);
    this.waiters.clear();
    this.hub.forget(this.token, this);
  }

  private get key(): string {
    return `telegram:${botIdOf(this.token)}`;
  }

  private setStatus(state: ListenerStatus['state'], detail: string | null): void {
    if (this.status.state === state && this.status.detail === detail) return;
    this.status = { state, since: this.opts.now(), detail };
    for (const sub of this.subscribers) {
      try {
        sub.onStatus(this.status);
      } catch {
        // a listener's callback never stops the poller
      }
    }
  }

  private wanted(): boolean {
    return this.subscribers.size > 0 || this.waiters.size > 0;
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async loop(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const stored = await this.opts.cursors?.get(this.key).catch(() => null);
    let offset = stored !== null && stored !== undefined ? Number(stored) : undefined;
    if (offset !== undefined && !Number.isSafeInteger(offset)) offset = undefined;
    let delay = this.opts.backoffMs.min;
    // The first poll does not wait, so the card shows "connected" as soon as Telegram answers.
    let first = true;
    while (!abort.signal.aborted && (this.wanted() || this.lingerTimer !== null)) {
      let updates: unknown[];
      try {
        const answer = await callPlatform(
          {
            url: `${this.opts.apiBase}/bot${this.token}/getUpdates`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(offset !== undefined && { offset }),
              timeout: first ? 0 : this.opts.pollSeconds,
              allowed_updates: TELEGRAM_ALLOWED_UPDATES,
            }),
            timeoutMs: (this.opts.pollSeconds + 10) * 1000,
            signal: abort.signal,
          },
          {
            fetch: this.opts.fetch,
            secrets: [this.token],
            platform: 'Telegram',
            refine: refineTelegram,
          },
        );
        const result = obj(answer.json)?.['result'];
        updates = Array.isArray(result) ? result : [];
        this.setStatus('connected', null);
        first = false;
        delay = this.opts.backoffMs.min;
      } catch (err) {
        if (abort.signal.aborted) break;
        const code = err instanceof ChannelSendError ? err.code : 'unavailable';
        if (code === 'auth') {
          this.setStatus('offline', 'Telegram refused the bot token.');
          await this.sleep(this.opts.offlineRetryMs.auth, abort.signal);
        } else if (err instanceof ChannelSendError && /409|webhook/i.test(err.message)) {
          this.setStatus(
            'offline',
            /webhook/i.test(err.message)
              ? 'This bot has a webhook set, so it cannot be polled; remove it with deleteWebhook.'
              : 'Another program is polling this bot (Telegram allows one).',
          );
          await this.sleep(this.opts.offlineRetryMs.conflict, abort.signal);
        } else {
          this.setStatus('reconnecting', 'Telegram could not be reached; retrying.');
          this.opts.logger?.warn('telegram poll failed', { code, err: serializeError(err) });
          await this.sleep(delay, abort.signal);
          delay = Math.min(this.opts.backoffMs.max, delay * 2);
        }
        continue;
      }
      for (const raw of updates) {
        const update = obj(raw);
        const id = update?.['update_id'];
        if (typeof id !== 'number') continue;
        try {
          await this.dispatch(update ?? {});
        } catch (err) {
          this.opts.logger?.warn('telegram update failed', { err: serializeError(err) });
        }
        offset = id + 1;
        await this.opts.cursors?.set(this.key, String(offset)).catch(() => undefined);
      }
    }
    if (this.abort === abort) this.abort = null;
  }

  private async dispatch(update: Json): Promise<void> {
    const callback = obj(update['callback_query']);
    if (callback !== null) {
      await this.press(callback);
      return;
    }
    const message = obj(update['message']);
    if (message === null) return;
    for (const waiter of this.waiters) {
      if (waiter.match(message)) {
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  private async answer(id: string, text: string | null, alert: boolean): Promise<void> {
    await callPlatform(
      {
        url: `${this.opts.apiBase}/bot${this.token}/answerCallbackQuery`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: id,
          ...(text !== null && { text: text.slice(0, 200) }),
          ...(alert && { show_alert: true }),
        }),
      },
      { fetch: this.opts.fetch, secrets: [this.token], platform: 'Telegram' },
    ).catch(() => undefined); // "query is too old": the press was made while BrowserHive was off
  }

  private async press(callback: Json): Promise<void> {
    const id = typeof callback['id'] === 'string' ? callback['id'] : null;
    if (id === null) return;
    if (this.seen.includes(id)) return;
    this.seen.push(id);
    if (this.seen.length > 256) this.seen.shift();
    const data = typeof callback['data'] === 'string' ? callback['data'] : '';
    const token = ACTION_PAYLOAD_RE.exec(data)?.[1];
    if (token === undefined) {
      await this.answer(id, null, false);
      return;
    }
    const chat = obj(obj(callback['message'])?.['chat']);
    const chatId = chat?.['id'];
    const origin = typeof chatId === 'number' || typeof chatId === 'string' ? String(chatId) : null;
    const subs = [...this.subscribers];
    const sub = subs.find((s) => s.chatId === origin) ?? subs[0];
    if (sub === undefined) {
      await this.answer(id, 'Answering from the chat is switched off.', false);
      return;
    }
    const from = obj(callback['from']);
    const fromId = from?.['id'];
    const result = await sub.handler({
      token,
      origin,
      actor: {
        platform: 'telegram',
        id: typeof fromId === 'number' || typeof fromId === 'string' ? String(fromId) : null,
        name: nameOf(from),
      },
    });
    await this.answer(id, result.text, result.refused && result.outcome === 'not_allowed');
  }
}

/**
 * The Telegram update pollers, one per bot token, shared by the bot's channels (act buttons) and the
 * setup's `/start` wait: Telegram answers 409 to two concurrent `getUpdates` of one bot.
 */
export class TelegramUpdatesHub {
  private readonly bots = new Map<string, BotPoller>();
  private readonly opts: ConstructorParameters<typeof BotPoller>[2];

  constructor(options: TelegramUpdatesOptions = {}) {
    this.opts = {
      fetch: options.fetch ?? fetch,
      apiBase: (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, ''),
      cursors: options.cursors ?? null,
      logger: options.logger?.child({ module: 'notifications' }) ?? null,
      now: options.now ?? Date.now,
      pollSeconds: options.pollSeconds ?? 25,
      lingerMs: options.lingerMs ?? 5_000,
      backoffMs: options.backoffMs ?? { min: 1_000, max: 30_000 },
      offlineRetryMs: options.offlineRetryMs ?? { auth: 5 * 60_000, conflict: 30_000 },
    };
  }

  private poller(token: string): BotPoller {
    let bot = this.bots.get(token);
    if (bot === undefined) {
      bot = new BotPoller(token, this, this.opts);
      this.bots.set(token, bot);
    }
    return bot;
  }

  /** @internal Drops a stopped poller. */
  forget(token: string, bot: BotPoller): void {
    if (this.bots.get(token) === bot) this.bots.delete(token);
  }

  /**
   * The press source of one channel: presses of buttons in `chatId` go to its handler.
   *
   * @returns A {@link PressSource}.
   */
  pressSource(token: string, chatId: string): PressSource {
    return {
      listen: (handler, onStatus) => {
        const bot = this.poller(token);
        const sub: Subscriber = { chatId, handler, onStatus };
        bot.subscribers.add(sub);
        bot.wake();
        return () => {
          bot.subscribers.delete(sub);
          bot.release();
        };
      },
      status: () =>
        this.bots.get(token)?.current() ?? {
          state: 'connecting',
          since: this.opts.now(),
          detail: null,
        },
    };
  }

  /**
   * Waits for a message that `match` accepts (the setup's `/start <code>`), through the bot's
   * poller (started for the wait when no channel runs it).
   *
   * @returns The message, or `null` on abort or deadline.
   */
  waitForMessage(
    token: string,
    match: (message: Record<string, unknown>) => boolean,
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<Record<string, unknown> | null> {
    const bot = this.poller(token);
    return new Promise((resolve) => {
      let done = false;
      const waiter: Waiter = {
        match,
        resolve: (message) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          bot.waiters.delete(waiter);
          resolve(message);
          bot.release();
        },
      };
      const timer = setTimeout(
        () => waiter.resolve(null),
        Math.max(0, options.deadline - this.opts.now()),
      );
      options.signal.addEventListener('abort', () => waiter.resolve(null));
      if (options.signal.aborted) {
        waiter.resolve(null);
        return;
      }
      bot.waiters.add(waiter);
      bot.wake();
    });
  }

  /** Stops every poller (shutdown). */
  stop(): void {
    for (const bot of [...this.bots.values()]) bot.halt();
    this.bots.clear();
  }
}
