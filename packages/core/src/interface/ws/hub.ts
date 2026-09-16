/** @module interface/ws/hub — connection registry, handshake, topics with replay, backpressure and command dispatch (spec 03 §6, D-10). */

import type { RealtimeConnection } from '@browserhive/contracts/http';
import {
  parseTopic,
  WS_CLOSE,
  WS_PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  WS_TOPIC_SCOPES,
  type WsClientCommand,
  writeScreencastHeader,
} from '@browserhive/contracts/ws';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { z } from 'zod';
import { authorizer } from '../../domain/auth/authorizer.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { runWithRequestContext } from '../../kernel/context.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import { randomHex } from '../http/middleware/trace-ids.ts';
import { logEntryToWire } from '../http/serializers/system.ts';
import type { LogEntry } from '../http/services.ts';
import {
  commandScope,
  type HubCommandHost,
  type LiveViewPort,
  runCommand,
} from './commands/index.ts';
import { WsConnection } from './connection.ts';
import { FeedBuffer } from './feed-buffer.ts';
import { errorFrame, eventFrame, type FeedEvent, replyFrame, streamFrame } from './frames.ts';
import {
  DEFAULT_HUB_LIMITS,
  type HubLimits,
  isScreencastCommand,
  matchesLogFilter,
  parseCommand,
} from './hub-support.ts';
import type { WsSocket } from './socket.ts';

/** Dependencies of {@link RealtimeHub}. */
export interface RealtimeHubDeps {
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'opaque'>;
  readonly logger: Logger;
  /** Slides the operator session on every command (incl. `ping`); `false` → close 4401. */
  readonly auth: { touchSession(authSessionId: string): Promise<boolean> };
  readonly attention: { isInputPermitted(sessionId: string, command: 'input'): boolean };
  readonly liveView: LiveViewPort;
  readonly serverVersion: string;
  /** Changes on every daemon start; clients holding a cursor from another epoch re-seed. */
  readonly epoch: string;
  readonly limits?: Partial<HubLimits>;
  readonly degradations?: DegradationReporter;
}

/** The realtime hub. One instance per process. */
export class RealtimeHub implements HubCommandHost {
  readonly liveView: LiveViewPort;
  private readonly conns = new Set<WsConnection>();
  private readonly feed: FeedBuffer;
  private readonly limits: HubLimits;
  private readonly log: Logger;
  private readonly tracer = trace.getTracer('browserhive');

  constructor(private readonly deps: RealtimeHubDeps) {
    this.liveView = deps.liveView;
    this.limits = { ...DEFAULT_HUB_LIMITS, ...deps.limits };
    this.feed = new FeedBuffer(this.limits, () => deps.clock.now());
    this.log = deps.logger.child({ module: 'ws.hub' });
  }

  /** Highest feed `seq`. */
  get cursor(): number {
    return this.feed.head;
  }

  /** Registers an authenticated socket and sends `hello`. */
  open(socket: WsSocket, principal: RequestPrincipal): WsConnection {
    const conn = new WsConnection(`c-${this.deps.ids.opaque(10)}`, socket, principal, this.now());
    this.conns.add(conn);
    this.reply(conn, {
      type: 'hello',
      protocol: WS_SUBPROTOCOL,
      protocol_version: WS_PROTOCOL_VERSION,
      epoch: this.deps.epoch,
      cursor: this.feed.head,
      server_version: this.deps.serverVersion,
      now: this.now(),
    });
    this.log.info('ws connected', { connection_id: conn.id, principal: principal.subject });
    return conn;
  }

