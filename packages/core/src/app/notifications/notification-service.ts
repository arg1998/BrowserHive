/** @module app/notifications/notification-service — server-side notification producer + inbox API (D-16, D-32, D-34, spec 03 §4.8/§9): bus rules → rows with their contract message → in-app channel inline and external channels through the outbox; lifecycle revisions; read/dismiss state with `notification.*` events. */

import type { Notification } from '@browserhive/contracts/http';
import { Notification as NotificationSchema } from '@browserhive/contracts/http';
import { parseSessionId } from '@browserhive/contracts/ids';
import type { NotificationMessage } from '@browserhive/contracts/notifications';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { createRedactor, type Redactor } from '../../kernel/redact.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { LinkBuilder, NotificationChannel } from '../../ports/notification-channel.ts';
import type { NotificationRepository } from '../../ports/persistence/notifications.ts';
import type { NotificationListQuery, Page } from '../../ports/persistence/queries.ts';
import type {
  NewNotificationDelivery,
  NotificationRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { createInAppChannel } from './in-app-channel.ts';
import {
  buildMessage,
  decodeMessage,
  encodeMessage,
  reviseMessage,
  scrubMessage,
} from './message.ts';
import type { NotificationOutbox } from './outbox.ts';
import {
  draftFor,
  NOTIFICATION_GROUP_IDLE_MS,
  NOTIFICATION_GROUP_MAX_AGE_MS,
  type NotificationDraft,
  type NotificationGroup,
  type ProducedEvent,
  revisionFor,
  type ThreadRevision,
} from './producers.ts';

/** Days a read or dismissed notification is kept (spec 03 §7.1). */
export const NOTIFICATION_SEEN_DAYS = 30;
/** Days an untouched notification is kept (spec 03 §7.1). */
export const NOTIFICATION_DAYS = 90;
/** Number of recent idempotency keys remembered for replay de-duplication. */
export const DEDUP_WINDOW = 2000;
/** Rows touched by one bulk read/dismiss (the repository does the update; events go per row). */
const BULK_EVENT_LIMIT = 500;
/** The in-app channel needs no absolute links. */
const INBOX_LINKS: LinkBuilder = { local: true, url: (path) => path };

/** Dependencies of {@link NotificationService}. */
export interface NotificationServiceDeps {
  readonly repo: NotificationRepository;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /**
   * Transaction boundary: a notification change and its outbox rows commit together (D-34). Needed
   * only when `outbox` is set.
   */
  readonly uow?: UnitOfWork;
  /** The delivery outbox for external channels; absent = in-app only. */
  readonly outbox?: Pick<NotificationOutbox, 'plan' | 'kick'>;
  /**
   * Redacts every string a producer copied from an event (spec 10 §9). Defaults to the key and
   * pattern redactor; composition passes the one bound to the `SecretRegistry`.
   */
  readonly redactor?: Redactor;
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
    kind: record.kind,
    category: record.category,
    severity: record.severity,
    state: record.state,
    revision: record.revision,
    thread: record.thread,
  });
}

/**
 * A message for the in-app delivery of a row that has none stored (a row from before schema v5).
 * Transient: it is never persisted or sent to an external channel, so nothing is fabricated.
 */
function transientMessage(record: NotificationRecord): NotificationMessage {
  return buildMessage({
    id: record.notificationId,
    revision: record.revision,
    thread: record.thread,
    kind: record.kind,
    severity: record.severity,
    state: record.state,
    alert: false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    title: record.title,
    summary: record.body ?? '',
    blocks: [],
    actions: [],
    entities: {},
  });
}

/**
 * Subscribes the producer rules to the bus, persists rows (with their contract message) for every
 * recipient inbox, delivers them through the in-app channel and enqueues them for external
 * channels in the same transaction, applies lifecycle revisions, and serves the inbox API used by
 * HTTP. Producer work is serialised on one chain (`idle()`), and no handler failure escapes to the
 * bus.
 */
