/** @module interface/ws/connection — per-socket state: principal, topics, screencast viewers, counters (spec 03 §6). */

import type { LogLevel } from '@browserhive/contracts/enums';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import type { SendStatus, WsSocket } from './socket.ts';

/** One screencast this connection watches. */
export interface ScreencastSubscription {
  readonly sessionId: string;
  readonly ordinal: number;
  seq: number;
  /** Latest frame waiting for the socket to drain (latest-wins). */
  pending: Uint8Array<ArrayBuffer> | undefined;
}

/** Server-side filter of the `logs` topic (`logs.tail`). */
export interface LogsFilter {
  readonly level?: LogLevel;
  readonly module?: string;
}

/** One dashboard tab's socket. */
export class WsConnection {
  readonly topics = new Set<string>();
  readonly screencasts = new Map<string, ScreencastSubscription>();
  logsFilter: LogsFilter = {};
  lastSeenAt: number;
  violations = 0;
  congested = false;
  droppedFrames = 0;
  messagesOut = 0;
  overloadSince: number | null = null;
  closed = false;
  private nextOrdinal = 1;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    readonly id: string,
    readonly socket: WsSocket,
    readonly principal: RequestPrincipal,
    readonly connectedAt: number,
  ) {
    this.lastSeenAt = connectedAt;
  }

  /** Sends a frame; closed connections never write. */
  send(data: string | Uint8Array<ArrayBuffer>): SendStatus {
    if (this.closed) return 0;
    this.messagesOut += 1;
    return this.socket.send(data);
  }

  /** Closes the socket once. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(code, reason);
  }

  /**
   * Runs `task` after every earlier task queued on `key` for this connection (screencast commands of
   * one session apply in arrival order, e.g. a StrictMode stop → start). `task` must not reject.
   */
  serial(key: string, task: () => Promise<void>): Promise<void> {
    const tail = (this.chains.get(key) ?? Promise.resolve()).then(task);
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return tail;
  }

  /** Allocates the ordinal tagging a new screencast's binary frames. */
  allocateOrdinal(): number {
    const ordinal = this.nextOrdinal;
    this.nextOrdinal = (this.nextOrdinal + 1) >>> 0;
    return ordinal;
  }

  /** The operator session this socket rides on, when cookie-authenticated. */
  get authSessionId(): string | undefined {
    return this.principal.auth.method === 'password-session'
      ? this.principal.auth.sessionId
      : undefined;
  }
}
