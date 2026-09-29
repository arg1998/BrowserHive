/** @module ports/persistence/records-notifications — notification channel, outbox job and channel message records (spec 03 §7, §9.3–9.4; D-33, D-34, D-35, D-39). */

import type { NotificationChannelRules } from '@browserhive/contracts/notifications';
import type {
  NotificationChannelSource,
  NotificationChannelStatus,
  NotificationDeliveryOp,
  NotificationDeliveryStatus,
} from './enums.ts';

/**
 * Opaque platform coordinates of one sent message (message id, chat id, ntfy sequence id). Only the
 * adapter that produced a ref interprets it; the core stores and hands it back.
 */
export type PlatformMessageRef = Readonly<Record<string, string | number>>;

/** A configured notification channel (`notification_channels`). Secrets are env var names only. */
export interface NotificationChannelRecord {
  readonly channelId: string;
  /** Unique across dashboard and startup channels. */
  readonly name: string;
  /** `NotificationChannelKind` (`telegram`, `discord`, …); open set, validated by the contract. */
  readonly kind: string;
  /** Discord: `webhook` or `bot` (D-38); `null` elsewhere. */
  readonly mode: string | null;
  readonly source: NotificationChannelSource;
  readonly status: NotificationChannelStatus;
  /** Non-secret coordinates. */
  readonly target: Readonly<Record<string, string>>;
  /** Secret parameter → environment variable name (D-33). */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly rules: NotificationChannelRules;
  /** Consecutive failures (the breaker opens at 5). */
  readonly failureCount: number;
  readonly lastError: string | null;
  readonly lastOkAt: number | null;
  readonly lastFailureAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One outbox job and delivery log row (`notification_deliveries`). */
export interface NotificationDeliveryRecord {
  readonly seq: number;
  readonly channelId: string;
  readonly notificationId: string;
  /** The revision that caused the job. */
  readonly revision: number;
  readonly op: NotificationDeliveryOp;
  readonly status: NotificationDeliveryStatus;
  /** Why it was suppressed, superseded or dead (`quiet_hours`, `collapsed`, `too_old`, …). */
  readonly reason: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly durationMs: number | null;
  /** The platform message the job produced or addressed. */
  readonly messageRef: PlatformMessageRef | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A job to enqueue. Duplicates of (channel, notification, revision, op) are ignored. */
export interface NewNotificationDelivery {
  readonly channelId: string;
  readonly notificationId: string;
  readonly revision: number;
  readonly op: NotificationDeliveryOp;
  /** `pending` for work; `suppressed`/`superseded` to log a decision without a platform call. */
  readonly status: Extract<NotificationDeliveryStatus, 'pending' | 'suppressed' | 'superseded'>;
  readonly reason: string | null;
  /** When the job becomes due (`null` for terminal rows). */
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
}

/** The outcome written when a job finishes or is rescheduled after an attempt. */
export interface DeliveryFinishPatch {
  readonly status: Exclude<NotificationDeliveryStatus, 'pending' | 'sending'>;
  readonly reason?: string | null;
  readonly lastError?: string | null;
  readonly durationMs?: number | null;
  readonly messageRef?: PlatformMessageRef | null;
  /** Required for `retrying`. */
  readonly nextAttemptAt?: number | null;
  readonly updatedAt: number;
}

/** Filters of the delivery log (newest first, keyset on `seq`). */
export interface NotificationDeliveryListQuery {
  readonly channelId?: string;
  readonly notificationId?: string;
  readonly statuses?: readonly NotificationDeliveryStatus[];
  readonly ops?: readonly NotificationDeliveryOp[];
  /** Notification kinds (`attention.requested`, …). */
  readonly kinds?: readonly string[];
  /** Only rows with `seq` below this (the next page). */
  readonly beforeSeq?: number;
  readonly limit?: number;
}

/** Delivery counts of one channel (the channel cards, spec 03 §4.8.1). */
export interface ChannelDeliveryStats {
  readonly channelId: string;
  /** `sent` jobs updated since the window start. */
  readonly sent: number;
  /** `dead` jobs updated since the window start. */
  readonly failed: number;
  /** `suppressed` jobs updated since the window start. */
  readonly suppressed: number;
  /** `pending`, `retrying` and `sending` jobs now. */
  readonly pending: number;
  /** When the last `sent` or `dead` job finished. */
  readonly lastAt: number | null;
  readonly lastStatus: NotificationDeliveryStatus | null;
}

/** The platform message a notification became on a channel (`notification_channel_messages`). */
export interface NotificationChannelMessageRecord {
  readonly channelId: string;
  readonly notificationId: string;
  readonly thread: string;
  readonly messageRef: PlatformMessageRef;
  /** The last revision the platform message shows. */
  readonly lastRevision: number;
  readonly sentAt: number;
  readonly updatedAt: number;
  /** TTL deadline (D-35); `null` = never. */
  readonly expiresAt: number | null;
  readonly deletedAt: number | null;
}
