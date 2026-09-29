/** @module infra/persistence/repositories/notifications — SQLite `NotificationRepository` and `PreferenceRepository`. */

import { type Kysely, sql } from 'kysely';
import type {
  NotificationRepository,
  PreferenceRepository,
  ReportChannelRow,
} from '../../../ports/persistence/notifications.ts';
import type {
  NotificationListQuery,
  Page,
  ReportListQuery,
} from '../../../ports/persistence/queries.ts';
import type {
  JsonValue,
  NotificationGroupPatch,
  NotificationRecord,
  NotificationRevisionPatch,
  PreferenceRecord,
} from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import { toJson } from '../mappers/codec.ts';
import {
  notificationFromRow,
  notificationToRow,
  preferenceFromRow,
} from '../mappers/operations.ts';
import {
  asNumber,
  clampLimit,
  decodeCursor,
  keysetWhere,
  type SortExpr,
  sortKey,
  toPage,
} from './common.ts';

const RESOURCE = 'notifications';
const REPORTS_RESOURCE = 'notifications.reports';
/** In-app report copies have threads `report:…` (D-45); `;` sorts right after `:`. */
const REPORT_THREAD_FROM = 'report:';
const REPORT_THREAD_TO = 'report;';
const SORTS: Readonly<Record<'created_at' | 'updated_at', SortExpr>> = {
  created_at: { expr: sql.ref('created_at'), nullValue: 0 },
  updated_at: { expr: sql.ref('updated_at'), nullValue: 0 },
};

