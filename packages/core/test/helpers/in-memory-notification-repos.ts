/** @module test/helpers/in-memory-notification-repos — Map-backed notification channel, delivery (outbox) and channel message repositories; the conformance suite runs them beside the SQLite ones. */

import type {
  NotificationChannelStatus,
  NotificationDeliveryStatus,
} from '../../src/ports/persistence/enums.ts';
import type {
  NotificationChannelMessageRepository,
  NotificationChannelRepository,
  NotificationDeliveryRepository,
} from '../../src/ports/persistence/notification-outbox.ts';
import type {
  ChannelDeliveryStats,
  DeliveryFinishPatch,
  NewNotificationDelivery,
  NotificationChannelMessageRecord,
  NotificationChannelRecord,
  NotificationDeliveryListQuery,
  NotificationDeliveryRecord,
  NotificationRecord,
} from '../../src/ports/persistence/records.ts';

const OPEN: ReadonlySet<NotificationDeliveryStatus> = new Set(['pending', 'retrying']);

/** `notification_deliveries` in memory. */
export class InMemoryNotificationDeliveryRepository implements NotificationDeliveryRepository {
  readonly rows: NotificationDeliveryRecord[] = [];
  private nextSeq = 1;

  /** @param notificationOf Looks up a notification (the severity join of `pendingInfoSends`). */
  constructor(private readonly notificationOf: (id: string) => NotificationRecord | undefined) {}