  /** Handles one inbound frame. Never throws. */
  async message(conn: WsConnection, data: string | Uint8Array): Promise<void> {
    if (conn.closed) return;
    conn.lastSeenAt = this.now();
    if (typeof data !== 'string') {
      this.violation(conn, new AppError('WS_PROTOCOL_ERROR', { violations: ['binary frame'] }));
      return;
    }
    if (Buffer.byteLength(data) > this.limits.maxInboundFrameBytes) {
      const limit = this.limits.maxInboundFrameBytes;
      this.violation(conn, new AppError('PAYLOAD_TOO_LARGE', { limit_bytes: limit }));
      return;
    }
    const command = parseCommand(data);
    if (!command.success) {
      this.violation(conn, new AppError('WS_PROTOCOL_ERROR', { violations: command.issues }));
      return;
    }
    const parsed = command.data;
    if (isScreencastCommand(parsed)) {
      await conn.serial(`screencast:${parsed.session_id}`, () => this.dispatch(conn, parsed));
      return;
    }
    await this.dispatch(conn, parsed);
  }

  /** Socket closed by the peer or by us: releases topics and screencasts. */
  close(conn: WsConnection): void {
    if (!this.conns.delete(conn)) return;
    conn.closed = true;
    for (const sessionId of conn.screencasts.keys()) {
      void this.liveView.removeViewer(sessionId, conn.id);
    }
    conn.screencasts.clear();
    this.log.info('ws disconnected', { connection_id: conn.id });
  }

  /** The socket drained: sends each screencast's pending (latest) frame. */
  drain(conn: WsConnection): void {
    conn.congested = false;
    conn.overloadSince = null;
    for (const sub of conn.screencasts.values()) {
      const pending = sub.pending;
      sub.pending = undefined;
      if (pending !== undefined && !conn.congested) this.writeFrame(conn, pending);
    }
  }

  /** Publishes one ordered, replayable feed event on `topic`. */
  publish(topic: string, event: FeedEvent): void {
    const frame = this.feed.append(topic, (seq, ts) => eventFrame(seq, ts, topic, event));
    const recipients = [...this.conns].filter((c) => c.topics.has(topic));
    const span = this.tracer.startSpan('ws.broadcast', {
      attributes: { 'browserhive.ws.topic': topic, 'browserhive.ws.recipients': recipients.length },
    });
    for (const conn of recipients) this.sendFeed(conn, frame.text);
    span.end();
  }

  /** Delivers a log record to `logs` subscribers (droppable, not buffered, `seq` = feed head). */
  publishLog(entry: LogEntry): void {
    const record = logEntryToWire(entry);
    const text = eventFrame(this.feed.head, this.now(), 'logs', { type: 'log.record', record });
    for (const conn of this.conns) {
      if (!conn.topics.has('logs') || !matchesLogFilter(conn, entry)) continue;
      if (conn.socket.bufferedAmount() > this.limits.screencastDropBytes) continue;
      conn.send(text);
    }
  }

  /** Closes every socket riding on an operator session (logout, revocation) with 4401. */
  closeAuthSession(authSessionId: string): void {
    for (const conn of [...this.conns]) {
      if (conn.authSessionId !== authSessionId) continue;
      conn.close(WS_CLOSE.UNAUTHORIZED, 'session ended');
      this.close(conn);
    }
  }

  /** Reaps sockets silent for `staleMs` (1001) and those overloaded past the grace (1013). */
  sweep(): void {
    const now = this.now();
    for (const conn of [...this.conns]) {
      if (now - conn.lastSeenAt > this.limits.staleMs) {
        conn.close(WS_CLOSE.GOING_AWAY, 'connection stale');
        this.close(conn);
        continue;
      }
      this.checkOverload(conn, now);
    }
  }

  /** Closes every socket with 1001 (shutdown). */
  dispose(): void {
    for (const conn of [...this.conns]) {
      conn.close(WS_CLOSE.GOING_AWAY, 'server shutting down');
      this.close(conn);
    }
  }

  /** `GET /system/realtime`. */
  connections(): readonly z.input<typeof RealtimeConnection>[] {
    return [...this.conns].map((c) => ({
      connection_id: c.id,
      principal: c.principal.subject,
      connected_at: c.connectedAt,
      last_seen_at: c.lastSeenAt,
      topics: [...c.topics],
      screencasts: [...c.screencasts.keys()],
      buffered_bytes: c.socket.bufferedAmount(),
      dropped_frames: c.droppedFrames,
      messages_out: c.messagesOut,
    }));
  }