/** SQLite implementation of {@link NotificationRepository}. */
export class SqliteNotificationRepository implements NotificationRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: NotificationRecord): Promise<void> {
    await this.#db
      .insertInto('notifications')
      .values(notificationToRow(record))
      .onConflict((oc) => oc.column('notification_id').doNothing())
      .execute();
  }

  async get(notificationId: string): Promise<NotificationRecord | null> {
    const row = await this.#db
      .selectFrom('notifications')
      .selectAll()
      .where('notification_id', '=', notificationId)
      .executeTakeFirst();
    return row === undefined ? null : notificationFromRow(row);
  }

  async findOpenGroup(
    principalId: string | null,
    groupKey: string,
  ): Promise<NotificationRecord | null> {
    let qb = this.#db
      .selectFrom('notifications')
      .selectAll()
      .where('group_key', '=', groupKey)
      .where('read_at', 'is', null)
      .where('dismissed_at', 'is', null);
    qb =
      principalId === null
        ? qb.where('principal_id', 'is', null)
        : qb.where('principal_id', '=', principalId);
    const row = await qb.orderBy('updated_at', 'desc').limit(1).executeTakeFirst();
    return row === undefined ? null : notificationFromRow(row);
  }

  async updateGroup(
    notificationId: string,
    patch: NotificationGroupPatch,
  ): Promise<NotificationRecord | null> {
    const result = await this.#db
      .updateTable('notifications')
      .set({
        title: patch.title,
        body: patch.body,
        target: patch.target,
        source_event_id: patch.sourceEventId,
        count: patch.count,
        updated_at: patch.updatedAt,
        revision: patch.revision,
        message_json: patch.messageJson,
      })
      .where('notification_id', '=', notificationId)
      .where('read_at', 'is', null)
      .where('dismissed_at', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return null;
    return this.get(notificationId);
  }

  async findLatestByThread(
    principalId: string | null,
    thread: string,
  ): Promise<NotificationRecord | null> {
    let qb = this.#db.selectFrom('notifications').selectAll().where('thread', '=', thread);
    qb =
      principalId === null
        ? qb.where('principal_id', 'is', null)
        : qb.where('principal_id', '=', principalId);
    const row = await qb
      .orderBy('created_at', 'desc')
      .orderBy('notification_id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : notificationFromRow(row);
  }

  async revise(
    notificationId: string,
    patch: NotificationRevisionPatch,
  ): Promise<NotificationRecord | null> {
    const result = await this.#db
      .updateTable('notifications')
      .set({
        state: patch.state,
        severity: patch.severity,
        revision: patch.revision,
        ...(patch.messageJson !== null && { message_json: patch.messageJson }),
      })
      .where('notification_id', '=', notificationId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return null;
    return this.get(notificationId);
  }

  async listUnsettled(
    kinds: readonly string[],
    limit: number,
  ): Promise<readonly NotificationRecord[]> {
    if (kinds.length === 0) return [];
    const rows = await this.#db
      .selectFrom('notifications')
      .selectAll()
      .where('state', 'in', ['open', 'acted'])
      .where('kind', 'in', [...kinds])
      .orderBy('created_at')
      .limit(Math.max(1, limit))
      .execute();
    return rows.map(notificationFromRow);
  }

  async list(query: NotificationListQuery): Promise<Page<NotificationRecord>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const sortKeyName = query.sort ?? 'updated_at';
    const order = SORTS[sortKeyName];
    // A cursor is bound to the sort key that minted it.
    const resource = sortKeyName === 'updated_at' ? RESOURCE : `${RESOURCE}.${sortKeyName}`;
    const cursor = decodeCursor(resource, query.cursor);
    const filtered = () => {
      let qb = this.#db.selectFrom('notifications').where('dismissed_at', 'is', null);
      if (query.principalId !== undefined) {
        qb =
          query.principalId === null
            ? qb.where('principal_id', 'is', null)
            : qb.where('principal_id', '=', query.principalId);
      }
      if (query.read === 'unread') qb = qb.where('read_at', 'is', null);
      if (query.read === 'read') qb = qb.where('read_at', 'is not', null);
      const types = query.types ?? [];
      const categories = query.categories ?? [];
      if (types.length > 0 || categories.length > 0) {
        // Type and category are one facet: a row matches either (D-45).
        qb = qb.where((eb) =>
          eb.or([
            ...(types.length > 0 ? [eb('type', 'in', [...types])] : []),
            ...(categories.length > 0 ? [eb('category', 'in', [...categories])] : []),
          ]),
        );
      }
      if (query.since !== undefined) qb = qb.where(sortKeyName, '>=', query.since);
      if (query.until !== undefined) qb = qb.where(sortKeyName, '<=', query.until);
      return qb;
    };
    let qb = filtered().selectAll();
    if (cursor !== null) qb = qb.where(keysetWhere(order, sql.ref('notification_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(order), dir)
      .orderBy('notification_id', dir)
      .limit(limit + 1)
      .execute();
    let total: number | undefined;
    if (query.total === true) {
      total = asNumber(
        (await filtered().select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst())?.n,
      );
    }
    return toPage(
      resource,
      rows,
      limit,
      notificationFromRow,
      (row) => ({ key: row[sortKeyName], id: row.notification_id }),
      total,
    );
  }

  async listReports(query: ReportListQuery): Promise<Page<NotificationRecord>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const order = SORTS.created_at;
    const cursor = decodeCursor(REPORTS_RESOURCE, query.cursor);
    const filtered = () => {
      let qb = this.#db
        .selectFrom('notifications')
        .where('category', '=', 'reports')
        .where('thread', '>=', REPORT_THREAD_FROM)
        .where('thread', '<', REPORT_THREAD_TO);
      if (query.kinds !== undefined && query.kinds.length > 0)
        qb = qb.where('kind', 'in', [...query.kinds]);
      if (query.channelId !== undefined) {
        const channelId = query.channelId;
        qb = qb.where('notification_id', 'in', (eb) =>
          eb
            .selectFrom('notification_deliveries as d')
            .innerJoin('notifications as c', 'c.notification_id', 'd.notification_id')
            .select('c.source_event_id')
            .where('d.channel_id', '=', channelId)
            .where('c.category', '=', 'reports')
            .where('c.source_event_id', 'is not', null),
        );
      }
      if (query.inAppOnly === true) {
        qb = qb.where('notification_id', 'not in', (eb) =>
          eb
            .selectFrom('notifications as c')
            .select('c.source_event_id')
            .where('c.category', '=', 'reports')
            .where('c.source_event_id', 'is not', null),
        );
      }
      if (query.since !== undefined) qb = qb.where('created_at', '>=', query.since);
      if (query.until !== undefined) qb = qb.where('created_at', '<=', query.until);
      return qb;
    };
    let qb = filtered().selectAll();
    if (cursor !== null) qb = qb.where(keysetWhere(order, sql.ref('notification_id'), dir, cursor));
    const rows = await qb
      .orderBy(sortKey(order), dir)
      .orderBy('notification_id', dir)
      .limit(limit + 1)
      .execute();
    let total: number | undefined;
    if (query.total === true) {
      total = asNumber(
        (await filtered().select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst())?.n,
      );
    }
    return toPage(
      REPORTS_RESOURCE,
      rows,
      limit,
      notificationFromRow,
      (row) => ({ key: row.created_at, id: row.notification_id }),
      total,
    );
  }

  async reportChannels(
    reportIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ReportChannelRow[]>> {
    const out = new Map<string, ReportChannelRow[]>();
    if (reportIds.length === 0) return out;
    const rows = await this.#db
      .selectFrom('notifications as c')
      .innerJoin('notification_deliveries as d', 'd.notification_id', 'c.notification_id')
      .leftJoin('notification_channels as ch', 'ch.channel_id', 'd.channel_id')
      .select([
        'c.source_event_id as report_id',
        'd.channel_id',
        'd.status',
        'd.reason',
        'd.seq',
        'ch.name',
        'ch.kind',
      ])
      .where('c.source_event_id', 'in', [...reportIds])
      .where('c.category', '=', 'reports')
      .orderBy('d.seq', 'asc')
      .execute();
    // The latest row per (report, channel) wins; channels keep the order they were first reached.
    const latest = new Map<string, Map<string, ReportChannelRow>>();
    for (const row of rows) {
      if (row.report_id === null || row.name === null || row.kind === null) continue;
      const byChannel = latest.get(row.report_id) ?? new Map<string, ReportChannelRow>();
      byChannel.set(row.channel_id, {
        channelId: row.channel_id,
        name: row.name,
        kind: row.kind,
        status: row.status,
        reason: row.reason,
      });
      latest.set(row.report_id, byChannel);
    }
    for (const [id, byChannel] of latest) out.set(id, [...byChannel.values()]);
    return out;
  }

  async unreadCount(principalId: string | null): Promise<number> {
    let qb = this.#db
      .selectFrom('notifications')
      .select(sql<number>`COUNT(*)`.as('n'))
      .where('read_at', 'is', null)
      .where('dismissed_at', 'is', null);
    qb =
      principalId === null
        ? qb.where('principal_id', 'is', null)
        : qb.where('principal_id', '=', principalId);
    return asNumber((await qb.executeTakeFirst())?.n);
  }

  async markRead(notificationId: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('notifications')
      .set({ read_at: at })
      .where('notification_id', '=', notificationId)
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async markAllRead(principalId: string | null, at: number): Promise<number> {
    let qb = this.#db
      .updateTable('notifications')
      .set({ read_at: at })
      .where('read_at', 'is', null)
      .where('dismissed_at', 'is', null);
    qb =
      principalId === null
        ? qb.where('principal_id', 'is', null)
        : qb.where('principal_id', '=', principalId);
    return Number((await qb.executeTakeFirst()).numUpdatedRows);
  }

  async dismiss(notificationId: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('notifications')
      .set({ dismissed_at: at })
      .where('notification_id', '=', notificationId)
      .where('dismissed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async dismissAll(principalId: string | null, at: number): Promise<number> {
    let qb = this.#db
      .updateTable('notifications')
      .set({ dismissed_at: at })
      .where('dismissed_at', 'is', null);
    qb =
      principalId === null
        ? qb.where('principal_id', 'is', null)
        : qb.where('principal_id', '=', principalId);
    return Number((await qb.executeTakeFirst()).numUpdatedRows);
  }
}

/** SQLite implementation of {@link PreferenceRepository}. */
export class SqlitePreferenceRepository implements PreferenceRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(principalId: string): Promise<readonly PreferenceRecord[]> {
    const rows = await this.#db
      .selectFrom('preferences')
      .selectAll()
      .where('principal_id', '=', principalId)
      .orderBy('key', 'asc')
      .execute();
    return rows.map(preferenceFromRow);
  }

  async get(principalId: string, key: string): Promise<PreferenceRecord | null> {
    const row = await this.#db
      .selectFrom('preferences')
      .selectAll()
      .where('principal_id', '=', principalId)
      .where('key', '=', key)
      .executeTakeFirst();
    return row === undefined ? null : preferenceFromRow(row);
  }

  async set(principalId: string, key: string, value: JsonValue, at: number): Promise<void> {
    await this.#db
      .insertInto('preferences')
      .values({ principal_id: principalId, key, value_json: toJson(value), updated_at: at })
      .onConflict((oc) =>
        oc
          .columns(['principal_id', 'key'])
          .doUpdateSet({ value_json: toJson(value), updated_at: at }),
      )
      .execute();
  }

  async replaceAll(
    principalId: string,
    values: Readonly<Record<string, JsonValue>>,
    at: number,
  ): Promise<void> {
    const keys = Object.keys(values);
    let del = this.#db.deleteFrom('preferences').where('principal_id', '=', principalId);
    if (keys.length > 0) del = del.where('key', 'not in', keys);
    await del.execute();
    for (const key of keys) await this.set(principalId, key, values[key], at);
  }

  async remove(principalId: string, key: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('preferences')
      .where('principal_id', '=', principalId)
      .where('key', '=', key)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
