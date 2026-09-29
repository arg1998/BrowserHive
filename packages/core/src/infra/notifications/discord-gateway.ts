/** @module infra/notifications/discord-gateway — the Discord gateway subset BrowserHive needs for act buttons (spec 03 §9.6, D-38, D-41): one outbound WebSocket per bot token (Hello, Identify with intents 0, heartbeats with zombie detection, Resume, Reconnect, Invalid Session, fatal close codes), `INTERACTION_CREATE` presses answered within Discord's 3 seconds, and the setup's "This is me" claim. No dependency: Bun's WebSocket client. */

import { ACTION_PAYLOAD_RE } from '@browserhive/contracts/notifications';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  ChannelSendError,
  type ListenerStatus,
  type PressAnswer,
  type PressHandler,
  type PressSource,
} from '../../ports/notification-channel.ts';
import { callPlatform, type FetchFn } from './http.ts';

/** Discord's REST base (API v10). */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';
/** Prefix of the setup's "This is me" button (`bh1c:<code>`). */
export const CLAIM_PREFIX = 'bh1c:';

/** Gateway opcodes used here. */
const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/** Close codes after which reconnecting cannot help (auth failed, bad intents or version). */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session cannot be resumed. */
const NO_RESUME_CLOSE = new Set([4007, 4009]);

/** Interaction callback types. */
const CALLBACK = { message: 4, deferredMessage: 5, deferredUpdate: 6 } as const;
/** Ephemeral message flag. */
const EPHEMERAL = 64;

/** The minimal WebSocket surface the gateway uses (Bun's global `WebSocket`; fakes in tests). */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Options of {@link DiscordGatewayHub}. */
export interface DiscordGatewayOptions {
  readonly fetch?: FetchFn;
  /** REST base; the fakes pass their own. */
  readonly apiBase?: string;
  /** Opens a socket (default: Bun's `WebSocket`). */
  readonly socket?: (url: string) => GatewaySocket;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Uniform [0, 1) for the first heartbeat's jitter. */
  readonly random?: () => number;
  /** How long a connection outlives its last channel (a registry reload re-subscribes); 5 s. */
  readonly lingerMs?: number;
  /** First and longest wait between reconnects; 1 s and 60 s. */
  readonly backoffMs?: { readonly min: number; readonly max: number };
  /** Retry after a fatal close (a refused token); 5 min. */
  readonly fatalRetryMs?: number;
  /** A press's command gets this long before the answer is deferred (Discord allows 3 s). */
  readonly answerWithinMs?: number;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' ? (value as Json) : null;
}

interface Subscriber {
  readonly channelId: string;
  readonly handler: PressHandler;
  readonly onStatus: (status: ListenerStatus) => void;
}

interface Claim {
  readonly code: string;
  resolve(user: { readonly id: string; readonly name: string } | null): void;
}

/** Who sent an interaction. */
function userOf(interaction: Json): { id: string | null; name: string | null } {
  const user = obj(obj(interaction['member'])?.['user']) ?? obj(interaction['user']);
  const id = user?.['id'];
  const name =
    typeof user?.['global_name'] === 'string'
      ? user['global_name']
      : typeof user?.['username'] === 'string'
        ? user['username']
        : null;
  return { id: typeof id === 'string' ? id : null, name };
}

type Opts = Required<Omit<DiscordGatewayOptions, 'logger' | 'fetch' | 'socket'>> & {
  readonly fetch: FetchFn;
  readonly socket: (url: string) => GatewaySocket;
  readonly logger: Logger | null;
};

class GatewayConnection {
  readonly subscribers = new Set<Subscriber>();
  readonly claims = new Set<Claim>();
  private status: ListenerStatus;
  private socket: GatewaySocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private gatewayUrl: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private firstBeat: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private running = false;
  private delay: number;

  constructor(
    private readonly token: string,
    private readonly hub: DiscordGatewayHub,
    private readonly opts: Opts,
  ) {
    this.status = { state: 'connecting', since: opts.now(), detail: null };
    this.delay = opts.backoffMs.min;
  }

  current(): ListenerStatus {
    return this.status;
  }

