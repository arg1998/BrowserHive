/** @module test/helpers/in-memory-action-repos — Map-backed act-button token, press audit and cursor repositories; the conformance suite runs them beside the SQLite ones. */

import type {
  NewNotificationAction,
  NotificationActionListQuery,
  NotificationActionRecord,
  NotificationActionRepository,
  NotificationActionTokenRecord,
  NotificationActionTokenRepository,
  NotificationCursorRepository,
} from '../../src/ports/persistence/notification-actions.ts';

/** `notification_action_tokens` in memory. */
export class InMemoryNotificationActionTokenRepository
  implements NotificationActionTokenRepository
{
  readonly rows = new Map<string, NotificationActionTokenRecord>();

  async insert(rows: readonly NotificationActionTokenRecord[]): Promise<void> {
    for (const row of rows) {
      if (this.rows.has(row.tokenHash)) throw new Error('UNIQUE constraint failed: token_hash');
    }
    for (const row of rows) this.rows.set(row.tokenHash, row);
  }

  async get(tokenHash: string): Promise<NotificationActionTokenRecord | null> {
    return this.rows.get(tokenHash) ?? null;
  }

  async claim(tokenHash: string, at: number): Promise<boolean> {
    const row = this.rows.get(tokenHash);
    if (row === undefined || row.usedAt !== null) return false;
    this.rows.set(tokenHash, { ...row, usedAt: at });
    return true;
  }

  async prune(before: number): Promise<number> {
    let n = 0;
    for (const [hash, row] of this.rows) {
      if (row.expiresAt < before) {
        this.rows.delete(hash);
        n++;
      }
    }
    return n;
  }

  /** Drops every token of a channel (the FK cascade). */
  removeChannel(channelId: string): void {
    for (const [hash, row] of this.rows) if (row.channelId === channelId) this.rows.delete(hash);
  }
}

/** `notification_actions` in memory. */
export class InMemoryNotificationActionRepository implements NotificationActionRepository {
  readonly rows: NotificationActionRecord[] = [];
  private nextSeq = 1;

  async insert(row: NewNotificationAction): Promise<NotificationActionRecord> {
    const stored = { ...row, seq: this.nextSeq++ };
    this.rows.push(stored);
    return stored;
  }

  async get(seq: number): Promise<NotificationActionRecord | null> {
    return this.rows.find((r) => r.seq === seq) ?? null;
  }

  async list(query: NotificationActionListQuery): Promise<readonly NotificationActionRecord[]> {
    return this.rows
      .filter(
        (r) =>
          (query.channelId === undefined || r.channelId === query.channelId) &&
          (query.notificationId === undefined || r.notificationId === query.notificationId) &&
          (query.outcomes === undefined ||
            query.outcomes.length === 0 ||
            query.outcomes.includes(r.outcome)) &&
          (query.beforeSeq === undefined || r.seq < query.beforeSeq),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, query.limit ?? 50);
  }

  async prune(before: number): Promise<number> {
    const keep = this.rows.filter((r) => r.at >= before);
    const n = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return n;
  }
}

/** `notification_cursors` in memory. */
export class InMemoryNotificationCursorRepository implements NotificationCursorRepository {
  readonly rows = new Map<string, { value: string; updatedAt: number }>();

  async get(key: string): Promise<string | null> {
    return this.rows.get(key)?.value ?? null;
  }

  async set(key: string, value: string, at: number): Promise<void> {
    this.rows.set(key, { value, updatedAt: at });
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
