/** @module lib/ws/store — injectable socket store: handshake, heartbeat, refcounted topics with cursors, correlated commands, binary screencast streams, bounded backoff (spec 04 §4.2) */
import { API_PREFIX } from '@browserhive/contracts/http';
import {
  readScreencastHeader,
  type ScreencastControl,
  type ScreencastFrameHeader,
  WS_CLOSE,
  WS_PATH,
  WS_PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type WsClientCommand,
  type WsFeedEvent,
  type WsReplyPayload,
  WsServerMessage,
} from '@browserhive/contracts/ws';
import { AppError, timeoutError } from '../api/errors.ts';
import { browserClock, browserTimers, type Clock, type Timers } from '../clock.ts';

/** Connection status shown by the health pill. */
export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'offline';
/** Why the socket is offline (`null` while connected/connecting). */
export type OfflineReason =
  | 'network'
  | 'unauthorized'
  | 'password_change'
  | 'protocol'
  | 'disposed';

/** Observable state. */
export interface SocketState {
  readonly status: SocketStatus;
  readonly reason: OfflineReason | null;
  /** The daemon speaks another protocol version: "Dashboard is out of date, reload". */
  readonly protocolMismatch: boolean;
  readonly attempt: number;
  readonly epoch: string | null;
  readonly serverVersion: string | null;
}

/** The subset of `WebSocket` the store uses; tests inject a fake. */
export interface WebSocketLike {
  readyState: number;
  binaryType: BinaryType;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}
/** `WebSocket.OPEN`. */
export const WS_OPEN = 1;
/** Socket factory. */
export type SocketFactory = (url: string, protocols: readonly string[]) => WebSocketLike;

