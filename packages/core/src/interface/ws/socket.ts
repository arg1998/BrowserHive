/** @module interface/ws/socket — the transport seam of the hub: the raw socket surface it needs (Bun `ServerWebSocket`, or `FakeSocket` in tests). */

/**
 * Send status as Bun reports it: `> 0` bytes written, `-1` enqueued under backpressure, `0` dropped
 * (connection closing or the send buffer is full).
 */
export type SendStatus = number;

/** What the hub needs from one socket. */
export interface WsSocket {
  send(data: string | Uint8Array<ArrayBuffer>): SendStatus;
  /** Bytes queued in the kernel/user-space send buffer. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

/** Structural slice of Bun's `ServerWebSocket` the adapter reads. */
export interface BunServerSocketLike {
  send(data: string | Uint8Array<ArrayBuffer>, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount?: () => number;
}

/** Adapts a Bun `ServerWebSocket` to {@link WsSocket}. */
export function bunSocket(ws: BunServerSocketLike): WsSocket {
  return {
    send: (data) => ws.send(data),
    bufferedAmount: () => (typeof ws.getBufferedAmount === 'function' ? ws.getBufferedAmount() : 0),
    close: (code, reason) => ws.close(code, reason),
  };
}
