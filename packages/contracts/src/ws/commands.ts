/** @module contracts/ws/commands — client → server frames, discriminated on `type`, with their scopes (spec 03 §6.3) */
import { z } from 'zod';
import { LogLevel, type Scope } from '../enums/index.ts';
import { ViewportDimension } from '../http/session-actions.ts';
import { SessionId } from '../ids/index.ts';
import { WsCorr, WsSeq } from './envelope.ts';
import { LiveInput } from './live-input.ts';
import { WsTopic } from './topics.ts';

/** Largest screencast dimension a viewer may request. */
export const SCREENCAST_MAX_DIMENSION = 7680;
/** Screencast JPEG quality bounds; default 70 (`--screencastQuality`). */
export const SCREENCAST_QUALITY = { min: 10, max: 100, default: 70 } as const;

const screencastDimension = z.number().int().min(64).max(SCREENCAST_MAX_DIMENSION);
const corr = { corr: WsCorr.optional() } as const;

/** Application heartbeat; slides the operator session (spec 03 §3.3). */
export const PingCommand = z.strictObject({ type: z.literal('ping'), ...corr });
/** Attach to a topic; `cursor` = last seen `seq` for replay (`complete:false` → re-seed from REST). */
export const SubscribeCommand = z.strictObject({
  type: z.literal('subscribe'),
  topic: WsTopic,
  cursor: WsSeq.optional(),
  ...corr,
});
/** Detach from a topic. */
export const UnsubscribeCommand = z.strictObject({
  type: z.literal('unsubscribe'),
  topic: WsTopic,
  ...corr,
});
/** Start (or join) the screencast of a session; reply carries the frame `ordinal`. */
export const ScreencastStartCommand = z.strictObject({
  type: z.literal('screencast.start'),
  session_id: SessionId,
  max_width: screencastDimension.optional(),
  max_height: screencastDimension.optional(),
  quality: z.number().int().min(SCREENCAST_QUALITY.min).max(SCREENCAST_QUALITY.max).optional(),
  ...corr,
});
/** Leave the screencast of a session (last viewer stops CDP after a 5 s grace). */
export const ScreencastStopCommand = z.strictObject({
  type: z.literal('screencast.stop'),
  session_id: SessionId,
  ...corr,
});
/** Change this viewer's requested size (server re-issues CDP with the largest across viewers). */
export const ScreencastSetSizeCommand = z.strictObject({
  type: z.literal('screencast.set_size'),
  session_id: SessionId,
  max_width: screencastDimension,
  max_height: screencastDimension,
  ...corr,
});
/** Operator takeover input; gated per message on an open attention request (`INPUT_NOT_PERMITTED`). */
export const InputCommand = z.strictObject({
  type: z.literal('input'),
  session_id: SessionId,
  input: LiveInput,
  ...corr,
});
/** Resize the agent's viewport; an observability control, **not** attention-gated (D-10). */
export const SetViewportCommand = z.strictObject({
  type: z.literal('session.set_viewport'),
  session_id: SessionId,
  width: ViewportDimension,
  height: ViewportDimension,
  ...corr,
});
/** Subscribe to `logs` with a server-side filter (alias for `subscribe {topic:'logs'}` + filter). */
export const LogsTailCommand = z.strictObject({
  type: z.literal('logs.tail'),
  level: LogLevel.optional(),
  module: z.string().min(1).max(64).optional(),
  ...corr,
});

/** Every client → server frame. */
export const WsClientCommand = z.discriminatedUnion('type', [
  PingCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  ScreencastStartCommand,
  ScreencastStopCommand,
  ScreencastSetSizeCommand,
  InputCommand,
  SetViewportCommand,
  LogsTailCommand,
]);
/** Every client → server frame. */
export type WsClientCommand = z.infer<typeof WsClientCommand>;
/** Command discriminator values. */
export type WsCommandType = WsClientCommand['type'];

/** Scope required per command (`null` = any authenticated principal). `Authorizer.can()` enforces it. */
export const WS_COMMAND_SCOPES: { readonly [T in WsCommandType]: Scope | null } = {
  ping: null,
  subscribe: null,
  unsubscribe: null,
  'screencast.start': 'sessions:read',
  'screencast.stop': 'sessions:read',
  'screencast.set_size': 'sessions:read',
  input: 'sessions:takeover',
  'session.set_viewport': 'sessions:write',
  'logs.tail': 'logs:read',
};

/** Scope required to subscribe to a topic (checked on `subscribe`). */
export const WS_TOPIC_SCOPES: {
  readonly [K in
    | 'sessions'
    | 'session'
    | 'screencast'
    | 'attention'
    | 'vault.confirm'
    | 'vault.config'
    | 'vault.access'
    | 'pages'
    | 'blocklist'
    | 'system'
    | 'logs'
    | 'notifications']: Scope;
} = {
  sessions: 'sessions:read',
  session: 'sessions:read',
  screencast: 'sessions:read',
  attention: 'attention:read',
  'vault.confirm': 'vault:read',
  'vault.config': 'vault:read',
  'vault.access': 'vault:read',
  pages: 'sessions:read',
  blocklist: 'blocklist:read',
  system: 'system:read',
  logs: 'logs:read',
  notifications: 'notifications:read',
};
