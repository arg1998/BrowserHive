/** @module ports/notification-channel — the delivery seam for notifications (D-16, D-32, spec 03 §9.3): what a channel can render, and send / edit / delete of one platform message. The in-app inbox and every platform adapter implement it. */

import type { Notification } from '@browserhive/contracts/http';
import type { NotificationMessage } from '@browserhive/contracts/notifications';
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
}
