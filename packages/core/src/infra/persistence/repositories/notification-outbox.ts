/** @module infra/persistence/repositories/notification-outbox — SQLite `NotificationChannelRepository`, `NotificationDeliveryRepository` and `NotificationChannelMessageRepository` (spec 03 §7, §9.3–9.4). */

import { type Kysely, sql } from 'kysely';
import type {
  NotificationChannelStatus,
  NotificationDeliveryStatus,
} from '../../../ports/persistence/enums.ts';
import type {
  NotificationChannelMessageRepository,
  NotificationChannelRepository,
  NotificationDeliveryRepository,
} from '../../../ports/persistence/notification-outbox.ts';
import type {
  ChannelDeliveryStats,
  DeliveryFinishPatch,
  NewNotificationDelivery,
  NotificationChannelMessageRecord,
  NotificationChannelRecord,
  NotificationDeliveryListQuery,
  NotificationDeliveryRecord,
} from '../../../ports/persistence/records.ts';

import type { DB } from '../generated/db.d.ts';
import {
  channelFromRow,
  channelMessageFromRow,
  channelMessageToRow,
  channelToRow,
  deliveryFromRow,
  deliveryToRow,
} from '../mappers/notifications.ts';
import { asNumber } from './common.ts';

/** Jobs that are still work to do. */
const OPEN_STATUSES = ['pending', 'retrying'] as const;

