/** @module infra/persistence/repositories/notification-actions — SQLite `NotificationActionTokenRepository`, `NotificationActionRepository` and `NotificationCursorRepository` (spec 03 §7, §9.6). */

import type { Kysely } from 'kysely';
import type {
  NewNotificationAction,
  NotificationActionListQuery,
  NotificationActionRecord,
  NotificationActionRepository,
  NotificationActionTokenRecord,
  NotificationActionTokenRepository,
  NotificationCursorRepository,
} from '../../../ports/persistence/notification-actions.ts';
import type { DB } from '../generated/db.d.ts';
import {
  actionFromRow,
  actionTokenFromRow,
  actionTokenToRow,
  actionToRow,
} from '../mappers/notification-actions.ts';

/** SQLite implementation of {@link NotificationActionTokenRepository}. */
export class SqliteNotificationActionTokenRepository implements NotificationActionTokenRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(rows: readonly NotificationActionTokenRecord[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#db
      .insertInto('notification_action_tokens')
      .values(rows.map(actionTokenToRow))
      .execute();
  }

  async get(tokenHash: string): Promise<NotificationActionTokenRecord | null> {
    const row = await this.#db
      .selectFrom('notification_action_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row === undefined ? null : actionTokenFromRow(row);
  }

  async claim(tokenHash: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('notification_action_tokens')
      .set({ used_at: at })
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async prune(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('notification_action_tokens')
      .where('expires_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** SQLite implementation of {@link NotificationActionRepository}. */
export class SqliteNotificationActionRepository implements NotificationActionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(row: NewNotificationAction): Promise<NotificationActionRecord> {
    const result = await this.#db
      .insertInto('notification_actions')
      .values(actionToRow(row))
      .executeTakeFirst();
    const seq = Number(result.insertId ?? 0n);
    if (seq <= 0) throw new Error('notification_actions insert returned no seq');
    return { ...row, seq };
  }

  async get(seq: number): Promise<NotificationActionRecord | null> {
    const row = await this.#db
      .selectFrom('notification_actions')
      .selectAll()
      .where('seq', '=', seq)
      .executeTakeFirst();
    return row === undefined ? null : actionFromRow(row);
  }

  async list(query: NotificationActionListQuery): Promise<readonly NotificationActionRecord[]> {
    let q = this.#db.selectFrom('notification_actions').selectAll();
    if (query.channelId !== undefined) q = q.where('channel_id', '=', query.channelId);
    if (query.notificationId !== undefined)
      q = q.where('notification_id', '=', query.notificationId);
    if (query.outcomes !== undefined && query.outcomes.length > 0)
      q = q.where('outcome', 'in', [...query.outcomes]);
    if (query.beforeSeq !== undefined) q = q.where('seq', '<', query.beforeSeq);
    const rows = await q
      .orderBy('seq', 'desc')
      .limit(query.limit ?? 50)
      .execute();
    return rows.map(actionFromRow);
  }

  async prune(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('notification_actions')
      .where('at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** SQLite implementation of {@link NotificationCursorRepository}. */
export class SqliteNotificationCursorRepository implements NotificationCursorRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.#db
      .selectFrom('notification_cursors')
      .select('value')
      .where('cursor_key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async set(key: string, value: string, at: number): Promise<void> {
    await this.#db
      .insertInto('notification_cursors')
      .values({ cursor_key: key, value, updated_at: at })
      .onConflict((oc) => oc.column('cursor_key').doUpdateSet({ value, updated_at: at }))
      .execute();
  }

  async remove(key: string): Promise<void> {
    await this.#db.deleteFrom('notification_cursors').where('cursor_key', '=', key).execute();
  }
}
