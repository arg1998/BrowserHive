/** @module ports/persistence/notification-outbox — notification channels, the delivery outbox and the channel message index (spec 03 §7.2, §9.3–9.4; D-34, D-35, D-39). */

import type { NotificationChannelStatus, NotificationDeliveryStatus } from './enums.ts';
import type {
  DeliveryFinishPatch,
  NewNotificationDelivery,
  NotificationChannelMessageRecord,
  NotificationChannelRecord,
  NotificationDeliveryListQuery,
  NotificationDeliveryRecord,
} from './records-notifications.ts';

/** Repository over `notification_channels`. */
export interface NotificationChannelRepository {
  /** Every channel, by name. */
  list(): Promise<readonly NotificationChannelRecord[]>;
  get(channelId: string): Promise<NotificationChannelRecord | null>;
  getByName(name: string): Promise<NotificationChannelRecord | null>;
  /**
   * Inserts a channel, or rewrites the configuration columns of an existing `channelId` (name,
   * kind, mode, source, target, secret refs, rules, `updatedAt`) while keeping its status and
   * breaker counters. A name used by another channel throws (unique constraint).
   */
  upsert(record: NotificationChannelRecord): Promise<void>;
  /** Removes a channel with its deliveries and channel messages; false when unknown. */
  remove(channelId: string): Promise<boolean>;
  /** Sets the status; `active` also resets the consecutive failure count. False when unknown. */
  setStatus(channelId: string, status: NotificationChannelStatus, at: number): Promise<boolean>;
  /** A successful platform call: failure count 0, `lastOkAt = at`. */
  recordSuccess(channelId: string, at: number): Promise<void>;
  /**
   * A failed platform call: failure count +1, `lastError`, `lastFailureAt`.
   *
   * @returns The consecutive failure count after the increment (0 when the channel is unknown).
   */
  recordFailure(channelId: string, at: number, error: string): Promise<number>;
}

/** Repository over `notification_deliveries` (the outbox and the delivery log). */
export interface NotificationDeliveryRepository {
  /**
   * Inserts jobs; a duplicate of (channel, notification, revision, op) is ignored.
   *
   * @returns The number of rows inserted.
   */
  enqueue(rows: readonly NewNotificationDelivery[]): Promise<number>;
  get(seq: number): Promise<NotificationDeliveryRecord | null>;
  /** `pending`/`retrying` jobs with `nextAttemptAt <= now`, oldest due first. */
  due(now: number, limit: number): Promise<readonly NotificationDeliveryRecord[]>;
  /**
   * Moves one due job to `sending` and counts the attempt.
   *
   * @returns False when the job was no longer `pending`/`retrying` (another claim won).
   */
  claim(seq: number, at: number): Promise<boolean>;
  /** Writes the outcome of an attempt (or a decision made without one). */
  finish(seq: number, patch: DeliveryFinishPatch): Promise<void>;
  /** Sets the `reason` of a `pending`/`retrying` job without changing its status (a backlog note). */
  annotate(seq: number, reason: string, at: number): Promise<void>;
  /** Moves a `pending`/`retrying` job's due time without counting an attempt (edit spacing). */
  reschedule(seq: number, nextAttemptAt: number, at: number): Promise<void>;
  /**
   * Marks `pending`/`retrying` `send`/`edit` jobs of one channel and notification with a revision
   * at or below `revision` as `superseded` (except `exceptSeq`).
   *
   * @returns The number of jobs superseded.
   */
  supersede(
    channelId: string,
    notificationId: string,
    revision: number,
    at: number,
    reason: string,
    exceptSeq?: number,
  ): Promise<number>;
  /**
   * Marks every `pending`/`retrying` job of a channel `suppressed` with `reason` (a paused or
   * broken channel).
   *
   * @returns The number of jobs suppressed.
   */
  suppressChannel(channelId: string, reason: string, at: number): Promise<number>;
  /**
   * Crash recovery: every `sending` job becomes `retrying`, due at `at`.
   *
   * @returns The number of jobs recovered.
   */
  recoverSending(at: number): Promise<number>;
  /** `pending`/`retrying` `send` jobs of a channel whose notification has `severity = 'info'`, oldest first. */
  pendingInfoSends(channelId: string): Promise<readonly NotificationDeliveryRecord[]>;
  /** Number of jobs in `statuses` (all channels). */
  count(statuses: readonly NotificationDeliveryStatus[]): Promise<number>;
  /** The delivery log, newest first. */
  list(query: NotificationDeliveryListQuery): Promise<readonly NotificationDeliveryRecord[]>;
}

/** Repository over `notification_channel_messages`. */
export interface NotificationChannelMessageRepository {
  get(channelId: string, notificationId: string): Promise<NotificationChannelMessageRecord | null>;
  /** Inserts or replaces the row of (channel, notification). */
  upsert(record: NotificationChannelMessageRecord): Promise<void>;
  /** The earliest message of a thread on a channel (reply-to target), or `null`. */
  firstInThread(
    channelId: string,
    thread: string,
  ): Promise<NotificationChannelMessageRecord | null>;
  /**
   * Messages whose TTL is due (`expiresAt <= now`), not deleted, and without a `delete` job for
   * their last revision yet; earliest deadline first.
   */
  dueForDelete(now: number, limit: number): Promise<readonly NotificationChannelMessageRecord[]>;
  /** Sets (or clears) the TTL deadline of one message. */
  setExpiry(channelId: string, notificationId: string, expiresAt: number | null): Promise<void>;
  markDeleted(channelId: string, notificationId: string, at: number): Promise<void>;
}
