/** @module test/helpers/in-memory-repos-operations — Map-backed system_events and notifications repositories for app tests. */

import type {
  NotificationRepository,
  ReportChannelRow,
} from '../../src/ports/persistence/notifications.ts';
import type { SystemEventRepository } from '../../src/ports/persistence/operations.ts';
import type {
  NotificationListQuery,
  Page,
  ReportListQuery,
  SystemEventListQuery,
} from '../../src/ports/persistence/queries.ts';
import type {
  NewSystemEvent,
  NotificationGroupPatch,
  NotificationRecord,
  NotificationRevisionPatch,
  SystemEventRecord,
} from '../../src/ports/persistence/records.ts';
import { inWindow, pageOf } from './in-memory-repos-facts.ts';

export class InMemorySystemEventRepository implements SystemEventRepository {
  readonly rows: SystemEventRecord[] = [];

  async record(event: NewSystemEvent): Promise<SystemEventRecord> {
    const key = JSON.stringify(event.details);
    const index = this.rows.findIndex(
      (r) => r.code === event.code && r.resolvedAt === null && JSON.stringify(r.details) === key,
    );
    const existing = this.rows[index];
    if (existing !== undefined) {
      const merged: SystemEventRecord = {
        ...existing,
        lastSeenAt: event.at,
        count: existing.count + 1,
        message: event.message,
      };
      this.rows[index] = merged;
      return merged;
    }
    const created: SystemEventRecord = {
      seq: this.rows.length + 1,
      eventId: event.eventId,
      code: event.code,
      severity: event.severity,
      message: event.message,
      details: event.details,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      count: 1,
      resolvedAt: null,
    };
    this.rows.push(created);
    return created;
  }

  async resolve(code: string, at: number): Promise<number> {
    let n = 0;
    this.rows.forEach((r, i) => {
      if (r.code === code && r.resolvedAt === null) {
        this.rows[i] = { ...r, resolvedAt: at };
        n++;
      }
    });
    return n;
  }

  async list(query: SystemEventListQuery): Promise<Page<SystemEventRecord>> {
    const rows = this.rows
      .filter((r) => query.severities === undefined || query.severities.includes(r.severity))
      .filter((r) => query.openOnly !== true || r.resolvedAt === null);
    return pageOf(rows, query);
  }

  async open(): Promise<readonly SystemEventRecord[]> {
    return this.rows.filter((r) => r.resolvedAt === null);
  }
}

/** `notifications` in memory. */
/** What `reportChannels` joins: the delivery rows and the channels (set by the bundle). */
export interface ReportJoin {
  deliveries(): readonly {
    readonly seq: number;
    readonly channelId: string;
    readonly notificationId: string;
    readonly status: string;
    readonly reason: string | null;
  }[];
  channel(channelId: string): { readonly name: string; readonly kind: string } | undefined;
}

export class InMemoryNotificationRepository implements NotificationRepository {
  readonly rows = new Map<string, NotificationRecord>();
  /** Set by `InMemoryRepositories`; without it no report reached a channel. */
  join: ReportJoin | undefined;

  async insert(record: NotificationRecord): Promise<void> {
    if (!this.rows.has(record.notificationId)) this.rows.set(record.notificationId, record);
  }

  async get(notificationId: string): Promise<NotificationRecord | null> {
    return this.rows.get(notificationId) ?? null;
  }

