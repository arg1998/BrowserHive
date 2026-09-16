/** @module ports/persistence/notifications — notifications inbox and per-principal preferences (D-16). */

import type { NotificationListQuery, Page } from './queries.ts';
import type {
  JsonValue,
  NotificationGroupPatch,
  NotificationRecord,
  PreferenceRecord,
} from './records.ts';

/** Repository over `notifications`. */
export interface NotificationRepository {
  /** Inserts a notification; duplicate id is ignored. */
  insert(record: NotificationRecord): Promise<void>;
  /** Fetches one notification or `null`. */
  get(notificationId: string): Promise<NotificationRecord | null>;
  /**
   * Newest open (unread, undismissed) row of a coalescing group in one inbox, or `null`.
   */
  findOpenGroup(principalId: string | null, groupKey: string): Promise<NotificationRecord | null>;
  /**
   * Folds one more occurrence into a group row; applies only while the row is still unread and
   * undismissed.
   *
   * @returns The updated row, or `null` when the row is unknown or no longer open.
   */
  updateGroup(
    notificationId: string,
    patch: NotificationGroupPatch,
  ): Promise<NotificationRecord | null>;
  /** Lists notifications newest first (by `query.sort`, default `updated_at`). */
  list(query: NotificationListQuery): Promise<Page<NotificationRecord>>;
  /** Unread, undismissed count for a principal (or the anonymous inbox when `null`). */
  unreadCount(principalId: string | null): Promise<number>;
  /** Marks one notification read; returns false when unknown or already read. */
  markRead(notificationId: string, at: number): Promise<boolean>;
  /** Marks every unread notification of the principal read; returns the count. */
  markAllRead(principalId: string | null, at: number): Promise<number>;
  /** Dismisses one notification; returns false when unknown or already dismissed. */
  dismiss(notificationId: string, at: number): Promise<boolean>;
  /** Dismisses every undismissed notification of the principal; returns the count. */
  dismissAll(principalId: string | null, at: number): Promise<number>;
}

/** Repository over `preferences`. */
export interface PreferenceRepository {
  /** Every preference of a principal. */
  list(principalId: string): Promise<readonly PreferenceRecord[]>;
  /** Fetches one preference or `null`. */
  get(principalId: string, key: string): Promise<PreferenceRecord | null>;
  /** Creates or replaces one preference. */
  set(principalId: string, key: string, value: JsonValue, at: number): Promise<void>;
  /** Replaces the whole preference map of a principal (keys absent from `values` are removed). */
  replaceAll(
    principalId: string,
    values: Readonly<Record<string, JsonValue>>,
    at: number,
  ): Promise<void>;
  /** Removes one preference; returns true when a row was removed. */
  remove(principalId: string, key: string): Promise<boolean>;
}