  /** Sessions currently screencasting. */
  activeScreencasts(): number {
    return this.liveView.activeCount;
  }

  /** True when the session has live viewers. */
  hasViewers(sessionId: string): boolean {
    return this.liveView.hasViewers(sessionId);
  }

  // --- HubCommandHost ---------------------------------------------------------------------------

  /** See {@link HubCommandHost.isInputPermitted}. */
  isInputPermitted(sessionId: string, command: 'input'): boolean {
    return this.deps.attention.isInputPermitted(sessionId, command);
  }

  /** Server clock. */
  now(): number {
    return this.deps.clock.now();
  }

  /** Sends a `reply` frame. */
  reply(conn: WsConnection, payload: Parameters<typeof replyFrame>[2], corr?: string): void {
    conn.send(replyFrame(this.feed.head, this.now(), payload, corr));
  }

  /** Sends a `stream` control frame. */
  stream(conn: WsConnection, topic: string, payload: Parameters<typeof streamFrame>[3]): void {
    conn.send(streamFrame(this.feed.head, this.now(), topic, payload));
  }

  /** See {@link HubCommandHost.subscribe}. */
  subscribe(conn: WsConnection, topic: string, cursor: number | undefined, corr?: string): void {
    const parsed = parseTopic(topic);
    if (parsed === null) throw new AppError('WS_PROTOCOL_ERROR', { violations: ['unknown topic'] });
    const scopeKey = parsed.kind === 'static' ? parsed.name : parsed.kind;
    const scope = WS_TOPIC_SCOPES[scopeKey];
    if (!authorizer.can(conn.principal, scope)) throw new AppError('FORBIDDEN', { scope });
    conn.topics.add(topic);
    const head = this.feed.head;
    if (cursor === undefined) {
      this.reply(conn, { type: 'subscribed', topic, from: head, to: head, complete: true }, corr);
      return;
    }
    const replay = this.feed.replay(cursor, (t) => t === topic);
    if (!replay.complete) {
      this.reply(
        conn,
        { type: 'subscribed', topic, from: cursor, to: head, complete: false },
        corr,
      );
      this.reply(conn, { type: 'resync_required', topic, reason: 'cursor_expired' });
      return;
    }
    for (const frame of replay.frames) this.sendFeed(conn, frame.text);
    this.reply(conn, { type: 'subscribed', topic, from: cursor, to: head, complete: true }, corr);
  }

  /** See {@link HubCommandHost.unsubscribe}. */
  unsubscribe(conn: WsConnection, topic: string, corr?: string): void {
    const ok = conn.topics.delete(topic);
    if (topic === 'logs') conn.logsFilter = {};
    this.reply(conn, { type: 'unsubscribed', topic, ok }, corr);
  }

  /** See {@link HubCommandHost.sendFrame}: latest-wins per (session, connection). */
  sendFrame(
    conn: WsConnection,
    sessionId: string,
    jpeg: Uint8Array<ArrayBuffer>,
    width: number,
    height: number,
  ): void {
    const sub = conn.screencasts.get(sessionId);
    if (sub === undefined || conn.closed) return;
    sub.seq = (sub.seq + 1) >>> 0;
    const header = writeScreencastHeader({
      magic: 'BHSC',
      ordinal: sub.ordinal,
      seq: sub.seq,
      width: Math.min(0xffff, width),
      height: Math.min(0xffff, height),
    });
    const bytes = new Uint8Array(new ArrayBuffer(header.byteLength + jpeg.byteLength));
    bytes.set(header, 0);
    bytes.set(jpeg, header.byteLength);
    if (conn.congested || conn.socket.bufferedAmount() > this.limits.screencastDropBytes) {
      if (sub.pending !== undefined) conn.droppedFrames += 1;
      sub.pending = bytes;
      return;
    }
    this.writeFrame(conn, bytes);
  }

