/** @module app/notifications/notification-service — server-side notification producer + inbox API (D-16, spec 03 §4.8/§9): bus rules → rows → channels; read/dismiss state with `notification.*` events. */

import type { Notification } from '@browserhive/contracts/http';
import { Notification as NotificationSchema } from '@browserhive/contracts/http';
import { parseSessionId } from '@browserhive/contracts/ids';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { NotificationChannel } from '../../ports/notification-channel.ts';
import type { NotificationRepository } from '../../ports/persistence/notifications.ts';
import type { NotificationListQuery, Page } from '../../ports/persistence/queries.ts';
import type { NotificationRecord } from '../../ports/persistence/records.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { createInAppChannel } from './in-app-channel.ts';
import {
  draftFor,
  NOTIFICATION_GROUP_IDLE_MS,
  NOTIFICATION_GROUP_MAX_AGE_MS,
  type NotificationDraft,
  type NotificationGroup,
  type ProducedEvent,
} from './producers.ts';

/** Days a read or dismissed notification is kept (spec 03 §7.1). */
export const NOTIFICATION_SEEN_DAYS = 30;
/** Days an untouched notification is kept (spec 03 §7.1). */
export const NOTIFICATION_DAYS = 90;
/** Number of recent idempotency keys remembered for replay de-duplication. */
export const DEDUP_WINDOW = 2000;
/** Rows touched by one bulk read/dismiss (the repository does the update; events go per row). */
const BULK_EVENT_LIMIT = 500;

/** Dependencies of {@link NotificationService}. */
export interface NotificationServiceDeps {
  readonly repo: NotificationRepository;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** External channels on top of the built-in in-app channel (none are shipped). */
  readonly channels?: readonly NotificationChannel[];
  /** Inboxes that receive produced rows; default the anonymous inbox (`[null]`). */
  readonly recipients?: () => readonly (string | null)[];
  /** Idle time after which a group row stops growing; default {@link NOTIFICATION_GROUP_IDLE_MS}. */
  readonly groupIdleMs?: number;
  /** Age after which a group row stops growing; default {@link NOTIFICATION_GROUP_MAX_AGE_MS}. */
  readonly groupMaxAgeMs?: number;
}

/**
 * Wire projection of a row (`Notification` DTO), validated so branded ids are honest.
 *
 * @returns The snake_case DTO.
 */
export function toNotification(record: NotificationRecord): Notification {
  return NotificationSchema.parse({
    notification_id: record.notificationId,
    principal_id: record.principalId,
    type: record.type,
    title: record.title,
    body: record.body,
    session_id: record.sessionId,
    session_slug:
      record.sessionId === null ? null : (parseSessionId(record.sessionId)?.slug ?? null),
    target: record.target,
    source_event_id: record.sourceEventId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    count: record.count,
    read_at: record.readAt,
    dismissed_at: record.dismissedAt,
  });
}

/**
 * Subscribes the producer rules to the bus, persists rows for every recipient inbox, delivers
 * them through the channels (in-app first) and serves the inbox API used by HTTP. Producer
 * work is serialised on one chain (`idle()`), and no handler failure escapes to the bus.
 */