  private wanted(): boolean {
    return this.subscribers.size > 0 || this.claims.size > 0;
  }

  wake(): void {
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.running) return;
    this.running = true;
    this.setStatus('connecting', null);
    void this.connect();
  }

  release(): void {
    if (this.wanted() || this.lingerTimer !== null) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (!this.wanted()) this.halt();
    }, this.opts.lingerMs);
  }

  halt(): void {
    this.running = false;
    for (const t of [this.lingerTimer, this.reconnectTimer, this.firstBeat]) {
      if (t !== null) clearTimeout(t);
    }
    this.lingerTimer = null;
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'stopped');
    for (const claim of this.claims) claim.resolve(null);
    this.claims.clear();
    this.hub.forget(this.token, this);
  }

  private setStatus(state: ListenerStatus['state'], detail: string | null): void {
    if (this.status.state === state && this.status.detail === detail) return;
    this.status = { state, since: this.opts.now(), detail };
    for (const sub of this.subscribers) {
      try {
        sub.onStatus(this.status);
      } catch {
        // a listener's callback never stops the gateway
      }
    }
  }

  private rest(path: string, init: { method: string; body?: unknown; auth: boolean }) {
    return callPlatform(
      {
        url: `${this.opts.apiBase}${path}`,
        method: init.method,
        headers: {
          ...(init.auth && { authorization: `Bot ${this.token}` }),
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      },
      { fetch: this.opts.fetch, secrets: [this.token], platform: 'Discord' },
    );
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    let url = this.resumeUrl;
    if (url === null || this.sessionId === null) {
      if (this.gatewayUrl === null) {
        try {
          const answer = await this.rest('/gateway/bot', { method: 'GET', auth: true });
          const found = obj(answer.json)?.['url'];
          if (typeof found !== 'string') throw new ChannelSendError('rejected', 'no gateway url');
          this.gatewayUrl = found;
        } catch (err) {
          const auth = err instanceof ChannelSendError && err.code === 'auth';
          this.retry(
            auth ? 'offline' : 'reconnecting',
            auth ? 'Discord refused the bot token.' : 'Discord could not be reached; retrying.',
            auth ? this.opts.fatalRetryMs : undefined,
          );
          return;
        }
      }
      url = this.gatewayUrl;
    }
    if (!this.running) return;
    let socket: GatewaySocket;
    try {
      socket = this.opts.socket(`${url.replace(/\/+$/, '')}/?v=10&encoding=json`);
    } catch (err) {
      this.opts.logger?.warn('discord gateway failed', { err: serializeError(err) });
      this.retry('reconnecting', 'Discord could not be reached; retrying.');
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      try {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        this.receive(JSON.parse(text) as Json);
      } catch (err) {
        this.opts.logger?.warn('discord gateway failed', { err: serializeError(err) });
      }
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.closed(ev.code);
    };
    socket.onerror = () => undefined; // onclose follows
  }

  private send(payload: Json): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      // the close handler reconnects
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.firstBeat !== null) clearTimeout(this.firstBeat);
    this.heartbeat = null;
    this.firstBeat = null;
  }

  private beat(): void {
    if (!this.acked) {
      // A zombie connection: no ACK since the last heartbeat. Reconnect and resume.
      this.opts.logger?.warn('discord gateway zombie', {});
      const socket = this.socket;
      this.socket = null;
      socket?.close(4000, 'zombie');
      this.closed(4000);
      return;
    }
    this.acked = false;
    this.send({ op: OP.heartbeat, d: this.seq });
  }

  private receive(payload: Json): void {
    const op = payload['op'];
    if (typeof payload['s'] === 'number') this.seq = payload['s'];
    switch (op) {
      case OP.hello: {
        const interval = Number(obj(payload['d'])?.['heartbeat_interval'] ?? 41_250);
        this.stopHeartbeat();
        this.acked = true;
        this.firstBeat = setTimeout(
          () => {
            this.beat();
            this.heartbeat = setInterval(() => this.beat(), interval);
          },
          Math.floor(interval * this.opts.random()),
        );
        if (this.sessionId !== null && this.seq !== null) {
          this.send({
            op: OP.resume,
            d: { token: this.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: OP.identify,
            d: {
              token: this.token,
              intents: 0,
              properties: { os: process.platform, browser: 'BrowserHive', device: 'BrowserHive' },
            },
          });
        }
        return;
      }
      case OP.heartbeatAck:
        this.acked = true;
        return;
      case OP.heartbeat:
        this.send({ op: OP.heartbeat, d: this.seq });
        return;
      case OP.reconnect: {
        const socket = this.socket;
        this.socket = null;
        socket?.close(4000, 'reconnect');
        this.closed(4000, true);
        return;
      }
      case OP.invalidSession: {
        if (payload['d'] !== true) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        const socket = this.socket;
        this.socket = null;
        socket?.close(4000, 'invalid session');
        this.closed(4000, true);
        return;
      }
      case OP.dispatch: {
        const type = payload['t'];
        const d = obj(payload['d']) ?? {};
        if (type === 'READY') {
          this.sessionId = typeof d['session_id'] === 'string' ? d['session_id'] : null;
          this.resumeUrl =
            typeof d['resume_gateway_url'] === 'string' ? d['resume_gateway_url'] : null;
          this.delay = this.opts.backoffMs.min;
          this.setStatus('connected', null);
        } else if (type === 'RESUMED') {
          this.delay = this.opts.backoffMs.min;
          this.setStatus('connected', null);
        } else if (type === 'INTERACTION_CREATE') {
          void this.interaction(d).catch((err: unknown) =>
            this.opts.logger?.warn('discord press failed', { err: serializeError(err) }),
          );
        }
        return;
      }
    }
  }

  private closed(code: number, immediate = false): void {
    this.stopHeartbeat();
    if (!this.running) return;
    if (FATAL_CLOSE.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeUrl = null;
      this.retry(
        'offline',
        code === 4004 ? 'Discord refused the bot token.' : `Discord closed the gateway (${code}).`,
        this.opts.fatalRetryMs,
      );
      return;
    }
    if (NO_RESUME_CLOSE.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeUrl = null;
    }
    this.retry('reconnecting', 'Reconnecting to Discord.', immediate ? 0 : undefined);
  }

  private retry(state: ListenerStatus['state'], detail: string, waitMs?: number): void {
    this.setStatus(state, detail);
    if (!this.running) return;
    const wait = waitMs ?? this.delay;
    if (waitMs === undefined) this.delay = Math.min(this.opts.backoffMs.max, this.delay * 2);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  private async callback(interaction: Json, body: Json): Promise<void> {
    const id = interaction['id'];
    const token = interaction['token'];
    if (typeof id !== 'string' || typeof token !== 'string') return;
    await this.rest(`/interactions/${id}/${token}/callback`, {
      method: 'POST',
      body,
      auth: false,
    });
  }

  private async followUp(interaction: Json, content: string): Promise<void> {
    const app = interaction['application_id'];
    const token = interaction['token'];
    if (typeof app !== 'string' || typeof token !== 'string') return;
    await this.rest(`/webhooks/${app}/${token}/messages/@original`, {
      method: 'PATCH',
      body: { content },
      auth: false,
    });
  }

  private async interaction(interaction: Json): Promise<void> {
    if (interaction['type'] !== 3) return; // only message components carry our buttons
    const data = obj(interaction['data']);
    const customId = typeof data?.['custom_id'] === 'string' ? data['custom_id'] : '';
    const user = userOf(interaction);
    if (customId.startsWith(CLAIM_PREFIX)) {
      const code = customId.slice(CLAIM_PREFIX.length);
      const claim = [...this.claims].find((c) => c.code === code);
      if (claim === undefined || user.id === null) {
        await this.callback(interaction, {
          type: CALLBACK.message,
          data: { content: 'This link has expired; start again in BrowserHive.', flags: EPHEMERAL },
        });
        return;
      }
      await this.callback(interaction, {
        type: CALLBACK.message,
        data: {
          content: 'Linked. You can now answer BrowserHive requests in this channel.',
          flags: EPHEMERAL,
        },
      });
      this.claims.delete(claim);
      claim.resolve({ id: user.id, name: user.name ?? user.id });
      return;
    }
    const token = ACTION_PAYLOAD_RE.exec(customId)?.[1];
    if (token === undefined) {
      await this.callback(interaction, { type: CALLBACK.deferredUpdate });
      return;
    }
    const channelId =
      typeof interaction['channel_id'] === 'string' ? interaction['channel_id'] : null;
    const subs = [...this.subscribers];
    const sub = subs.find((s) => s.channelId === channelId) ?? subs[0];
    if (sub === undefined) {
      await this.callback(interaction, {
        type: CALLBACK.message,
        data: { content: 'Answering from Discord is switched off.', flags: EPHEMERAL },
      });
      return;
    }
    const answer = sub.handler({
      token,
      origin: channelId,
      actor: { platform: 'discord', id: user.id, name: user.name },
    });
    // Discord allows 3 seconds: answer directly when the command is quick, else defer and edit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.opts.answerWithinMs);
    });
    const quick: PressAnswer | null = await Promise.race([answer, timeout]);
    clearTimeout(timer);
    if (quick !== null) {
      await this.callback(interaction, {
        type: CALLBACK.message,
        data: { content: quick.text, flags: EPHEMERAL },
      });
      return;
    }
    await this.callback(interaction, {
      type: CALLBACK.deferredMessage,
      data: { flags: EPHEMERAL },
    });
    const late = await answer;
    await this.followUp(interaction, late.text);
  }
}