  // --- internals ---------------------------------------------------------------------------------

  private writeFrame(conn: WsConnection, bytes: Uint8Array<ArrayBuffer>): void {
    const status = conn.send(bytes);
    if (status === 0) conn.droppedFrames += 1;
    if (status <= 0) conn.congested = true;
  }

  private sendFeed(conn: WsConnection, text: string): void {
    const status = conn.send(text);
    if (status === 0) {
      // Bun dropped the frame: the feed must never lose events, so the client reconnects and
      // replays from its cursor.
      this.overloaded(conn);
      return;
    }
    this.checkOverload(conn, this.now());
  }

  private checkOverload(conn: WsConnection, now: number): void {
    if (conn.socket.bufferedAmount() <= this.limits.overloadBytes) {
      conn.overloadSince = null;
      return;
    }
    conn.overloadSince ??= now;
    if (now - conn.overloadSince >= this.limits.overloadGraceMs) this.overloaded(conn);
  }

  private overloaded(conn: WsConnection): void {
    const buffered = conn.socket.bufferedAmount();
    conn.close(WS_CLOSE.OVERLOADED, 'overloaded');
    this.close(conn);
    this.deps.degradations?.report({
      code: 'WS_OVERLOADED',
      severity: 'warn',
      message: 'realtime connection closed under backpressure',
      details: { buffered_bytes: buffered },
    });
  }

  private violation(conn: WsConnection, error: AppError): void {
    conn.violations += 1;
    conn.send(errorFrame(this.feed.head, this.now(), error));
    if (conn.violations >= this.limits.maxProtocolViolations) {
      conn.close(WS_CLOSE.PROTOCOL_ERROR, 'too many protocol violations');
      this.close(conn);
    }
  }

  /**
   * Logs a failed command. Unexpected errors (anything that becomes `INTERNAL_ERROR` on the wire)
   * log at `error` with the serialized cause and the `ref` the client sees; expected domain
   * refusals log at `debug` so a noisy client cannot flood the log.
   */
  private logCommandError(
    conn: WsConnection,
    command: z.output<typeof WsClientCommand>,
    error: unknown,
    ref: string,
  ): void {
    const fields = {
      command: command.type,
      connection_id: conn.id,
      ...('session_id' in command && { session_id: command.session_id }),
      ref,
      err: error,
    };
    if (!isAppError(error) || error.code === 'INTERNAL_ERROR') {
      this.log.error('ws command failed', fields);
      return;
    }
    this.log.debug('ws command refused', { ...fields, code: error.code });
  }

  private async dispatch(
    conn: WsConnection,
    command: z.output<typeof WsClientCommand>,
  ): Promise<void> {
    const requestId = this.deps.ids.opaque(16);
    const context = {
      traceId: randomHex(16),
      spanId: randomHex(8),
      requestId,
      principal: conn.principal.subject,
      transport: 'ws' as const,
    };
    await runWithRequestContext(context, () =>
      this.tracer.startActiveSpan(
        'ws.command',
        { attributes: { 'browserhive.ws.command': command.type } },
        async (span) => {
          try {
            const sessionId = conn.authSessionId;
            if (sessionId !== undefined && !(await this.deps.auth.touchSession(sessionId))) {
              conn.close(WS_CLOSE.UNAUTHORIZED, 'session expired');
              this.close(conn);
              return;
            }
            const scope = commandScope(command);
            if (!authorizer.can(conn.principal, scope)) {
              throw new AppError('FORBIDDEN', { scope: scope ?? 'operator' });
            }
            await runCommand(this, conn, command);
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            this.logCommandError(conn, command, error, requestId);
            conn.send(errorFrame(this.feed.head, this.now(), error, command.corr, requestId));
          } finally {
            span.end();
          }
        },
      ),
    );
  }
}
