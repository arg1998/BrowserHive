/** @module contracts/ws/messages — server → client frames: hello, replies, errors, feed events, stream control (spec 03 §6.4) */
import { z } from 'zod';
import { EpochMs } from '../http/common.ts';
import { WS_PROTOCOL_VERSION, WS_SUBPROTOCOL, WsCorr, WsSeq, wsEnvelope } from './envelope.ts';
import { WsFeedEvent } from './feed-events.ts';
import { ScreencastControl } from './screencast.ts';
import { WsTopic } from './topics.ts';

/** First frame after upgrade. `epoch` changes on every daemon start; a foreign-epoch cursor must re-seed. */
export const HelloReply = z.object({
  type: z.literal('hello'),
  protocol: z.literal(WS_SUBPROTOCOL),
  protocol_version: z.literal(WS_PROTOCOL_VERSION),
  epoch: z.string().min(1),
  cursor: WsSeq,
  server_version: z.string(),
  now: EpochMs,
});
/** Answer to `subscribe`; `complete:false` = cursor outside the buffer, re-seed from REST. */
export const SubscribedReply = z.object({
  type: z.literal('subscribed'),
  topic: WsTopic,
  from: WsSeq,
  to: WsSeq,
  complete: z.boolean(),
});
/** Answer to `unsubscribe`. */
export const UnsubscribedReply = z.object({
  type: z.literal('unsubscribed'),
  topic: WsTopic,
  ok: z.boolean(),
});
/** Answer to `ping`. */
export const PongReply = z.object({ type: z.literal('pong'), ts: EpochMs });
/** Answer to `screencast.start`: the ordinal that tags this screencast's binary frames. */
export const ScreencastStartedReply = z.object({
  type: z.literal('screencast.started'),
  topic: WsTopic,
  ordinal: z.number().int().nonnegative(),
});
/** Generic acknowledgement for the remaining commands. */
export const OkReply = z.object({ type: z.literal('ok'), result: z.unknown().optional() });
/** The client's cursor/epoch is unusable; it must invalidate its caches and re-seed from REST. */
export const ResyncRequiredReply = z.object({
  type: z.literal('resync_required'),
  topic: WsTopic.optional(),
  reason: z.enum(['cursor_expired', 'epoch_changed', 'buffer_overflow']),
});

/** Every reply payload, discriminated on `type`. */
export const WsReplyPayload = z.discriminatedUnion('type', [
  HelloReply,
  SubscribedReply,
  UnsubscribedReply,
  PongReply,
  ScreencastStartedReply,
  OkReply,
  ResyncRequiredReply,
]);
/** Every reply payload. */
export type WsReplyPayload = z.infer<typeof WsReplyPayload>;

/** Error payload (mirrors problem+json: registry `code`, `title`, optional `details`). */
export const WsErrorPayload = z.object({
  code: z.string(),
  title: z.string(),
  details: z.unknown().optional(),
});
/** Error payload. */
export type WsErrorPayload = z.infer<typeof WsErrorPayload>;

/** `kind:'event'` — one ordered, replayable feed event on `topic`. */
export const WsEventMessage = wsEnvelope('event', WsFeedEvent).extend({ topic: WsTopic });
/** `kind:'reply'` — answer to a command (`corr` echoed when the command carried one; `hello` has none). */
export const WsReplyMessage = wsEnvelope('reply', WsReplyPayload);
/** `kind:'error'` — command failure or protocol violation; the socket stays up. */
export const WsErrorMessage = wsEnvelope('error', WsErrorPayload).extend({
  corr: WsCorr.optional(),
});
/** `kind:'stream'` — screencast control on `screencast:<id>`; latest-wins, never buffered. */
export const WsStreamMessage = wsEnvelope('stream', ScreencastControl).extend({ topic: WsTopic });

/** Every server → client text frame, discriminated on `kind`. */
export const WsServerMessage = z.discriminatedUnion('kind', [
  WsEventMessage,
  WsReplyMessage,
  WsErrorMessage,
  WsStreamMessage,
]);
/** Every server → client text frame. */
export type WsServerMessage = z.infer<typeof WsServerMessage>;
/** Feed event frame. */
export type WsEventMessage = z.infer<typeof WsEventMessage>;
/** Reply frame. */
export type WsReplyMessage = z.infer<typeof WsReplyMessage>;
/** Error frame. */
export type WsErrorMessage = z.infer<typeof WsErrorMessage>;
/** Stream control frame. */
export type WsStreamMessage = z.infer<typeof WsStreamMessage>;