/**
 * The gateway connections, one per bot token, shared by the bot's channels (act buttons) and the
 * setup's "This is me" claim.
 */
export class DiscordGatewayHub {
  private readonly bots = new Map<string, GatewayConnection>();
  private readonly opts: Opts;

  constructor(options: DiscordGatewayOptions = {}) {
    this.opts = {
      fetch: options.fetch ?? fetch,
      apiBase: (options.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, ''),
      socket: options.socket ?? ((url) => new WebSocket(url) as unknown as GatewaySocket),
      logger: options.logger?.child({ module: 'notifications' }) ?? null,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      lingerMs: options.lingerMs ?? 5_000,
      backoffMs: options.backoffMs ?? { min: 1_000, max: 60_000 },
      fatalRetryMs: options.fatalRetryMs ?? 5 * 60_000,
      answerWithinMs: options.answerWithinMs ?? 2_000,
    };
  }

  private connection(token: string): GatewayConnection {
    let bot = this.bots.get(token);
    if (bot === undefined) {
      bot = new GatewayConnection(token, this, this.opts);
      this.bots.set(token, bot);
    }
    return bot;
  }

  /** @internal Drops a stopped connection. */
  forget(token: string, bot: GatewayConnection): void {
    if (this.bots.get(token) === bot) this.bots.delete(token);
  }