/** Adapt a real `WebSocket` to the store's structural interface (handler property types differ). */
export function adaptWebSocket(ws: WebSocket): WebSocketLike {
  const like: WebSocketLike = {
    get readyState() {
      return ws.readyState;
    },
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value: BinaryType) {
      ws.binaryType = value;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
  ws.onopen = (event) => like.onopen?.(event);
  ws.onmessage = (event) => like.onmessage?.(event);
  ws.onclose = (event) => like.onclose?.(event);
  ws.onerror = (event) => like.onerror?.(event);
  return like;
}

/** Feed handler. */
export type FeedHandler = (
  event: WsFeedEvent,
  meta: { readonly topic: string; readonly seq: number; readonly ts: number },
) => void;
/** Binary frame. */
export interface ScreencastFrame {
  readonly header: ScreencastFrameHeader;
  readonly jpeg: Uint8Array;
}
/** Stream handlers. */
export interface StreamHandlers {
  readonly frame: (frame: ScreencastFrame) => void;
  readonly control?: (control: ScreencastControl) => void;
}

/** Hooks the providers plug in (bridge, toasts, auth). */
export interface SocketHooks {
  readonly onEvent?: FeedHandler;
  /** `connecting → connected` after a previous connection: REST is the truth after a gap. */
  readonly onReconnected?: () => void;
  readonly onResync?: (
    reason: 'cursor_expired' | 'epoch_changed' | 'buffer_overflow',
    topic?: string,
  ) => void;
  readonly onUnauthorized?: () => void;
  readonly onPasswordChangeRequired?: () => void;
  readonly onProtocolMismatch?: () => void;
  /** A send was dropped because the socket is not connected (never silent). */
  readonly onDrop?: (command: WsClientCommand) => void;
  readonly onServerNow?: (now: number) => void;
}

/** Store options; every timing is injectable. */
export interface SocketStoreOptions {
  readonly url: string;
  readonly createSocket?: SocketFactory;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly hooks?: SocketHooks;
  readonly heartbeatMs?: number;
  readonly staleMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly jitterMs?: number;
  readonly dedupeSize?: number;
  /** Consecutive failed attempts before the pill shows `offline` (retries continue at the cap). */
  readonly offlineAfterAttempts?: number;
  readonly commandTimeoutMs?: number;
}

/** Topic whose event `seq` is not unique (the feed head at publish time). */
const UNSEQUENCED_TOPIC = 'logs';

/** Heartbeat and backoff constants (spec 04 §4.2). */
export const SOCKET_DEFAULTS = {
  heartbeatMs: 20_000,
  staleMs: 45_000,
  backoffBaseMs: 500,
  backoffCapMs: 8_000,
  jitterMs: 250,
  dedupeSize: 1_000,
  offlineAfterAttempts: 3,
  commandTimeoutMs: 10_000,
} as const;

/** Build the socket URL for the current page origin. */
export function socketUrl(location: { readonly protocol: string; readonly host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${API_PREFIX}${WS_PATH}`;
}

interface Topic {
  readonly handlers: Set<FeedHandler>;
  cursor: number | undefined;
  readonly seen: Set<number>;
  readonly order: number[];
}
interface Pending {
  readonly resolve: (payload: WsReplyPayload) => void;
  readonly reject: (error: AppError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
type CommandParams<T extends WsClientCommand['type']> = Omit<
  Extract<WsClientCommand, { type: T }>,
  'type' | 'corr'
>;

/** The socket store. One per app instance, constructed in `SocketProvider`. */
export class SocketStore {
  private state: SocketState = {
    status: 'idle',
    reason: null,
    protocolMismatch: false,
    attempt: 0,
    epoch: null,
    serverVersion: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly topics = new Map<string, Topic>();
  private readonly streams = new Map<string, Set<StreamHandlers>>();
  private readonly ordinalTopics = new Map<number, string>();
  private readonly ordinalSeq = new Map<number, number>();
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocketLike | null = null;
  private started = false;
  private everConnected = false;
  private lastFrameAt = 0;
  private corrSeq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createSocket: SocketFactory;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly hooks: SocketHooks;
  private readonly cfg: { readonly [K in keyof typeof SOCKET_DEFAULTS]: number };

  constructor(private readonly options: SocketStoreOptions) {
    this.createSocket =
      options.createSocket ??
      ((url, protocols) => adaptWebSocket(new WebSocket(url, [...protocols])));
    this.clock = options.clock ?? browserClock;
    this.timers = options.timers ?? browserTimers;
    this.random = options.random ?? Math.random;
    this.hooks = options.hooks ?? {};
    this.cfg = {
      heartbeatMs: options.heartbeatMs ?? SOCKET_DEFAULTS.heartbeatMs,
      staleMs: options.staleMs ?? SOCKET_DEFAULTS.staleMs,
      backoffBaseMs: options.backoffBaseMs ?? SOCKET_DEFAULTS.backoffBaseMs,
      backoffCapMs: options.backoffCapMs ?? SOCKET_DEFAULTS.backoffCapMs,
      jitterMs: options.jitterMs ?? SOCKET_DEFAULTS.jitterMs,
      dedupeSize: options.dedupeSize ?? SOCKET_DEFAULTS.dedupeSize,
      offlineAfterAttempts: options.offlineAfterAttempts ?? SOCKET_DEFAULTS.offlineAfterAttempts,
      commandTimeoutMs: options.commandTimeoutMs ?? SOCKET_DEFAULTS.commandTimeoutMs,
    };
  }

  /** Current state (stable reference between changes, for `useSyncExternalStore`). */
  getState(): SocketState {
    return this.state;
  }

  /** Observe state changes. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Open the socket (idempotent). */
  connect(): void {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  /** Close the socket, stop every timer and reject pending commands. */
  dispose(): void {
    this.started = false;
    this.clearReconnect();
    this.stopHeartbeat();
    this.rejectPending(
      new AppError({ code: 'ABORTED', status: 0, title: 'Socket disposed', retryable: 'never' }),
    );
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.close(1000, 'dispose');
    }
    this.setState({ status: 'idle', reason: 'disposed', attempt: 0 });
  }

  /** Subscribe to a feed topic (refcounted). Replays continue from the last seen `seq`. */
  subscribe(topic: string, handler: FeedHandler): () => void {
    let entry = this.topics.get(topic);
    if (entry === undefined) {
      entry = { handlers: new Set(), cursor: undefined, seen: new Set(), order: [] };
      this.topics.set(topic, entry);
      if (this.state.status === 'connected') this.sendSubscribe(topic, entry);
    }
    entry.handlers.add(handler);
    return () => {
      const current = this.topics.get(topic);
      if (current === undefined) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.topics.delete(topic);
        if (this.state.status === 'connected') this.send({ type: 'unsubscribe', topic });
      }
    };
  }

  /** Send a command and await its correlated reply. Rejects with `AppError` when dropped, errored or timed out. */
  command<T extends WsClientCommand['type']>(
    type: T,
    params: CommandParams<T>,
  ): Promise<WsReplyPayload> {
    this.corrSeq += 1;
    const corr = `c${this.corrSeq}`;
    const command = { type, ...params, corr } as WsClientCommand;
    return new Promise((resolve, reject) => {
      if (!this.send(command)) {
        reject(
          new AppError({
            code: 'NETWORK_ERROR',
            status: 0,
            title: 'Not connected',
            message: `Dropped ${type}: the realtime socket is not connected.`,
            retryable: 'backoff',
          }),
        );
        return;
      }
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(corr);
        reject(timeoutError(this.cfg.commandTimeoutMs));
      }, this.cfg.commandTimeoutMs);
      this.pending.set(corr, { resolve, reject, timer });
    });
  }

  /** Receive binary frames and control messages for a `screencast:<id>` topic. */
  stream(topic: string, handlers: StreamHandlers): () => void {
    let set = this.streams.get(topic);
    if (set === undefined) {
      set = new Set();
      this.streams.set(topic, set);
    }
    set.add(handlers);
    return () => {
      const current = this.streams.get(topic);
      if (current === undefined) return;
      current.delete(handlers);
      if (current.size === 0) this.streams.delete(topic);
    };
  }

  /** Topics with at least one subscriber (for tests and the health pill tooltip). */
  activeTopics(): readonly string[] {
    return [...this.topics.keys()];
  }

  // -- connection --------------------------------------------------------------------------------

  private open(): void {
    if (!this.started || this.socket !== null) return;
    const socket = this.createSocket(this.options.url, [WS_SUBPROTOCOL]);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setState({
      status: this.state.attempt >= this.cfg.offlineAfterAttempts ? 'offline' : 'connecting',
      reason: this.state.attempt >= this.cfg.offlineAfterAttempts ? 'network' : null,
    });
    socket.onopen = () => {
      this.lastFrameAt = this.clock();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.clock();
      if (typeof event.data === 'string') this.onText(event.data);
      else if (event.data instanceof ArrayBuffer) this.onBinary(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.rejectPending(
        new AppError({
          code: 'NETWORK_ERROR',
          status: 0,
          title: 'Socket closed',
          retryable: 'backoff',
        }),
      );
      this.onClosed(event.code);
    };
    socket.onerror = () => {
      // `onclose` always follows; reconnect logic lives there.
    };
  }

  private onClosed(code: number): void {
    switch (code) {
      case WS_CLOSE.UNAUTHORIZED:
        this.started = false;
        this.setState({ status: 'offline', reason: 'unauthorized' });
        this.hooks.onUnauthorized?.();
        return;
      case WS_CLOSE.PASSWORD_CHANGE_REQUIRED:
        this.started = false;
        this.setState({ status: 'offline', reason: 'password_change' });
        this.hooks.onPasswordChangeRequired?.();
        return;
      case WS_CLOSE.BAD_SUBPROTOCOL:
      case WS_CLOSE.PROTOCOL_ERROR:
        this.started = false;
        this.setState({ status: 'offline', reason: 'protocol', protocolMismatch: true });
        this.hooks.onProtocolMismatch?.();
        return;
      default:
        if (this.state.protocolMismatch) return;
        if (this.started) this.scheduleReconnect();
        else this.setState({ status: 'idle', reason: null });
    }
  }

  private scheduleReconnect(): void {
    const attempt = this.state.attempt;
    const delay =
      Math.min(this.cfg.backoffBaseMs * 2 ** attempt, this.cfg.backoffCapMs) +
      this.random() * this.cfg.jitterMs;
    const next = attempt + 1;
    this.setState({
      attempt: next,
      status: next > this.cfg.offlineAfterAttempts ? 'offline' : 'connecting',
      reason: next > this.cfg.offlineAfterAttempts ? 'network' : null,
    });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -- frames ------------------------------------------------------------------------------------

  private onText(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = WsServerMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.kind) {
      case 'reply':
        this.onReply(message.corr, message.payload);
        return;
      case 'event':
        this.onEvent(message.topic, message.seq, message.ts, message.payload);
        return;
      case 'error': {
        const pending = message.corr === undefined ? undefined : this.pending.get(message.corr);
        if (pending !== undefined && message.corr !== undefined) {
          this.pending.delete(message.corr);
          this.timers.clearTimeout(pending.timer);
          pending.reject(
            new AppError({
              code: 'INTERNAL_ERROR',
              status: 0,
              title: message.payload.title,
              message: message.payload.title,
              retryable: 'never',
              details: { code: message.payload.code, details: message.payload.details },
            }),
          );
        }
        return;
      }
      case 'stream':
        this.onStream(message.topic, message.payload);
        return;
      default:
        return;
    }
  }

  private onReply(corr: string | undefined, payload: WsReplyPayload): void {
    if (payload.type === 'hello') {
      this.onHello(payload);
      return;
    }
    if (payload.type === 'screencast.started')
      this.ordinalTopics.set(payload.ordinal, payload.topic);
    if (payload.type === 'subscribed' && !payload.complete) {
      this.hooks.onResync?.('cursor_expired', payload.topic);
    }
    if (payload.type === 'resync_required') this.hooks.onResync?.(payload.reason, payload.topic);
    if (corr === undefined) return;
    const pending = this.pending.get(corr);
    if (pending === undefined) return;
    this.pending.delete(corr);
    this.timers.clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  private onHello(hello: Extract<WsReplyPayload, { type: 'hello' }>): void {
    if (hello.protocol_version !== WS_PROTOCOL_VERSION) {
      this.started = false;
      this.setState({ status: 'offline', reason: 'protocol', protocolMismatch: true });
      this.hooks.onProtocolMismatch?.();
      this.socket?.close(1000, 'protocol mismatch');
      return;
    }
    const epochChanged = this.state.epoch !== null && this.state.epoch !== hello.epoch;
    if (epochChanged) {
      for (const topic of this.topics.values()) {
        topic.cursor = undefined;
        topic.seen.clear();
        topic.order.length = 0;
      }
      this.hooks.onResync?.('epoch_changed');
    }
    const reconnected = this.everConnected;
    this.everConnected = true;
    this.setState({
      status: 'connected',
      reason: null,
      attempt: 0,
      epoch: hello.epoch,
      serverVersion: hello.server_version,
    });
    this.hooks.onServerNow?.(hello.now);
    for (const [topic, entry] of this.topics) this.sendSubscribe(topic, entry);
    if (reconnected) this.hooks.onReconnected?.();
    this.startHeartbeat();
  }

  private onEvent(topic: string, seq: number, ts: number, payload: WsFeedEvent): void {
    if (payload.type === 'system.tick') this.hooks.onServerNow?.(payload.now);
    const entry = this.topics.get(topic);
    // `logs` frames are unbuffered and carry the feed head as `seq` (many records share one), so they
    // are neither deduped nor used as a replay cursor.
    if (entry !== undefined && topic !== UNSEQUENCED_TOPIC) {
      if (entry.seen.has(seq)) return;
      entry.seen.add(seq);
      entry.order.push(seq);
      if (entry.order.length > this.cfg.dedupeSize) {
        const oldest = entry.order.shift();
        if (oldest !== undefined) entry.seen.delete(oldest);
      }
      entry.cursor = entry.cursor === undefined ? seq : Math.max(entry.cursor, seq);
    }
    const meta = { topic, seq, ts };
    this.hooks.onEvent?.(payload, meta);
    if (entry === undefined) return;
    for (const handler of entry.handlers) {
      try {
        handler(payload, meta);
      } catch {
        // One subscriber's failure must not starve the others.
      }
    }
  }

  private onStream(topic: string, control: ScreencastControl): void {
    if (control.type === 'started' || control.type === 'meta') {
      this.ordinalTopics.set(control.ordinal, topic);
    }
    const handlers = this.streams.get(topic);
    if (handlers === undefined) return;
    for (const h of handlers) h.control?.(control);
  }

  private onBinary(bytes: Uint8Array): void {
    const header = readScreencastHeader(bytes);
    if (header === null) return;
    const last = this.ordinalSeq.get(header.ordinal);
    if (last !== undefined && header.seq <= last) return; // latest-wins
    this.ordinalSeq.set(header.ordinal, header.seq);
    const topic = this.ordinalTopics.get(header.ordinal);
    if (topic === undefined) return;
    const handlers = this.streams.get(topic);
    if (handlers === undefined) return;
    const frame: ScreencastFrame = { header, jpeg: bytes.subarray(16) };
    for (const h of handlers) h.frame(frame);
  }

  // -- plumbing ----------------------------------------------------------------------------------

  private sendSubscribe(topic: string, entry: Topic): void {
    this.send({
      type: 'subscribe',
      topic,
      ...(entry.cursor !== undefined && { cursor: entry.cursor }),
    });
  }

  private send(command: WsClientCommand): boolean {
    if (this.socket === null || this.socket.readyState !== WS_OPEN) {
      this.hooks.onDrop?.(command);
      return false;
    }
    this.socket.send(JSON.stringify(command));
    return true;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = this.timers.setInterval(() => {
      if (this.socket === null || this.socket.readyState !== WS_OPEN) return;
      if (this.clock() - this.lastFrameAt > this.cfg.staleMs) {
        // Half-open socket (server gone without a FIN): force the close/reconnect path.
        this.socket.close(4000, 'stale');
        return;
      }
      this.send({ type: 'ping' });
    }, this.cfg.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      this.timers.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private rejectPending(error: AppError): void {
    for (const [corr, pending] of this.pending) {
      this.pending.delete(corr);
      this.timers.clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private setState(patch: Partial<SocketState>): void {
    const next = { ...this.state, ...patch };
    if (
      next.status === this.state.status &&
      next.reason === this.state.reason &&
      next.protocolMismatch === this.state.protocolMismatch &&
      next.attempt === this.state.attempt &&
      next.epoch === this.state.epoch &&
      next.serverVersion === this.state.serverVersion
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