/** SQLite implementation of {@link NotificationChannelRepository}. */
export class SqliteNotificationChannelRepository implements NotificationChannelRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(): Promise<readonly NotificationChannelRecord[]> {
    const rows = await this.#db
      .selectFrom('notification_channels')
      .selectAll()
      .orderBy('name')
      .execute();
    return rows.map(channelFromRow);
  }

  async get(channelId: string): Promise<NotificationChannelRecord | null> {
    const row = await this.#db
      .selectFrom('notification_channels')
      .selectAll()
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    return row === undefined ? null : channelFromRow(row);
  }

  async getByName(name: string): Promise<NotificationChannelRecord | null> {
    const row = await this.#db
      .selectFrom('notification_channels')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? null : channelFromRow(row);
  }

  async upsert(record: NotificationChannelRecord): Promise<void> {
    const row = channelToRow(record);
    await this.#db
      .insertInto('notification_channels')
      .values(row)
      .onConflict((oc) =>
        oc.column('channel_id').doUpdateSet({
          name: row.name,
          kind: row.kind,
          mode: row.mode,
          source: row.source,
          target_json: row.target_json,
          secret_refs_json: row.secret_refs_json,
          rules_json: row.rules_json,
          updated_at: row.updated_at,
        }),
      )
      .execute();
  }

  async remove(channelId: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('notification_channels')
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async setStatus(
    channelId: string,
    status: NotificationChannelStatus,
    at: number,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('notification_channels')
      .set({ status, updated_at: at, ...(status === 'active' && { failure_count: 0 }) })
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async recordSuccess(channelId: string, at: number): Promise<void> {
    await this.#db
      .updateTable('notification_channels')
      .set({ failure_count: 0, last_ok_at: at })
      .where('channel_id', '=', channelId)
      .execute();
  }

  async recordFailure(channelId: string, at: number, error: string): Promise<number> {
    await this.#db
      .updateTable('notification_channels')
      .set((eb) => ({
        failure_count: eb('failure_count', '+', 1),
        last_error: error,
        last_failure_at: at,
      }))
      .where('channel_id', '=', channelId)
      .execute();
    const row = await this.#db
      .selectFrom('notification_channels')
      .select('failure_count')
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
    return row === undefined ? 0 : row.failure_count;
  }
}

/** SQLite implementation of {@link NotificationDeliveryRepository}. */
export class SqliteNotificationDeliveryRepository implements NotificationDeliveryRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async enqueue(rows: readonly NewNotificationDelivery[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.#db
      .insertInto('notification_deliveries')
      .values(rows.map(deliveryToRow))
      .onConflict((oc) =>
        oc.columns(['channel_id', 'notification_id', 'revision', 'op']).doNothing(),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }

  async get(seq: number): Promise<NotificationDeliveryRecord | null> {
    const row = await this.#db
      .selectFrom('notification_deliveries')
      .selectAll()
      .where('seq', '=', seq)
      .executeTakeFirst();
    return row === undefined ? null : deliveryFromRow(row);
  }

  async due(now: number, limit: number): Promise<readonly NotificationDeliveryRecord[]> {
    const rows = await this.#db
      .selectFrom('notification_deliveries')
      .selectAll()
      .where('status', 'in', [...OPEN_STATUSES])
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .orderBy('seq')
      .limit(Math.max(1, limit))
      .execute();
    return rows.map(deliveryFromRow);
  }

  async claim(seq: number, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('notification_deliveries')
      .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), updated_at: at }))
      .where('seq', '=', seq)
      .where('status', 'in', [...OPEN_STATUSES])
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async finish(seq: number, patch: DeliveryFinishPatch): Promise<void> {
    await this.#db
      .updateTable('notification_deliveries')
      .set({
        status: patch.status,
        updated_at: patch.updatedAt,
        next_attempt_at: patch.nextAttemptAt ?? null,
        ...(patch.reason !== undefined && { reason: patch.reason }),
        ...(patch.lastError !== undefined && { last_error: patch.lastError }),
        ...(patch.durationMs !== undefined && { duration_ms: patch.durationMs }),
        ...(patch.messageRef !== undefined && {
          message_ref_json: patch.messageRef === null ? null : JSON.stringify(patch.messageRef),
        }),
      })
      .where('seq', '=', seq)
      .execute();
  }

  async annotate(seq: number, reason: string, at: number): Promise<void> {
    await this.#db
      .updateTable('notification_deliveries')
      .set({ reason, updated_at: at })
      .where('seq', '=', seq)
      .where('status', 'in', [...OPEN_STATUSES])
      .execute();
  }

  async reschedule(seq: number, nextAttemptAt: number, at: number): Promise<void> {
    await this.#db
      .updateTable('notification_deliveries')
      .set({ next_attempt_at: nextAttemptAt, updated_at: at })
      .where('seq', '=', seq)
      .where('status', 'in', [...OPEN_STATUSES])
      .execute();
  }

  async supersede(
    channelId: string,
    notificationId: string,
    revision: number,
    at: number,
    reason: string,
    exceptSeq?: number,
  ): Promise<number> {
    let qb = this.#db
      .updateTable('notification_deliveries')
      .set({ status: 'superseded', reason, next_attempt_at: null, updated_at: at })
      .where('channel_id', '=', channelId)
      .where('notification_id', '=', notificationId)
      .where('revision', '<=', revision)
      .where('op', 'in', ['send', 'edit'])
      .where('status', 'in', [...OPEN_STATUSES]);
    if (exceptSeq !== undefined) qb = qb.where('seq', '!=', exceptSeq);
    return Number((await qb.executeTakeFirst()).numUpdatedRows);
  }

  async suppressChannel(channelId: string, reason: string, at: number): Promise<number> {
    const result = await this.#db
      .updateTable('notification_deliveries')
      .set({ status: 'suppressed', reason, next_attempt_at: null, updated_at: at })
      .where('channel_id', '=', channelId)
      .where('status', 'in', [...OPEN_STATUSES])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async recoverSending(at: number): Promise<number> {
    const result = await this.#db
      .updateTable('notification_deliveries')
      .set({ status: 'retrying', next_attempt_at: at, updated_at: at })
      .where('status', '=', 'sending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async pendingInfoSends(channelId: string): Promise<readonly NotificationDeliveryRecord[]> {
    const rows = await this.#db
      .selectFrom('notification_deliveries as d')
      .innerJoin('notifications as n', 'n.notification_id', 'd.notification_id')
      .selectAll('d')
      .where('d.channel_id', '=', channelId)
      .where('d.op', '=', 'send')
      .where('d.status', 'in', [...OPEN_STATUSES])
      .where('n.severity', '=', 'info')
      .orderBy('d.seq')
      .execute();
    return rows.map(deliveryFromRow);
  }

  async count(statuses: readonly NotificationDeliveryStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const row = await this.#db
      .selectFrom('notification_deliveries')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('status', 'in', [...statuses])
      .executeTakeFirst();
    return asNumber(row?.n);
  }

  async list(query: NotificationDeliveryListQuery): Promise<readonly NotificationDeliveryRecord[]> {
    let qb = this.#db.selectFrom('notification_deliveries').selectAll();
    if (query.channelId !== undefined) qb = qb.where('channel_id', '=', query.channelId);
    if (query.notificationId !== undefined)
      qb = qb.where('notification_id', '=', query.notificationId);
    if (query.statuses !== undefined && query.statuses.length > 0)
      qb = qb.where('status', 'in', [...query.statuses]);
    if (query.ops !== undefined && query.ops.length > 0) qb = qb.where('op', 'in', [...query.ops]);
    if (query.kinds !== undefined && query.kinds.length > 0) {
      const kinds = [...query.kinds];
      qb = qb.where('notification_id', 'in', (eb) =>
        eb.selectFrom('notifications').select('notification_id').where('kind', 'in', kinds),
      );
    }
    if (query.beforeSeq !== undefined) qb = qb.where('seq', '<', query.beforeSeq);
    const rows = await qb
      .orderBy('seq', 'desc')
      .limit(Math.min(Math.max(1, query.limit ?? 100), 1000))
      .execute();
    return rows.map(deliveryFromRow);
  }

  async stats(since: number): Promise<readonly ChannelDeliveryStats[]> {
    const rows = await this.#db
      .selectFrom('notification_deliveries')
      .select([
        'channel_id',
        sql<number>`SUM(CASE WHEN status = 'sent' AND updated_at >= ${since} THEN 1 ELSE 0 END)`.as(
          'sent',
        ),
        sql<number>`SUM(CASE WHEN status = 'dead' AND updated_at >= ${since} THEN 1 ELSE 0 END)`.as(
          'failed',
        ),
        sql<number>`SUM(CASE WHEN status = 'suppressed' AND updated_at >= ${since} THEN 1 ELSE 0 END)`.as(
          'suppressed',
        ),
        sql<number>`SUM(CASE WHEN status IN ('pending', 'retrying', 'sending') THEN 1 ELSE 0 END)`.as(
          'pending',
        ),
        sql<number | null>`MAX(CASE WHEN status IN ('sent', 'dead') THEN updated_at END)`.as(
          'last_at',
        ),
      ])
      .groupBy('channel_id')
      .execute();
    const out: ChannelDeliveryStats[] = [];
    for (const row of rows) {
      const lastAt = row.last_at === null ? null : asNumber(row.last_at);
      let lastStatus: NotificationDeliveryStatus | null = null;
      if (lastAt !== null) {
        const last = await this.#db
          .selectFrom('notification_deliveries')
          .select('status')
          .where('channel_id', '=', row.channel_id)
          .where('status', 'in', ['sent', 'dead'])
          .orderBy('updated_at', 'desc')
          .orderBy('seq', 'desc')
          .limit(1)
          .executeTakeFirst();
        lastStatus = last === undefined ? null : (last.status as NotificationDeliveryStatus);
      }
      out.push({
        channelId: row.channel_id,
        sent: asNumber(row.sent),
        failed: asNumber(row.failed),
        suppressed: asNumber(row.suppressed),
        pending: asNumber(row.pending),
        lastAt,
        lastStatus,
      });
    }
    return out;
  }
}

/** SQLite implementation of {@link NotificationChannelMessageRepository}. */
export class SqliteNotificationChannelMessageRepository
  implements NotificationChannelMessageRepository
{
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async get(
    channelId: string,
    notificationId: string,
  ): Promise<NotificationChannelMessageRecord | null> {
    const row = await this.#db
      .selectFrom('notification_channel_messages')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('notification_id', '=', notificationId)
      .executeTakeFirst();
    return row === undefined ? null : channelMessageFromRow(row);
  }

  async upsert(record: NotificationChannelMessageRecord): Promise<void> {
    const row = channelMessageToRow(record);
    await this.#db
      .insertInto('notification_channel_messages')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['channel_id', 'notification_id']).doUpdateSet({
          thread: row.thread,
          message_ref_json: row.message_ref_json,
          last_revision: row.last_revision,
          sent_at: row.sent_at,
          updated_at: row.updated_at,
          expires_at: row.expires_at,
          deleted_at: row.deleted_at,
        }),
      )
      .execute();
  }

  async firstInThread(
    channelId: string,
    thread: string,
  ): Promise<NotificationChannelMessageRecord | null> {
    const row = await this.#db
      .selectFrom('notification_channel_messages')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('thread', '=', thread)
      .orderBy('sent_at')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : channelMessageFromRow(row);
  }

  async dueForDelete(
    now: number,
    limit: number,
  ): Promise<readonly NotificationChannelMessageRecord[]> {
    const rows = await this.#db
      .selectFrom('notification_channel_messages as m')
      .selectAll('m')
      .where('m.expires_at', 'is not', null)
      .where('m.expires_at', '<=', now)
      .where('m.deleted_at', 'is', null)
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.channel_id = m.channel_id AND d.notification_id = m.notification_id AND d.revision = m.last_revision AND d.op = 'delete')`,
      )
      .orderBy('m.expires_at')
      .limit(Math.max(1, limit))
      .execute();
    return rows.map(channelMessageFromRow);
  }

  async setExpiry(
    channelId: string,
    notificationId: string,
    expiresAt: number | null,
  ): Promise<void> {
    await this.#db
      .updateTable('notification_channel_messages')
      .set({ expires_at: expiresAt })
      .where('channel_id', '=', channelId)
      .where('notification_id', '=', notificationId)
      .execute();
  }

  async markDeleted(channelId: string, notificationId: string, at: number): Promise<void> {
    await this.#db
      .updateTable('notification_channel_messages')
      .set({ deleted_at: at, updated_at: at })
      .where('channel_id', '=', channelId)
      .where('notification_id', '=', notificationId)
      .execute();
  }
}