  async findOpenGroup(
    principalId: string | null,
    groupKey: string,
  ): Promise<NotificationRecord | null> {
    const open = [...this.rows.values()]
      .filter(
        (r) =>
          r.principalId === principalId &&
          r.groupKey === groupKey &&
          r.readAt === null &&
          r.dismissedAt === null,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return open[0] ?? null;
  }

  async updateGroup(
    notificationId: string,
    patch: NotificationGroupPatch,
  ): Promise<NotificationRecord | null> {
    const row = this.rows.get(notificationId);
    if (row === undefined || row.readAt !== null || row.dismissedAt !== null) return null;
    const next: NotificationRecord = { ...row, ...patch };
    this.rows.set(notificationId, next);
    return next;
  }

  async findLatestByThread(
    principalId: string | null,
    thread: string,
  ): Promise<NotificationRecord | null> {
    const rows = [...this.rows.values()]
      .filter((r) => r.principalId === principalId && r.thread === thread)
      .sort(
        (a, b) => b.createdAt - a.createdAt || b.notificationId.localeCompare(a.notificationId),
      );
    return rows[0] ?? null;
  }

  async revise(
    notificationId: string,
    patch: NotificationRevisionPatch,
  ): Promise<NotificationRecord | null> {
    const row = this.rows.get(notificationId);
    if (row === undefined) return null;
    const next: NotificationRecord = {
      ...row,
      state: patch.state,
      severity: patch.severity,
      revision: patch.revision,
      messageJson: patch.messageJson ?? row.messageJson,
    };
    this.rows.set(notificationId, next);
    return next;
  }

  async listUnsettled(
    kinds: readonly string[],
    limit: number,
  ): Promise<readonly NotificationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (r.state === 'open' || r.state === 'acted') && kinds.includes(r.kind))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(1, limit));
  }

  async list(query: NotificationListQuery): Promise<Page<NotificationRecord>> {
    const key = query.sort ?? 'updated_at';
    const at = (r: NotificationRecord) => (key === 'updated_at' ? r.updatedAt : r.createdAt);
    const rows = inWindow(
      [...this.rows.values()].map((r) => ({ ...r, ts: at(r) })),
      query,
    )
      .filter((r) => query.principalId === undefined || r.principalId === query.principalId)
      .filter((r) => {
        const types = query.types ?? [];
        const categories = query.categories ?? [];
        if (types.length === 0 && categories.length === 0) return true;
        return types.includes(r.type) || categories.includes(r.category);
      })
      .filter(
        (r) => (query.read ?? 'all') === 'all' || (query.read === 'read') === (r.readAt !== null),
      )
      .sort((a, b) => b.ts - a.ts)
      .map(({ ts: _ts, ...rest }) => rest);
    return pageOf(rows, query);
  }

  async listReports(query: ReportListQuery): Promise<Page<NotificationRecord>> {
    const copies = (id: string) =>
      [...this.rows.values()].filter((c) => c.category === 'reports' && c.sourceEventId === id);
    const reached = (id: string) => {
      const ids = new Set(copies(id).map((c) => c.notificationId));
      return (this.join?.deliveries() ?? []).filter((d) => ids.has(d.notificationId));
    };
    const rows = inWindow(
      [...this.rows.values()].map((r) => ({ ...r, ts: r.createdAt })),
      query,
    )
      .filter((r) => r.category === 'reports' && (r.thread ?? '').startsWith('report:'))
      .filter((r) => query.kinds === undefined || query.kinds.includes(r.kind))
      .filter(
        (r) =>
          query.channelId === undefined ||
          reached(r.notificationId).some((d) => d.channelId === query.channelId),
      )
      .filter((r) => query.inAppOnly !== true || copies(r.notificationId).length === 0)
      .sort((a, b) => b.ts - a.ts || b.notificationId.localeCompare(a.notificationId))
      .map(({ ts: _ts, ...rest }) => rest);
    return pageOf(rows, query);
  }

  async reportChannels(
    reportIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ReportChannelRow[]>> {
    const out = new Map<string, ReportChannelRow[]>();
    const deliveries = [...(this.join?.deliveries() ?? [])].sort((a, b) => a.seq - b.seq);
    for (const id of reportIds) {
      const ids = new Set(
        [...this.rows.values()]
          .filter((c) => c.category === 'reports' && c.sourceEventId === id)
          .map((c) => c.notificationId),
      );
      const byChannel = new Map<string, ReportChannelRow>();
      for (const d of deliveries) {
        if (!ids.has(d.notificationId)) continue;
        const channel = this.join?.channel(d.channelId);
        if (channel === undefined) continue;
        byChannel.set(d.channelId, {
          channelId: d.channelId,
          name: channel.name,
          kind: channel.kind,
          status: d.status,
          reason: d.reason,
        });
      }
      if (byChannel.size > 0) out.set(id, [...byChannel.values()]);
    }
    return out;
  }

  async unreadCount(principalId: string | null): Promise<number> {
    return [...this.rows.values()].filter((r) => r.principalId === principalId && r.readAt === null)
      .length;
  }

  async markRead(notificationId: string, at: number): Promise<boolean> {
    const row = this.rows.get(notificationId);
    if (row === undefined) return false;
    this.rows.set(notificationId, { ...row, readAt: at });
    return true;
  }

  async markAllRead(principalId: string | null, at: number): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.principalId === principalId && row.readAt === null) {
        this.rows.set(row.notificationId, { ...row, readAt: at });
        n++;
      }
    }
    return n;
  }

  async dismiss(notificationId: string, at: number): Promise<boolean> {
    const row = this.rows.get(notificationId);
    if (row === undefined) return false;
    this.rows.set(notificationId, { ...row, dismissedAt: at });
    return true;
  }

  async dismissAll(principalId: string | null, at: number): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.principalId === principalId && row.dismissedAt === null) {
        this.rows.set(row.notificationId, { ...row, dismissedAt: at });
        n++;
      }
    }
    return n;
  }
}

/** The bundle: modelled repositories are real, the rest throw on use. */
