/** @module ports/persistence/notification-actions — act-button command tokens, the press audit and the press listeners' resume cursors (spec 03 §7.2, §9.6; D-41, D-42). */

import type { NotificationActionOutcome } from './enums.ts';

/** One command token (`notification_action_tokens`). The token itself is never stored. */
export interface NotificationActionTokenRecord {
  /** SHA-256 hex of the token (the part after `bh1:`). */
  readonly tokenHash: string;
  readonly channelId: string;
  readonly notificationId: string;
  /** The contract action's id (`resolve`, `reject`, `approve`, `deny`). */
  readonly actionId: string;
  /** `NotificationCommandOp`. */
  readonly op: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
}

/** One audited press (`notification_actions`). */
export interface NotificationActionRecord {
  readonly seq: number;
  readonly at: number;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelKind: string;
  readonly notificationId: string | null;
  readonly actionId: string;
  readonly actionLabel: string | null;
  readonly op: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  /** `telegram:<id>`, `discord:<id>`, `ntfy:topic-b`. */
  readonly actor: string;
  readonly actorName: string | null;
  readonly outcome: NotificationActionOutcome;
  readonly detail: string | null;
}

/** A press to audit (`seq` is assigned). */
export type NewNotificationAction = Omit<NotificationActionRecord, 'seq'>;

/** Filters of the press audit (newest first, keyset on `seq`). */
export interface NotificationActionListQuery {
  readonly channelId?: string;
  readonly notificationId?: string;
  readonly outcomes?: readonly NotificationActionOutcome[];
  readonly beforeSeq?: number;
  readonly limit?: number;
}

/** Repository over `notification_action_tokens`. */
export interface NotificationActionTokenRepository {
  /** Inserts tokens (a duplicate hash is a programming error and throws). */
  insert(rows: readonly NotificationActionTokenRecord[]): Promise<void>;
  get(tokenHash: string): Promise<NotificationActionTokenRecord | null>;
  /**
   * Claims a token: `usedAt` goes from `null` to `at`, once.
   *
   * @returns False when it was already used (another press won) or is unknown.
   */
  claim(tokenHash: string, at: number): Promise<boolean>;
  /**
   * Deletes tokens that expired before `before` (used or not).
   *
   * @returns The number of rows deleted.
   */
  prune(before: number): Promise<number>;
}

/** Repository over `notification_actions` (audit class). */
export interface NotificationActionRepository {
  /** Appends one press; returns the stored row. */
  insert(row: NewNotificationAction): Promise<NotificationActionRecord>;
  get(seq: number): Promise<NotificationActionRecord | null>;
  /** The audit, newest first. */
  list(query: NotificationActionListQuery): Promise<readonly NotificationActionRecord[]>;
  /**
   * Deletes rows older than `before`.
   *
   * @returns The number of rows deleted.
   */
  prune(before: number): Promise<number>;
}

/** Repository over `notification_cursors`: where each press listener resumes. */
export interface NotificationCursorRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, at: number): Promise<void>;
  remove(key: string): Promise<void>;
}
