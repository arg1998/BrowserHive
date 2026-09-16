/** @module contracts/ws/envelope — versioned frame envelope, close codes and protocol limits (D-10, spec 03 §6.2) */
import { z } from 'zod';
import { WsTopic } from './topics.ts';

/** Wire protocol version; bumped on breaking changes and echoed in `hello`. */
export const WS_PROTOCOL_VERSION = 1;
/** `Sec-WebSocket-Protocol` value the client must offer (spec 03 §6.1). */
export const WS_SUBPROTOCOL = 'browserhive.v1';
/** Upgrade path relative to `/api/v1`. */
export const WS_PATH = '/ws';

/** Close codes (spec 03 §6.4). */
export const WS_CLOSE = {
  /** Unauthenticated or expired session; client must re-login. */
  UNAUTHORIZED: 4401,
  /** Password change pending; only the change-password flow is allowed. */
  PASSWORD_CHANGE_REQUIRED: 4403,
  /** Five protocol violations. */
  PROTOCOL_ERROR: 4400,
  /** Missing/unknown subprotocol. */
  BAD_SUBPROTOCOL: 4406,
  /** Backpressure limit exceeded for 10 s. */
  OVERLOADED: 1013,
  /** Server going away or stale socket reaped. */
  GOING_AWAY: 1001,
} as const;

/** Protocol limits (spec 03 §6.2–6.4). */
export const WS_LIMITS = {
  /** Inbound text frames larger than this → `PAYLOAD_TOO_LARGE`. */
  maxInboundFrameBytes: 16 * 1024,
  /** Malformed frames tolerated before close 4400. */
  maxProtocolViolations: 5,
  /** Feed replay buffer bounds (whichever first). */
  feedBufferCount: 10_000,
  feedBufferBytes: 8 * 1024 * 1024,
  feedBufferMs: 5 * 60_000,
  /** Client heartbeat interval. */
  heartbeatMs: 20_000,
  /** Sockets silent this long are reaped (close 1001). */
  staleMs: 60_000,
  /** Server `system.tick` interval (keeps proxies from idling the socket). */
  tickMs: 30_000,
  /** Feed backpressure: close 1013 after `bufferedAmount` stays above this for `overloadGraceMs`. */
  overloadBytes: 4 * 1024 * 1024,
  overloadGraceMs: 10_000,
  /** Screencast frames are dropped while `bufferedAmount` exceeds this. */
  screencastDropBytes: 1024 * 1024,
} as const;

/** Frame kinds: `event` (ordered feed), `reply` (answer to a command), `error`, `stream` (screencast control). */
export const WsKind = z.enum(['event', 'reply', 'error', 'stream']);
/** Frame kind. */
export type WsKind = z.infer<typeof WsKind>;

/** Correlation id a client attaches to a command; echoed on its reply/error. */
export const WsCorr = z.string().min(1).max(64);
/** Monotonic per-connection sequence (feed events: the replayable cursor). */
export const WsSeq = z.number().int().nonnegative();

/** Shape shared by every server frame; `payload` is refined per kind in `messages.ts`. */
export const WsEnvelope = z.object({
  v: z.literal(WS_PROTOCOL_VERSION),
  kind: WsKind,
  seq: WsSeq,
  ts: z.number().int().nonnegative(),
  topic: WsTopic.optional(),
  corr: WsCorr.optional(),
  payload: z.unknown(),
});
/** Shape shared by every server frame. */
export type WsEnvelope = z.infer<typeof WsEnvelope>;

/** Build the envelope schema for one `kind` with a typed payload. */
export function wsEnvelope<K extends WsKind, P extends z.ZodType>(kind: K, payload: P) {
  return WsEnvelope.extend({ kind: z.literal(kind), payload });
}
