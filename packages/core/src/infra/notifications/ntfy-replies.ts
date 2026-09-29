/** @module infra/notifications/ntfy-replies — the reply-topic subscription of an ntfy channel (spec 03 §9.6, D-42): a streaming `GET <server>/<topic>/json` (outbound), resumed after a restart or a dropped connection from the last message id it handled (`since=`), handing every `bh1:<token>` message to the press handler. */

import { ACTION_PAYLOAD_RE } from '@browserhive/contracts/notifications';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  ListenerStatus,
  PressHandler,
  PressSource,
} from '../../ports/notification-channel.ts';
import { type FetchFn, scrubDetail } from './http.ts';
import type { CursorStore } from './telegram-updates.ts';

/** Options of {@link createNtfyReplySource}. */
export interface NtfyReplyOptions {
  readonly server: string;
  /** The reply topic (topic B). Never logged. */
  readonly topic: string;
  /** Bearer token that reads it, or `null`. */
  readonly token: string | null;
  /** `ntfy:<channel_id>`: never the topic, which may be a secret. */
  readonly cursorKey: string;
  readonly cursors?: CursorStore;
  readonly fetch?: FetchFn;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Reconnect when the stream says nothing for this long (ntfy sends keepalives every 45 s). */
  readonly idleMs?: number;
  /** First and longest wait between reconnects; default 1 s and 30 s. */
  readonly backoffMs?: { readonly min: number; readonly max: number };
}

interface NtfyEvent {
  readonly id?: string;
  readonly event?: string;
  readonly message?: string;
}

/**
 * The press source of one ntfy channel. Only one subscription runs per channel; `listen` twice
 * replaces the handler.
 *
 * @returns A {@link PressSource}.
 */
export function createNtfyReplySource(options: NtfyReplyOptions): PressSource {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetch ?? fetch;
  const idleMs = options.idleMs ?? 90_000;
  const backoff = options.backoffMs ?? { min: 1_000, max: 30_000 };
  const secrets = [options.topic, ...(options.token === null ? [] : [options.token])];
  const log = options.logger?.child({ module: 'notifications' });
  let status: ListenerStatus = { state: 'connecting', since: now(), detail: null };
  let handler: PressHandler | null = null;
  let notify: ((s: ListenerStatus) => void) | null = null;
  let abort: AbortController | null = null;

  const setStatus = (state: ListenerStatus['state'], detail: string | null) => {
    if (status.state === state && status.detail === detail) return;
    status = { state, since: now(), detail };
    try {
      notify?.(status);
    } catch {
      // a listener's callback never stops the subscription
    }
  };

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  async function handle(line: string, signal: AbortSignal): Promise<void> {
    let event: NtfyEvent;
    try {
      event = JSON.parse(line) as NtfyEvent;
    } catch {
      return;
    }
    if (event.event !== 'message' || typeof event.id !== 'string') return;
    const token = ACTION_PAYLOAD_RE.exec((event.message ?? '').trim())?.[1];
    if (token !== undefined && handler !== null && !signal.aborted) {
      await handler({ token, origin: null, actor: { platform: 'ntfy', id: null, name: null } });
    }
    await options.cursors?.set(options.cursorKey, event.id).catch(() => undefined);
  }

  async function loop(signal: AbortSignal): Promise<void> {
    let delay = backoff.min;
    const started = Math.floor(now() / 1000);
    while (!signal.aborted) {
      const cursor = await options.cursors?.get(options.cursorKey).catch(() => null);
      const since = cursor ?? String(started);
      const url = `${options.server}/${encodeURIComponent(options.topic)}/json?since=${encodeURIComponent(since)}`;
      const idle = new AbortController();
      const both = AbortSignal.any([signal, idle.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), idleMs);
      };
      try {
        arm();
        const response = await fetchFn(url, {
          headers: {
            'user-agent': 'BrowserHive',
            ...(options.token !== null && { authorization: `Bearer ${options.token}` }),
          },
          signal: both,
        });
        if (response.status === 401 || response.status === 403) {
          setStatus('offline', 'ntfy refused access to the reply topic (check its token).');
          await response.body?.cancel().catch(() => undefined);
          await sleep(5 * 60_000, signal);
          continue;
        }
        if (!response.ok || response.body === null) {
          throw new Error(`ntfy answered ${response.status}`);
        }
        setStatus('connected', null);
        delay = backoff.min;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          arm();
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line !== '') await handle(line, signal);
            nl = buffer.indexOf('\n');
          }
        }
        throw new Error('ntfy closed the stream');
      } catch (err) {
        if (signal.aborted) break;
        setStatus('reconnecting', 'The ntfy reply topic stream dropped; reconnecting.');
        log?.debug('ntfy reply stream', {
          detail: scrubDetail(serializeError(err).message, secrets),
        });
        await sleep(delay, signal);
        delay = Math.min(backoff.max, delay * 2);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    listen(next, onStatus) {
      handler = next;
      notify = onStatus;
      if (abort === null) {
        const controller = new AbortController();
        abort = controller;
        setStatus('connecting', null);
        void loop(controller.signal);
      }
      return () => {
        if (handler === next) {
          handler = null;
          notify = null;
          abort?.abort();
          abort = null;
        }
      };
    },
    status: () => status,
  };
}