  async enqueue(rows: readonly NewNotificationDelivery[]): Promise<number> {
    let n = 0;
    for (const row of rows) {
      const dup = this.rows.some(
        (r) =>
          r.channelId === row.channelId &&
          r.notificationId === row.notificationId &&
          r.revision === row.revision &&
          r.op === row.op,
      );
      if (dup) continue;
      this.rows.push({
        seq: this.nextSeq++,
        channelId: row.channelId,
        notificationId: row.notificationId,
        revision: row.revision,
        op: row.op,
        status: row.status,
        reason: row.reason,
        attempts: 0,
        nextAttemptAt: row.nextAttemptAt,
        lastError: null,
        durationMs: null,
        messageRef: null,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
      n++;
    }
    return n;
  }

  async get(seq: number): Promise<NotificationDeliveryRecord | null> {
    return this.rows.find((r) => r.seq === seq) ?? null;
  }

  async due(now: number, limit: number): Promise<readonly NotificationDeliveryRecord[]> {
    return this.rows
      .filter((r) => OPEN.has(r.status) && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || a.seq - b.seq)
      .slice(0, Math.max(1, limit));
  }

  private update(seq: number, fn: (r: NotificationDeliveryRecord) => NotificationDeliveryRecord) {
    const i = this.rows.findIndex((r) => r.seq === seq);
    const row = this.rows[i];
    if (row !== undefined) this.rows[i] = fn(row);
  }

  async claim(seq: number, at: number): Promise<boolean> {
    const row = this.rows.find((r) => r.seq === seq);
    if (row === undefined || !OPEN.has(row.status)) return false;
    this.update(seq, (r) => ({ ...r, status: 'sending', attempts: r.attempts + 1, updatedAt: at }));
    return true;
  }

  async finish(seq: number, patch: DeliveryFinishPatch): Promise<void> {
    this.update(seq, (r) => ({
      ...r,
      status: patch.status,
      updatedAt: patch.updatedAt,
      nextAttemptAt: patch.nextAttemptAt ?? null,
      ...(patch.reason !== undefined && { reason: patch.reason }),
      ...(patch.lastError !== undefined && { lastError: patch.lastError }),
      ...(patch.durationMs !== undefined && { durationMs: patch.durationMs }),
      ...(patch.messageRef !== undefined && { messageRef: patch.messageRef }),
    }));
  }

  async annotate(seq: number, reason: string, at: number): Promise<void> {
    this.update(seq, (r) => (OPEN.has(r.status) ? { ...r, reason, updatedAt: at } : r));
  }

  async reschedule(seq: number, nextAttemptAt: number, at: number): Promise<void> {
    this.update(seq, (r) => (OPEN.has(r.status) ? { ...r, nextAttemptAt, updatedAt: at } : r));
  }

  async supersede(
    channelId: string,
    notificationId: string,
    revision: number,
    at: number,
    reason: string,
    exceptSeq?: number,
  ): Promise<number> {
    let n = 0;
    for (const r of [...this.rows]) {
      if (
        r.channelId === channelId &&
        r.notificationId === notificationId &&
        r.revision <= revision &&
        (r.op === 'send' || r.op === 'edit') &&
        OPEN.has(r.status) &&
        r.seq !== exceptSeq
      ) {
        this.update(r.seq, (x) => ({
          ...x,
          status: 'superseded',
          reason,
          nextAttemptAt: null,
          updatedAt: at,
        }));
        n++;
      }
    }
    return n;
  }

  async suppressChannel(channelId: string, reason: string, at: number): Promise<number> {
    let n = 0;
    for (const r of [...this.rows]) {
      if (r.channelId === channelId && OPEN.has(r.status)) {
        this.update(r.seq, (x) => ({
          ...x,
          status: 'suppressed',
          reason,
          nextAttemptAt: null,
          updatedAt: at,
        }));
        n++;
      }
    }
    return n;
  }

  async recoverSending(at: number): Promise<number> {
    let n = 0;
    for (const r of [...this.rows]) {
      if (r.status === 'sending') {
        this.update(r.seq, (x) => ({ ...x, status: 'retrying', nextAttemptAt: at, updatedAt: at }));
        n++;
      }
    }
    return n;
  }

  async pendingInfoSends(channelId: string): Promise<readonly NotificationDeliveryRecord[]> {
    return this.rows
      .filter(
        (r) =>
          r.channelId === channelId &&
          r.op === 'send' &&
          OPEN.has(r.status) &&
          this.notificationOf(r.notificationId)?.severity === 'info',
      )
      .sort((a, b) => a.seq - b.seq);
  }

  async count(statuses: readonly NotificationDeliveryStatus[]): Promise<number> {
    return this.rows.filter((r) => statuses.includes(r.status)).length;
  }

  async list(query: NotificationDeliveryListQuery): Promise<readonly NotificationDeliveryRecord[]> {
    return this.rows
      .filter((r) => query.channelId === undefined || r.channelId === query.channelId)
      .filter(
        (r) => query.notificationId === undefined || r.notificationId === query.notificationId,
      )
      .filter(
        (r) =>
          query.statuses === undefined ||
          query.statuses.length === 0 ||
          query.statuses.includes(r.status),
      )
      .filter((r) => query.ops === undefined || query.ops.length === 0 || query.ops.includes(r.op))
      .filter((r) => {
        if (query.kinds === undefined || query.kinds.length === 0) return true;
        const kind = this.notificationOf(r.notificationId)?.kind;
        return kind !== undefined && query.kinds.includes(kind);
      })
      .filter((r) => query.beforeSeq === undefined || r.seq < query.beforeSeq)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Math.min(Math.max(1, query.limit ?? 100), 1000));
  }

  async stats(since: number): Promise<readonly ChannelDeliveryStats[]> {
    const byChannel = new Map<string, NotificationDeliveryRecord[]>();
    for (const r of this.rows)
      byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r]);
    return [...byChannel.entries()].map(([channelId, rows]) => {
      const recent = (status: NotificationDeliveryStatus) =>
        rows.filter((r) => r.status === status && r.updatedAt >= since).length;
      const finished = rows
        .filter((r) => r.status === 'sent' || r.status === 'dead')
        .sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq);
      const last = finished[0];
      return {
        channelId,
        sent: recent('sent'),
        failed: recent('dead'),
        suppressed: recent('suppressed'),
        pending: rows.filter(
          (r) => r.status === 'pending' || r.status === 'retrying' || r.status === 'sending',
        ).length,
        lastAt: last?.updatedAt ?? null,
        lastStatus: last?.status ?? null,
      };
    });
  }

  /** Drops every job of a channel (the FK cascade). */
  removeChannel(channelId: string): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]?.channelId === channelId) this.rows.splice(i, 1);
    }
  }
}