  /**
   * The press source of one channel: presses of buttons in `channelId` go to its handler.
   *
   * @returns A {@link PressSource}.
   */
  pressSource(token: string, channelId: string): PressSource {
    return {
      listen: (handler, onStatus) => {
        const bot = this.connection(token);
        const sub: Subscriber = { channelId, handler, onStatus };
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
   * Waits for the press of a "This is me" button whose `custom_id` is `bh1c:<code>`.
   *
   * @returns Who pressed it, or `null` on abort or deadline.
   */
  waitForClaim(
    token: string,
    code: string,
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    const bot = this.connection(token);
    return new Promise((resolve) => {
      let done = false;
      const claim: Claim = {
        code,
        resolve: (user) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          bot.claims.delete(claim);
          resolve(user);
          bot.release();
        },
      };
      const timer = setTimeout(
        () => claim.resolve(null),
        Math.max(0, options.deadline - this.opts.now()),
      );
      options.signal.addEventListener('abort', () => claim.resolve(null));
      if (options.signal.aborted) {
        claim.resolve(null);
        return;
      }
      bot.claims.add(claim);
      bot.wake();
    });
  }

  /** Closes every connection (shutdown). */
  stop(): void {
    for (const bot of [...this.bots.values()]) bot.halt();
    this.bots.clear();
  }
}