export class NotificationService {
  private readonly inApp: NotificationChannel;
  private readonly redactor: Redactor;
  private readonly log: Logger;
  private readonly seen = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotificationServiceDeps) {
    this.inApp = createInAppChannel(deps.bus);
    this.redactor = deps.redactor ?? createRedactor();
    this.log = deps.logger.child({ module: 'notifications' });
  }

  /** Subscribes the producers. Idempotent; returns the unsubscribe function. */
  start(): () => void {
    if (this.unsubscribe.length === 0) {
      const bus = this.deps.bus;
      const on = (event: ProducedEvent) => this.enqueue(event);
      this.unsubscribe.push(
        bus.subscribe('attention.created', on),
        bus.subscribe('attention.resolved', on),
        bus.subscribe('session.closed', on),
        bus.subscribe('tool.called', on),
        bus.subscribe('vault.confirm.created', on),
        bus.subscribe('vault.confirm.resolved', on),
        bus.subscribe('system.degraded', on),
        bus.subscribe('system.recovered', on),
        bus.subscribe('notification.channel.changed', on),
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
   * Applies the producer and revision tables to one event (de-dup + grouping): creates or grows one
   * row per recipient, or revises the rows of a thread.
   *
   * @returns The created, grown or revised notifications (empty when silent or replayed).
   */
  async produce(event: ProducedEvent): Promise<readonly Notification[]> {
    const revision = revisionFor(event);
    if (revision !== null) return this.revise(revision);
    const draft = draftFor(event);
    if (draft === null) return [];
    if (this.seen.has(draft.dedupKey)) return [];
    this.remember(draft.dedupKey);
    const out: Notification[] = [];
    let primary = true;
    for (const principalId of (this.deps.recipients ?? (() => [null]))()) {
      const grown =
        draft.group === undefined
          ? null
          : await this.grow(draft, draft.group, principalId, primary);
      out.push(grown ?? (await this.create(draft, principalId, primary)));
      primary = false;
    }
    return out;
  }

  /**
   * Persists one notification with its first message, enqueues it for external channels in the
   * same transaction (first recipient only: channels are instance-wide), and delivers it in-app.
   *
   * @returns The stored DTO.
   */
  async create(
    draft: NotificationDraft,
    principalId: string | null,
    primary = true,
  ): Promise<Notification> {
    const now = this.deps.clock.now();
    const notificationId = `n-${this.deps.ids.opaque(12)}`;
    const message = scrubMessage(
      buildMessage({
        id: notificationId,
        revision: 1,
        thread: draft.thread,
        kind: draft.kind,
        severity: draft.severity,
        state: draft.state,
        alert: true,
        createdAt: now,
        updatedAt: now,
        title: draft.title,
        summary: draft.body ?? '',
        ...draft.content(1),
      }),
      this.redactor,
    );
    const record: NotificationRecord = {
      notificationId,
      principalId,
      type: draft.type,
      title: this.redactor.scrubText(draft.title),
      body: draft.body === null ? null : this.redactor.scrubText(draft.body),
      sessionId: draft.sessionId,
      target: draft.target,
      sourceEventId: draft.sourceEventId,
      createdAt: now,
      updatedAt: now,
      count: 1,
      groupKey: draft.group?.key ?? null,
      readAt: null,
      dismissedAt: null,
      kind: draft.kind,
      category: message.category,
      severity: draft.severity,
      state: draft.state,
      revision: 1,
      thread: draft.thread,
      messageJson: encodeMessage(message),
    };
    const jobs = primary ? this.plan(message, now) : [];
    await this.write(jobs, async (repos) => {
      await repos.notifications.insert(record);
      return true;
    });
    const dto = toNotification(record);
    this.log.info('notification created', { type: dto.type, notification_id: dto.notification_id });
    await this.inbox('send', dto, message);
    this.kick(jobs);
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
   * Folds a draft into the inbox's open row of its group when that row is still fresh: the row
   * gains a revision whose message is rebuilt from the latest occurrence (silent, `alert: false`),
   * enqueued as an edit in the same transaction; in-app it goes out as `notification.updated`.
   *
   * @returns The grown DTO, or `null` when a new row must be created.
   */
  private async grow(
    draft: NotificationDraft,
    group: NotificationGroup,
    principalId: string | null,
    primary: boolean,
  ): Promise<Notification | null> {
    const open = await this.deps.repo.findOpenGroup(principalId, group.key);
    if (open === null) return null;
    const now = this.deps.clock.now();
    const idleMs = this.deps.groupIdleMs ?? NOTIFICATION_GROUP_IDLE_MS;
    const maxAgeMs = this.deps.groupMaxAgeMs ?? NOTIFICATION_GROUP_MAX_AGE_MS;
    if (now - open.updatedAt >= idleMs || now - open.createdAt >= maxAgeMs) return null;
    const count = open.count + 1;
    const updatedAt = Math.max(now, open.updatedAt);
    const revision = open.revision + 1;
    const message = scrubMessage(
      buildMessage({
        id: open.notificationId,
        revision,
        thread: open.thread,
        kind: draft.kind,
        severity: draft.severity,
        state: open.state,
        alert: false,
        createdAt: open.createdAt,
        updatedAt,
        title: group.title(count),
        summary: draft.body ?? '',
        ...draft.content(count),
      }),
      this.redactor,
    );
    const jobs = primary ? this.plan(message, now) : [];
    const result: { row: NotificationRecord | null } = { row: null };
    await this.write(jobs, async (repos) => {
      result.row = await repos.notifications.updateGroup(open.notificationId, {
        title: this.redactor.scrubText(group.title(count)),
        body: draft.body === null ? null : this.redactor.scrubText(draft.body),
        target: draft.target,
        sourceEventId: draft.sourceEventId,
        count,
        updatedAt,
        revision,
        messageJson: encodeMessage(message),
      });
      return result.row !== null;
    });
    if (result.row === null) return null;
    const dto = toNotification(result.row);
    this.log.debug('notification grown', { notification_id: dto.notification_id, count });
    await this.inbox('edit', dto, message);
    this.kick(jobs);
    return dto;
  }

  /**
   * Applies a lifecycle revision to the newest notification of a thread in every inbox (a request
   * resolved, a degradation recovered). The in-app title, body and `updated_at` stay; state,
   * revision and the message change, and the edit is enqueued for external channels. Rows that
   * are no longer open, and rows from before schema v5 (no stored message), are revised in their
   * classification fields only.
   *
   * @returns The revised DTOs.
   */
  private async revise(revision: ThreadRevision): Promise<readonly Notification[]> {
    if (this.seen.has(revision.dedupKey)) return [];
    this.remember(revision.dedupKey);
    const out: Notification[] = [];
    let primary = true;
    for (const principalId of (this.deps.recipients ?? (() => [null]))()) {
      const isPrimary = primary;
      primary = false;
      const row = await this.deps.repo.findLatestByThread(principalId, revision.thread);
      if (row === null || (row.state !== 'open' && row.state !== 'acted')) continue;
      if (row.state === revision.change.state) continue;
      const now = this.deps.clock.now();
      const previous = decodeMessage(row.messageJson);
      const message =
        previous === null
          ? null
          : scrubMessage(reviseMessage(previous, revision.change, now), this.redactor);
      const next = row.revision + 1;
      const jobs = isPrimary && message !== null ? this.plan(message, now) : [];
      const result: { row: NotificationRecord | null } = { row: null };
      await this.write(jobs, async (repos) => {
        result.row = await repos.notifications.revise(row.notificationId, {
          state: revision.change.state,
          severity: revision.change.severity ?? row.severity,
          revision: next,
          messageJson: message === null ? null : encodeMessage(message),
        });
        return result.row !== null;
      });
      const updated = result.row;
      if (updated === null) continue;
      const dto = toNotification(updated);
      this.log.debug('notification revised', {
        notification_id: dto.notification_id,
        state: dto.state,
      });
      await this.inbox('edit', dto, message ?? transientMessage(updated));
      this.kick(jobs);
      out.push(dto);
    }
    return out;
  }

  /** Outbox rows for a change; none without an outbox, or when there is no unit of work. */
  private plan(message: NotificationMessage, now: number): NewNotificationDelivery[] {
    if (this.deps.outbox === undefined || this.deps.uow === undefined) return [];
    return this.deps.outbox.plan(message, now);
  }

  /**
   * Runs `change` and enqueues `jobs` in one transaction (D-34). Without jobs the change runs on
   * the auto-commit repository, exactly as before the outbox existed. `change` returns false when
   * nothing was updated, which rolls the jobs back.
   */
  private async write(
    jobs: readonly NewNotificationDelivery[],
    change: (repos: Pick<Repositories, 'notifications'>) => Promise<boolean>,
  ): Promise<void> {
    const uow = this.deps.uow;
    if (jobs.length === 0 || uow === undefined) {
      await change({ notifications: this.deps.repo });
      return;
    }
    await uow.transaction(async (repos) => {
      if (await change(repos)) await repos.notificationDeliveries.enqueue(jobs);
    });
  }

  /** Delivers the row to the in-app channel (inline, after the commit). Never throws. */
  private async inbox(
    op: 'send' | 'edit',
    dto: Notification,
    message: NotificationMessage,
  ): Promise<void> {
    const delivery = { message, links: INBOX_LINKS, replyTo: null, inbox: dto };
    try {
      if (op === 'send' || this.inApp.edit === undefined) await this.inApp.send(delivery);
      else await this.inApp.edit({ notification_id: dto.notification_id }, delivery);
    } catch (err) {
      this.log.warn('in-app delivery failed', { err: serializeError(err) });
    }
  }

  /** Wakes the outbox when work was enqueued. */
  private kick(jobs: readonly NewNotificationDelivery[]): void {
    if (jobs.some((j) => j.status === 'pending')) this.deps.outbox?.kick();
  }
}
