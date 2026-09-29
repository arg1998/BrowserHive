/** @module ports/notification-channel — the delivery seam for notifications (D-16, D-32, spec 03 §9.3): what a channel can render, and send / edit / delete of one platform message. The in-app inbox and every platform adapter implement it. */

import type { NotificationListenerState } from '@browserhive/contracts/enums';
import type { Notification } from '@browserhive/contracts/http';
import type {
  NotificationChannelRules,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import type { PlatformMessageRef } from './persistence/records-notifications.ts';

export type { PlatformMessageRef } from './persistence/records-notifications.ts';

/**
 * What a renderer supports. The shared `degrade()` step reads it and adapts the message before the
 * adapter sees it, so adapters never implement fallbacks themselves (D-32).
 */
export interface ChannelCapabilities {
  /** Headings, quotes, fields and lists render natively (otherwise they become plain text). */
  readonly richBlocks: boolean;
  /** Tables render natively (otherwise they become lists). */
  readonly tables: boolean;
  /** Charts render natively (otherwise they become a line of text bars). */
  readonly charts: boolean;
  /** Images can be attached (otherwise dropped, or a link to their dashboard page). */
  readonly images: boolean;
  /** Act buttons can be pressed in the chat (otherwise they become their `open` fallback). */
  readonly actButtons: boolean;
  /** Link buttons render (otherwise actions become a footer link). */
  readonly openLinks: boolean;
  /** A sent message can be edited in place. */
  readonly edit: boolean;
  /** A sent message can be deleted (TTL, D-35). */
  readonly delete: boolean;
  /** A message can be sent as a reply to an earlier one of its thread. */
  readonly replies: boolean;
  /** How long after sending a message may still be deleted (Telegram: 48 h); `null` = no limit. */
  readonly deleteWindowMs: number | null;
  /** Longest title the platform shows. */
  readonly maxTitleChars: number;
  /** Text budget for summary and blocks together. */
  readonly maxTextChars: number;
  /** Most buttons per message. */
  readonly maxButtons: number;
}

/** Turns a dashboard path into an absolute URL (`publicUrl + path`, D-37). */
export interface LinkBuilder {
  /** Absolute URL of a dashboard path (`/sessions/x?live=1`). Never carries a token. */
  url(path: string): string;
  /** True when links point at this computer only (no `publicUrl`): "Open on this computer". */
  readonly local: boolean;
}

/** One delivery handed to a channel: the message as this channel may show it. */
export interface ChannelDelivery {
  /** Already restricted to the channel's content level and degraded to its capabilities. */
  readonly message: NotificationMessage;
  readonly links: LinkBuilder;
  /** First message of the same thread on this channel, when the platform supports replies. */
  readonly replyTo: PlatformMessageRef | null;
  /**
   * The in-app projection of the row. Set only when delivering to the in-app channel; external
   * adapters never receive it and must not depend on it.
   */
  readonly inbox?: Notification;
  /**
   * The payload of each act button (`bh1:<token>`, D-41), by action id. Set by the outbox only
   * when the channel receives presses and the message carries act actions; the tokens were written
   * before the delivery was handed over.
   */
  readonly actTokens?: ReadonlyMap<string, string>;
}

/** What a successful send or edit returns: the platform's coordinates of the message. */
export interface ChannelSendResult {
  readonly ref: PlatformMessageRef;
}

/** Classified failure of a platform call. */
export type ChannelErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'auth'
  | 'rejected'
  | 'message_gone'
  | 'too_old';

/**
 * A platform call failed. `retryable` decides between backoff and `dead`; `retryAfterMs` carries
 * the platform's `retry_after` / `Retry-After`. `message_gone` (the message was deleted in the
 * chat) and `too_old` (a delete past the platform's window) are not channel-health failures.
 */
export class ChannelSendError extends Error {
  readonly code: ChannelErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    code: ChannelErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'ChannelSendError';
    this.code = code;
    this.retryable =
      options.retryable ??
      (code === 'rate_limited' || code === 'unavailable' || code === 'timeout');
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/**
 * One delivery target (03 §9.3). Adapters consume only the contract: they never read domain events
 * or the database (D-32). Every method may throw; the outbox classifies anything that is not a
 * {@link ChannelSendError} as a retryable `unavailable`.
 */
export interface NotificationChannel {
  /** `notification_channels.channel_id` (`in-app` for the inbox). */
  readonly id: string;
  /** Display name for logs and the delivery log. */
  readonly name: string;
  /** `NotificationChannelKind`. */
  readonly kind: string;
  readonly capabilities: ChannelCapabilities;
  /** Sends a new message. */
  send(delivery: ChannelDelivery): Promise<ChannelSendResult>;
  /** Replaces a sent message with the delivery's full state (silent). Required when `capabilities.edit`. */
  edit?(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult>;
  /** Deletes a sent message. Required when `capabilities.delete`. */
  delete?(ref: PlatformMessageRef): Promise<void>;
  /**
   * The channel's press listener (Telegram poller, Discord gateway, ntfy reply topic; D-41), when
   * act buttons are on and the platform can receive presses. Its buttons need command tokens.
   */
  readonly presses?: PressSource;
}

/** Who pressed an act button. */
export interface PressActor {
  readonly platform: 'telegram' | 'discord' | 'ntfy';
  /** The platform user id (`null` on ntfy, which has no user identity). */
  readonly id: string | null;
  /** The platform's display name, when it gives one. */
  readonly name: string | null;
}

/** One act-button press as a listener received it. */
export interface PressEvent {
  /** The token (the part after `bh1:`). Never logged. */
  readonly token: string;
  /** Where the press came from: the Telegram chat id, the Discord channel id; `null` on ntfy. */
  readonly origin: string | null;
  readonly actor: PressActor;
}

/** What the presser is told. */
export interface PressAnswer {
  /** The audit outcome, or `unknown` for a token BrowserHive never minted. */
  readonly outcome: string;
  /** Short text for the chat (a Telegram toast, an ephemeral Discord reply). */
  readonly text: string;
  /** Whether the answer is a refusal the presser should notice (a Telegram alert). */
  readonly refused: boolean;
}

/** Handles one press: checks, runs the command, audits (D-41). Never throws. */
export type PressHandler = (press: PressEvent) => Promise<PressAnswer>;

/** A press listener's state (`ChannelView.connection`). */
export interface ListenerStatus {
  readonly state: NotificationListenerState;
  readonly since: number;
  /** Why it is offline or reconnecting; `null` when connected. */
  readonly detail: string | null;
}

/**
 * The inbound half of a channel that accepts act buttons. Listening is outbound only (D-33): a
 * long poll, a gateway WebSocket, a streaming subscription. Several channels on one bot share one
 * connection, which closes shortly after its last listener stops.
 */
export interface PressSource {
  /**
   * Starts delivering this channel's presses to `handler` and state changes to `onStatus`.
   *
   * @returns Stops listening.
   */
  listen(handler: PressHandler, onStatus: (status: ListenerStatus) => void): () => void;
  /** The current state. */
  status(): ListenerStatus;
}

/** What a renderer needs to know about a channel's setup to declare its capabilities. */
export interface ChannelSetup {
  /** Discord `webhook`/`bot`; `null` elsewhere. */
  readonly mode: string | null;
  readonly target: Readonly<Record<string, string>>;
  /** Secret parameter → variable name (never a value). */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly rules: NotificationChannelRules;
}

/**
 * One platform request a renderer produced (spec 03 §9.5). `path` never holds a secret: a secret
 * parameter appears as `{secret:<param>}` (`{secret:webhook}/messages/123`), which the transport
 * substitutes with the value and the preview with the variable's name. Shaped like the contract's
 * `PlatformRequest`, so the preview returns it as-is.
 */
export interface RenderedRequest {
  /** `POST`, `PUT`, `PATCH`, `DELETE`. */
  readonly method: string;
  /** Platform method (`sendPhoto`) or path relative to the platform base (`/bh-alerts`). */
  readonly path: string;
  readonly encoding: 'json' | 'multipart' | 'binary';
  /** JSON body, or the non-file fields of a multipart/binary request. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Content headers (ntfy `X-*`); never credentials. */
  readonly headers: Readonly<Record<string, string>>;
  /** The attached image, if any: the `image` block's `ref` and how it is named on the wire. */
  readonly file: {
    readonly ref: string;
    readonly name: string;
    readonly content_type: string;
  } | null;
}

/** What a renderer knows about the channel and the call beyond the delivery. */
export interface RenderContext {
  /** Discord `webhook`/`bot`; `null` elsewhere. */
  readonly mode: string | null;
  /** The channel's non-secret coordinates (chat id, topic, server). */
  readonly target: Readonly<Record<string, string>>;
  readonly op: 'send' | 'edit';
  /** The message being edited (`op = edit`). */
  readonly ref: PlatformMessageRef | null;
  /**
   * The payload an act button carries (`bh1:<token>`, N2) where the capabilities allow act
   * buttons; the preview passes a placeholder.
   */
  readonly actToken: (actionId: string) => string;
}

/**
 * The pure half of a platform adapter: the contract in, the platform request(s) out (spec 03 §9.5).
 * The same renderer serves the transport and `POST /channels/preview`, so a preview is exactly
 * what a send makes.
 */
export interface ChannelRenderer {
  readonly kind: string;
  /** What this platform renders for a channel set up like this (mode, act buttons). */
  capabilities(setup: ChannelSetup): ChannelCapabilities;
  /** The request(s) for one send or edit, in order. Throws only on a programming error. */
  render(delivery: ChannelDelivery, context: RenderContext): readonly RenderedRequest[];
}

/** A stored notification screenshot (D-36). */
export interface NotificationImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Wire file name (`screenshot.jpg`). */
  readonly filename: string;
}

/** Resolves an `image` block's `ref` to bytes; adapters never read the database or the disk. */
export interface NotificationImageReader {
  /** The image, or `null` when it is gone (pruned, or never stored). */
  read(ref: string): Promise<NotificationImage | null>;
}

/** Stores notification screenshots (`<dataDir>/notifications/images/`, 0600) and prunes them. */
export interface NotificationImageStore extends NotificationImageReader {
  /** Stores bytes and returns their opaque ref. */
  put(image: NotificationImage): Promise<string>;
  /** Deletes images older than `olderThan` (epoch ms). */
  prune(olderThan: number): Promise<number>;
}

/** Who pressed `/start <code>` and where (the Telegram connect flow, spec 03 §4.8.1). */
export interface TelegramStart {
  readonly chat: {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly threadId: string | null;
  };
  readonly user: { readonly id: string; readonly name: string } | null;
}

/**
 * The Telegram setup calls: the bot's identity and the one-time `/start <code>` wait. Setup-only
 * long polling; the persistent callback loop of act buttons is N2's.
 */
export interface TelegramSetup {
  /** `getMe`: the bot's username. Throws a `ChannelSendError` (`auth` for a refused token). */
  botUsername(token: string): Promise<string>;
  /**
   * Long-polls `getUpdates` until a message `/start <code>` arrives (private chat or group), the
   * signal aborts, or `deadline` (epoch ms) passes. Updates it reads are acknowledged.
   *
   * @returns The chat and the sender, or `null` on timeout/abort.
   */
  waitForStart(
    token: string,
    code: string,
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<TelegramStart | null>;
}

/** Who the Discord bot is and where it is (the bot-mode setup, D-38). */
export interface DiscordBotIdentity {
  readonly applicationId: string;
  readonly botId: string;
  readonly username: string;
  readonly guilds: readonly { readonly id: string; readonly name: string }[];
}

/** A text channel of a Discord server. */
export interface DiscordChannelInfo {
  readonly id: string;
  readonly name: string;
  readonly type: 'text' | 'announcement';
  readonly category: string | null;
}

/**
 * The Discord bot-mode setup calls (spec 03 §4.8.1): the bot's identity and servers, a server's
 * text channels, and the one-time "This is me" claim that names the operator's account.
 */
export interface DiscordSetup {
  /** Throws a `ChannelSendError` (`auth` for a refused token). */
  bot(token: string): Promise<DiscordBotIdentity>;
  channels(token: string, guildId: string): Promise<readonly DiscordChannelInfo[]>;
  /**
   * Posts a "This is me" button in `channelId` and waits (over the gateway) for its press until
   * the signal aborts or `deadline` passes; the message is deleted afterwards.
   *
   * @returns Who pressed it, or `null` on timeout/abort.
   */
  claim(
    token: string,
    channelId: string,
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<{ readonly id: string; readonly name: string } | null>;
}

/** Outcome of one HTTP probe of `<publicUrl>/health` (spec 08 §5.8). */
export type UrlProbeResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly contentType: string | null;
      /** Where a 3xx pointed. */
      readonly location: string | null;
      /** At most 64 KiB of the body. */
      readonly body: string;
    }
  | { readonly kind: 'error'; readonly detail: string };

/** Fetches a URL once without following redirects (the `publicUrl` check). */
export type UrlProbe = (url: string, timeoutMs: number) => Promise<UrlProbeResult>;

/** One captured or stored screenshot, as the notification stores it. */
export interface CapturedImage {
  /** Image store ref (`nimg-…`). */
  readonly ref: string;
  readonly capturedAt: number;
}

/**
 * Takes the screenshots of D-36 for notifications. Implementations refuse (return `null`) while
 * the session's secret window is open, when it has no page, or when the capture fails; they never
 * throw.
 */
export interface NotificationSnapshots {
  /** A JPEG of the session's active page now, form fields masked when `masked`. */
  capture(sessionId: string, options: { readonly masked: boolean }): Promise<CapturedImage | null>;
  /** The session's last stored screenshot (a crashed session has no page to capture). */
  lastFrame(sessionId: string): Promise<CapturedImage | null>;
}