/** `notification_channel_messages` in memory. */
export class InMemoryNotificationChannelMessageRepository
  implements NotificationChannelMessageRepository
{
  readonly rows = new Map<string, NotificationChannelMessageRecord>();

  constructor(private readonly deliveries: InMemoryNotificationDeliveryRepository) {}

  private key(channelId: string, notificationId: string): string {
    return `${channelId}\u0000${notificationId}`;
  }

  async get(
    channelId: string,
    notificationId: string,
  ): Promise<NotificationChannelMessageRecord | null> {
    return this.rows.get(this.key(channelId, notificationId)) ?? null;
  }

  async upsert(record: NotificationChannelMessageRecord): Promise<void> {
    this.rows.set(this.key(record.channelId, record.notificationId), record);
  }

  async firstInThread(
    channelId: string,
    thread: string,
  ): Promise<NotificationChannelMessageRecord | null> {
    const rows = [...this.rows.values()]
      .filter((r) => r.channelId === channelId && r.thread === thread)
      .sort((a, b) => a.sentAt - b.sentAt);
    return rows[0] ?? null;
  }

  async dueForDelete(
    now: number,
    limit: number,
  ): Promise<readonly NotificationChannelMessageRecord[]> {
    return [...this.rows.values()]
      .filter(
        (m) =>
          m.expiresAt !== null &&
          m.expiresAt <= now &&
          m.deletedAt === null &&
          !this.deliveries.rows.some(
            (d) =>
              d.channelId === m.channelId &&
              d.notificationId === m.notificationId &&
              d.revision === m.lastRevision &&
              d.op === 'delete',
          ),
      )
      .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
      .slice(0, Math.max(1, limit));
  }

  async setExpiry(channelId: string, notificationId: string, expiresAt: number | null) {
    const row = this.rows.get(this.key(channelId, notificationId));
    if (row !== undefined)
      this.rows.set(this.key(channelId, notificationId), { ...row, expiresAt });
  }

  async markDeleted(channelId: string, notificationId: string, at: number): Promise<void> {
    const row = this.rows.get(this.key(channelId, notificationId));
    if (row !== undefined) {
      this.rows.set(this.key(channelId, notificationId), { ...row, deletedAt: at, updatedAt: at });
    }
  }

  /** Drops every message of a channel (the FK cascade). */
  removeChannel(channelId: string): void {
    for (const [k, v] of [...this.rows]) if (v.channelId === channelId) this.rows.delete(k);
  }
}

/** `notification_channels` in memory; `remove` cascades like the foreign keys. */
export class InMemoryNotificationChannelRepository implements NotificationChannelRepository {
  readonly rows = new Map<string, NotificationChannelRecord>();

  constructor(private readonly cascade: { removeChannel(channelId: string): void }[] = []) {}

  async list(): Promise<readonly NotificationChannelRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(channelId: string): Promise<NotificationChannelRecord | null> {
    return this.rows.get(channelId) ?? null;
  }

  async getByName(name: string): Promise<NotificationChannelRecord | null> {
    return [...this.rows.values()].find((r) => r.name === name) ?? null;
  }

  async upsert(record: NotificationChannelRecord): Promise<void> {
    const clash = [...this.rows.values()].find(
      (r) => r.name === record.name && r.channelId !== record.channelId,
    );
    if (clash !== undefined)
      throw new Error(`UNIQUE constraint failed: notification_channels.name`);
    const existing = this.rows.get(record.channelId);
    this.rows.set(
      record.channelId,
      existing === undefined
        ? record
        : {
            ...existing,
            name: record.name,
            kind: record.kind,
            mode: record.mode,
            source: record.source,
            target: record.target,
            secretRefs: record.secretRefs,
            rules: record.rules,
            updatedAt: record.updatedAt,
          },
    );
  }

  async remove(channelId: string): Promise<boolean> {
    const had = this.rows.delete(channelId);
    if (had) for (const c of this.cascade) c.removeChannel(channelId);
    return had;
  }

  async setStatus(channelId: string, status: NotificationChannelStatus, at: number) {
    const row = this.rows.get(channelId);
    if (row === undefined) return false;
    this.rows.set(channelId, {
      ...row,
      status,
      updatedAt: at,
      ...(status === 'active' && { failureCount: 0 }),
    });
    return true;
  }

  async recordSuccess(channelId: string, at: number): Promise<void> {
    const row = this.rows.get(channelId);
    if (row !== undefined) this.rows.set(channelId, { ...row, failureCount: 0, lastOkAt: at });
  }

  async recordFailure(channelId: string, at: number, error: string): Promise<number> {
    const row = this.rows.get(channelId);
    if (row === undefined) return 0;
    const failureCount = row.failureCount + 1;
    this.rows.set(channelId, { ...row, failureCount, lastError: error, lastFailureAt: at });
    return failureCount;
  }
}