export class NotificationService {
  private readonly channels: readonly NotificationChannel[];
  private readonly log: Logger;
  private readonly seen = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotificationServiceDeps) {
    this.channels = [createInAppChannel(deps.bus), ...(deps.channels ?? [])];
    this.log = deps.logger.child({ module: 'notifications' });
  }

  /** Subscribes the producers. Idempotent; returns the unsubscribe function. */
  start(): () => void {
    if (this.unsubscribe.length === 0) {
      const bus = this.deps.bus;
      const on = (event: ProducedEvent) => this.enqueue(event);
      this.unsubscribe.push(
        bus.subscribe('attention.created', on),
        bus.subscribe('session.closed', on),
        bus.subscribe('tool.called', on),
        bus.subscribe('vault.confirm.created', on),
        bus.subscribe('system.degraded', on),
      );
    }
    return () => this.stop();
  }

  /** Unsubscribes the producers. Idempotent. */
  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  /** Resolves once every queued producer event has been processed. */
  idle(): Promise<void> {
    return this.tail;
  }

  /**
   * Applies the producer table to one event (de-dup + grouping), creating or growing one row per
   * recipient.
   *
   * @returns The created or grown notifications (empty when the event is silent or replayed).
   */
  async produce(event: ProducedEvent): Promise<readonly Notification[]> {
    const draft = draftFor(event);
    if (draft === null) return [];
    if (this.seen.has(draft.dedupKey)) return [];
    this.remember(draft.dedupKey);
    const out: Notification[] = [];
    for (const principalId of (this.deps.recipients ?? (() => [null]))()) {
      const grown =
        draft.group === undefined ? null : await this.grow(draft, draft.group, principalId);
      out.push(grown ?? (await this.create(draft, principalId)));
    }
    return out;
  }

  /**
   * Persists one notification and delivers it through every channel.
   *
   * @returns The stored DTO.
   */
  async create(draft: NotificationDraft, principalId: string | null): Promise<Notification> {
    const now = this.deps.clock.now();
    const record: NotificationRecord = {
      notificationId: `n-${this.deps.ids.opaque(12)}`,
      principalId,
      type: draft.type,
      title: draft.title,
      body: draft.body,
      sessionId: draft.sessionId,
      target: draft.target,
      sourceEventId: draft.sourceEventId,
      createdAt: now,
      updatedAt: now,
      count: 1,
      groupKey: draft.group?.key ?? null,
      readAt: null,
      dismissedAt: null,
    };
    await this.deps.repo.insert(record);
    const dto = toNotification(record);
    this.log.info('notification created', { type: dto.type, notification_id: dto.notification_id });
    for (const channel of this.channels) {
      try {
        await channel.send(dto);
      } catch (err) {
        this.log.warn('channel send failed', { channel: channel.name, err: serializeError(err) });
      }
    }
    return dto;
  }

  /** Inbox page, newest first. */
  async list(query: NotificationListQuery): Promise<Page<Notification>> {
    const page = await this.deps.repo.list(query);
    return {
      items: page.items.map(toNotification),
      nextCursor: page.nextCursor,
      ...(page.total !== undefined && { total: page.total }),
    };
  }

  /** Unread, undismissed count (the bell badge). */
  unreadCount(principalId: string | null): Promise<number> {
    return this.deps.repo.unreadCount(principalId);
  }

  /**
   * Marks one notification read.
   *
   * @returns The updated DTO, or `null` when the id is unknown.
   */
  async markRead(notificationId: string): Promise<Notification | null> {
    const row = await this.deps.repo.get(notificationId);
    if (row === null) return null;
    if (row.readAt !== null) return toNotification(row);
    const at = this.deps.clock.now();
    if (!(await this.deps.repo.markRead(notificationId, at))) return toNotification(row);
    return this.publishState('notification.read', { ...row, readAt: at });
  }

  /**
   * Marks every unread notification of the inbox read.
   *
   * @returns Number of rows updated.
   */
  async markAllRead(principalId: string | null = null): Promise<number> {
    const pending = await this.deps.repo.list({
      principalId,
      read: 'unread',
      limit: BULK_EVENT_LIMIT,
    });
    const at = this.deps.clock.now();
    const n = await this.deps.repo.markAllRead(principalId, at);
    for (const row of pending.items) this.publishState('notification.read', { ...row, readAt: at });
    return n;
  }

  /**
   * Dismisses one notification (it leaves the inbox; the row stays until retention).
   *
   * @returns The updated DTO, or `null` when the id is unknown.
   */
  async dismiss(notificationId: string): Promise<Notification | null> {
    const row = await this.deps.repo.get(notificationId);
    if (row === null) return null;
    if (row.dismissedAt !== null) return toNotification(row);
    const at = this.deps.clock.now();
    if (!(await this.deps.repo.dismiss(notificationId, at))) return toNotification(row);
    return this.publishState('notification.dismissed', { ...row, dismissedAt: at });
  }

  /**
   * Dismisses every undismissed notification of the inbox.
   *
   * @returns Number of rows updated.
   */
  async dismissAll(principalId: string | null = null): Promise<number> {
    const pending = await this.deps.repo.list({ principalId, limit: BULK_EVENT_LIMIT });
    const open = pending.items.filter((row) => row.dismissedAt === null);
    const at = this.deps.clock.now();
    const n = await this.deps.repo.dismissAll(principalId, at);
    for (const row of open)
      this.publishState('notification.dismissed', { ...row, dismissedAt: at });
    return n;
  }

  private enqueue(event: ProducedEvent): void {
    const step = async () => {
      await this.produce(event);
    };
    this.tail = this.tail.then(step, step).catch((err: unknown) => {
      this.log.error('notification failed', {
        event: event.name,
        err: serializeError(err),
      });
    });
  }

  private publishState(
    name: 'notification.read' | 'notification.dismissed',
    row: NotificationRecord,
  ): Notification {
    const dto = toNotification(row);
    this.deps.bus.publish(name, { type: name, notification: dto });
    this.deps.bus.publish('notification.updated', {
      type: 'notification.updated',
      notification: dto,
    });
    return dto;
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > DEDUP_WINDOW) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  /**
   * Folds a draft into the inbox's open row of its group when that row is still fresh; the change
   * goes out as `notification.updated` (external channels only see created rows).
   *
   * @returns The grown DTO, or `null` when a new row must be created.
   */
  private async grow(
    draft: NotificationDraft,
    group: NotificationGroup,
    principalId: string | null,
  ): Promise<Notification | null> {
    const open = await this.deps.repo.findOpenGroup(principalId, group.key);
    if (open === null) return null;
    const now = this.deps.clock.now();
    const idleMs = this.deps.groupIdleMs ?? NOTIFICATION_GROUP_IDLE_MS;
    const maxAgeMs = this.deps.groupMaxAgeMs ?? NOTIFICATION_GROUP_MAX_AGE_MS;
    if (now - open.updatedAt >= idleMs || now - open.createdAt >= maxAgeMs) return null;
    const count = open.count + 1;
    const updated = await this.deps.repo.updateGroup(open.notificationId, {
      title: group.title(count),
      body: draft.body,
      target: draft.target,
      sourceEventId: draft.sourceEventId,
      count,
      updatedAt: Math.max(now, open.updatedAt),
    });
    if (updated === null) return null;
    const dto = toNotification(updated);
    this.log.debug('notification grown', { notification_id: dto.notification_id, count });
    this.deps.bus.publish('notification.updated', {
      type: 'notification.updated',
      notification: dto,
    });
    return dto;
  }
}
