/** @module app/notifications/outbox — the delivery outbox worker (D-34, spec 03 §9.4): drains `notification_deliveries` through the channel adapters with coalescing, edit spacing, retries with backoff and jitter, crash recovery, the circuit breaker (never a degradation), backlog collapse and the TTL sweep. Runs only while an external channel exists. */

import type { NotificationMessage } from '@browserhive/contracts/notifications';
import { SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Redactor } from '../../kernel/redact.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  type ChannelDelivery,
  type ChannelErrorCode,
  ChannelSendError,
  type ChannelSendResult,
  type LinkBuilder,
  type NotificationChannel,
  type PlatformMessageRef,
} from '../../ports/notification-channel.ts';
import type {
  DeliveryFinishPatch,
  NewNotificationDelivery,
  NotificationChannelMessageRecord,
  NotificationDeliveryRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { type IntervalScheduler, realIntervalScheduler } from '../maintenance/timer.ts';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.ts';
import { restrictContent } from './content-level.ts';
import { degrade } from './degrade.ts';
import { applyImageRule } from './images.ts';
import { clip, decodeMessage, text } from './message.ts';
import { contentLevelOf, deleteWhenResolved, expiryFor, planDeliveries } from './routing.ts';

/** Tunables of the worker; the defaults are the documented behaviour (spec 03 §9.4). */
export interface OutboxOptions {
  /** Poll interval while channels exist. */
  readonly tickMs: number;
  /** Jobs processed per pass. */
  readonly batchSize: number;
  /** A job is `dead` after this many attempts. */
  readonly maxAttempts: number;
  /** A job is `dead` once this old. */
  readonly maxAgeMs: number;
  /** First retry delay; doubles per attempt. */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** ± share of the delay drawn at random. */
  readonly jitterRatio: number;
  /** At most one edit per message this often. */
  readonly editSpacingMs: number;
  /** Consecutive failures that open the breaker. */
  readonly breakerThreshold: number;
  /** Pending `info` sends on one channel above which they collapse into the newest. */
  readonly backlogThreshold: number;
  /** A TTL delete this late is logged as late. */
  readonly lateDeleteMs: number;
}

/** The documented defaults. */
export const DEFAULT_OUTBOX_OPTIONS: OutboxOptions = {
  tickMs: 1_000,
  batchSize: 25,
  maxAttempts: 8,
  maxAgeMs: 24 * 60 * 60_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 15 * 60_000,
  jitterRatio: 0.2,
  editSpacingMs: 3_000,
  breakerThreshold: 5,
  backlogThreshold: 20,
  lateDeleteMs: 60_000,
};

/** Longest `last_error` stored on a delivery or a channel. */
const ERROR_MAX = 500;
/** Prefix of the reason that carries a backlog note on the newest pending send. */
const BACKLOG_PREFIX = 'backlog:';

/** Counter the worker increments once per finished or rescheduled job (spec 10 §7). */
export interface DeliveryCounter {
  add(value: number, attributes: { readonly channel_kind: string; readonly status: string }): void;
}

/** Dependencies of {@link NotificationOutbox}. */
export interface NotificationOutboxDeps {
  readonly uow: UnitOfWork;
  /** Auto-commit repositories for reads. */
  readonly repos: Pick<
    Repositories,
    'notifications' | 'notificationDeliveries' | 'notificationChannelMessages'
  >;
  readonly registry: ChannelRegistry;
  readonly links: LinkBuilder;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Receives `notification.channel.changed` when the breaker opens. */
  readonly bus?: EventPublisher<DomainEvents>;
  /** Scrubs platform error text before it is stored. */
  readonly redactor?: Redactor;
  readonly scheduler?: IntervalScheduler;
  /** Uniform [0, 1) for backoff jitter; default a fixed 0.5 (no jitter). */
  readonly jitter?: () => number;
  /** Defaults to `trace.getTracer('browserhive')`. */
  readonly tracer?: Tracer;
  readonly counter?: DeliveryCounter;
  readonly options?: Partial<OutboxOptions>;
  /**
   * Called after a job of (channel, notification) was written (a status change, a new delete job),
   * so the live delivery log can refresh those rows. Must not throw.
   */
  readonly onDeliveryChange?: (channelId: string, notificationId: string) => void;
  /**
   * Mints the command tokens of a message's act buttons for a channel that receives presses
   * (D-41), before the platform call. Absent: act buttons carry no tokens.
   */
  readonly actions?: {
    mint(
      channelId: string,
      message: NotificationMessage,
      now: number,
    ): Promise<ReadonlyMap<string, string>>;
  };
}

/** Summary of one pass (tests, logs). */
export interface OutboxPass {
  readonly processed: number;
  readonly deletesEnqueued: number;
  readonly collapsed: number;
}

interface Classified {
  readonly code: ChannelErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly detail: string;
}

/**
 * The outbox worker. `plan()` is called by the notification service inside its transaction;
 * `kick()` after the commit wakes the worker. With no external channel the worker never arms a
 * timer and `plan()` returns nothing, so the in-app path is unchanged (D-34).
 */
export class NotificationOutbox {
  private readonly opts: OutboxOptions;
  private readonly log: Logger;
  private readonly tracer: Tracer;
  private cancel: (() => void) | undefined;
  private offRegistry: (() => void) | undefined;
  private current: Promise<OutboxPass> | undefined;
  private again = false;
  private started = false;

  constructor(private readonly deps: NotificationOutboxDeps) {
    this.opts = { ...DEFAULT_OUTBOX_OPTIONS, ...deps.options };
    this.log = deps.logger.child({ module: 'notifications' });
    this.tracer = deps.tracer ?? trace.getTracer('browserhive');
  }

  /**
   * The outbox rows for one notification change (spec 03 §9.4); written by the caller in the
   * notification's own transaction.
   *
   * @returns The rows (empty without external channels).
   */
  plan(message: NotificationMessage, now: number): NewNotificationDelivery[] {
    return planDeliveries(message, this.deps.registry.channels(), now);
  }

  /** Wakes the worker after a commit that enqueued work. No-op without channels. */
  kick(): void {
    if (!this.deps.registry.hasChannels()) return;
    void this.tick().catch((err: unknown) => this.report(err));
  }

  /**
   * Starts the worker: recovers jobs a crash left `sending`, then arms the timer while channels
   * exist (and follows registry reloads). Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.offRegistry = this.deps.registry.onChange(() => this.arm());
    this.arm();
    if (this.deps.registry.hasChannels()) {
      void this.recover()
        .then(() => this.tick())
        .catch((err: unknown) => this.report(err));
    }
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.offRegistry?.();
    this.offRegistry = undefined;
    this.cancel?.();
    this.cancel = undefined;
    this.started = false;
  }

  /**
   * Crash recovery: jobs left `sending` become `retrying`, due now. A `send` the platform had
   * already accepted is therefore repeated (at least once, D-34).
   *
   * @returns The number of jobs recovered.
   */
  async recover(): Promise<number> {
    const n = await this.deps.repos.notificationDeliveries.recoverSending(this.deps.clock.now());
    if (n > 0) this.log.warn('deliveries recovered', { count: n });
    return n;
  }

  /**
   * One pass: TTL sweep, backlog collapse, then up to `batchSize` due jobs, oldest first. A call
   * while a pass runs joins it and makes it loop once more, so the returned promise always covers
   * work enqueued before the call.
   *
   * @returns The pass summary.
   */
  tick(): Promise<OutboxPass> {
    if (this.current !== undefined) {
      this.again = true;
      return this.current;
    }
    const run = this.pass().finally(() => {
      this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async pass(): Promise<OutboxPass> {
    let processed = 0;
    let deletesEnqueued = 0;
    let collapsed = 0;
    do {
      this.again = false;
      if (!this.deps.registry.hasChannels()) break;
      const now = this.deps.clock.now();
      deletesEnqueued += await this.sweepTtl(now);
      collapsed += await this.collapseBacklog(now);
      const jobs = await this.deps.repos.notificationDeliveries.due(now, this.opts.batchSize);
      for (const job of jobs) {
        try {
          await this.process(job);
        } catch (err) {
          this.log.error('delivery job failed', { seq: job.seq, err: serializeError(err) });
        }
        processed++;
      }
    } while (this.again);
    return { processed, deletesEnqueued, collapsed };
  }

  private arm(): void {
    const want = this.started && this.deps.registry.hasChannels();
    if (want && this.cancel === undefined) {
      this.cancel = (this.deps.scheduler ?? realIntervalScheduler).setInterval(() => {
        void this.tick().catch((err: unknown) => this.report(err));
      }, this.opts.tickMs);
    } else if (!want && this.cancel !== undefined) {
      this.cancel();
      this.cancel = undefined;
    }
  }

  private report(err: unknown): void {
    this.log.error('outbox pass failed', { err: serializeError(err) });
  }

  /** Enqueues a `delete` for every message whose TTL is due (D-35). */
  private async sweepTtl(now: number): Promise<number> {
    const due = await this.deps.repos.notificationChannelMessages.dueForDelete(
      now,
      this.opts.batchSize,
    );
    const rows: NewNotificationDelivery[] = due
      .filter((m) => this.deps.registry.get(m.channelId) !== undefined)
      .map((m) => ({
        channelId: m.channelId,
        notificationId: m.notificationId,
        revision: m.lastRevision,
        op: 'delete',
        status: 'pending',
        reason: null,
        nextAttemptAt: now,
        createdAt: now,
      }));
    if (rows.length === 0) return 0;
    const n = await this.deps.uow.transaction((r) => r.notificationDeliveries.enqueue(rows));
    for (const row of rows) this.changed(row.channelId, row.notificationId);
    return n;
  }

  /** More than `backlogThreshold` pending `info` sends on a channel collapse into the newest. */
  private async collapseBacklog(now: number): Promise<number> {
    let collapsed = 0;
    for (const { record } of this.deps.registry.channels()) {
      if (record.status !== 'active') continue;
      const pending = await this.deps.repos.notificationDeliveries.pendingInfoSends(
        record.channelId,
      );
      if (pending.length <= this.opts.backlogThreshold) continue;
      const newest = pending[pending.length - 1];
      if (newest === undefined) continue;
      const older = pending.slice(0, -1);
      await this.deps.uow.transaction(async (r) => {
        for (const job of older) {
          await r.notificationDeliveries.finish(job.seq, {
            status: 'superseded',
            reason: 'collapsed',
            updatedAt: now,
          });
        }
        await r.notificationDeliveries.annotate(
          newest.seq,
          `${BACKLOG_PREFIX}${older.length}`,
          now,
        );
      });
      for (const _ of older) this.count(record.kind, 'superseded');
      collapsed += older.length;
      this.log.info('backlog collapsed', { channel: record.name, count: older.length });
    }
    return collapsed;
  }

  private count(kind: string, status: string): void {
    this.deps.counter?.add(1, { channel_kind: kind, status });
  }

  private changed(channelId: string, notificationId: string): void {
    try {
      this.deps.onDeliveryChange?.(channelId, notificationId);
    } catch (err) {
      this.report(err);
    }
  }

  /** Writes a decision made without a platform call. */
  private async settle(
    job: NotificationDeliveryRecord,
    entry: RegisteredChannel | undefined,
    status: 'superseded' | 'suppressed' | 'dead',
    reason: string,
  ): Promise<void> {
    await this.deps.repos.notificationDeliveries.finish(job.seq, {
      status,
      reason,
      updatedAt: this.deps.clock.now(),
    });
    this.count(entry?.record.kind ?? 'unknown', status);
    this.changed(job.channelId, job.notificationId);
  }

  private async process(job: NotificationDeliveryRecord): Promise<void> {
    const entry = this.deps.registry.get(job.channelId);
    if (entry === undefined) return this.settle(job, entry, 'superseded', 'channel_gone');
    if (entry.record.status !== 'active') {
      return this.settle(job, entry, 'suppressed', 'channel_paused');
    }
    const adapter = entry.adapter;
    if (adapter === null) return this.settle(job, entry, 'suppressed', 'no_adapter');
    const cm = await this.deps.repos.notificationChannelMessages.get(
      job.channelId,
      job.notificationId,
    );
    if (job.op === 'delete') return this.processDelete(job, entry, adapter, cm);
    const row = await this.deps.repos.notifications.get(job.notificationId);
    const message = row === null ? null : decodeMessage(row.messageJson);
    if (message === null) return this.settle(job, entry, 'superseded', 'no_message');
    const now = this.deps.clock.now();
    if (job.op === 'edit') {
      if (cm === null) return this.settle(job, entry, 'superseded', 'not_sent');
      if (cm.deletedAt !== null) return this.settle(job, entry, 'superseded', 'message_deleted');
      if (cm.lastRevision >= message.revision)
        return this.settle(job, entry, 'superseded', 'covered');
      if (!entry.capabilities?.edit || adapter.edit === undefined) {
        return this.settle(job, entry, 'suppressed', 'edit_unsupported');
      }
      const earliest = cm.updatedAt + this.opts.editSpacingMs;
      if (now < earliest) {
        await this.deps.repos.notificationDeliveries.reschedule(job.seq, earliest, now);
        return;
      }
    } else if (cm !== null && cm.deletedAt === null && cm.lastRevision >= message.revision) {
      return this.settle(job, entry, 'superseded', 'covered');
    }
    if (!(await this.deps.repos.notificationDeliveries.claim(job.seq, now))) return;
    this.changed(job.channelId, job.notificationId);
    await this.deps.repos.notificationDeliveries.supersede(
      job.channelId,
      job.notificationId,
      message.revision,
      now,
      'covered',
      job.seq,
    );
    const shaped = await this.delivery(job, entry, message);
    const started = this.deps.clock.now();
    try {
      const delivery = await this.withTokens(entry, shaped, started);
      const result = await this.call(entry, job, message.revision, () =>
        job.op === 'edit' && cm !== null && adapter.edit !== undefined
          ? adapter.edit(cm.messageRef, delivery)
          : adapter.send(delivery),
      );
      await this.delivered(job, entry, message, cm, result, started);
    } catch (err) {
      await this.failed(job, entry, err, started, cm);
    }
  }

  /** The message as this channel may show it: content level, backlog note, degrade. */
  private async delivery(
    job: NotificationDeliveryRecord,
    entry: RegisteredChannel,
    message: NotificationMessage,
  ): Promise<ChannelDelivery> {
    let shown = applyImageRule(
      restrictContent(message, contentLevelOf(entry.record.rules)),
      entry.record.rules,
    );
    const missed = job.reason?.startsWith(BACKLOG_PREFIX)
      ? Number(job.reason.slice(BACKLOG_PREFIX.length))
      : 0;
    if (missed > 0) {
      shown = {
        ...shown,
        blocks: [
          ...shown.blocks,
          {
            type: 'footer',
            content: [
              text(
                `You missed ${missed} earlier notification${missed === 1 ? '' : 's'} while delivery was behind.`,
              ),
            ],
          },
        ],
      };
    }
    const capabilities = entry.capabilities;
    const degraded = capabilities === null ? shown : degrade(shown, capabilities);
    let replyTo: PlatformMessageRef | null = null;
    if (job.op === 'send' && capabilities?.replies === true) {
      const first = await this.deps.repos.notificationChannelMessages.firstInThread(
        job.channelId,
        message.thread,
      );
      if (first !== null && first.notificationId !== job.notificationId && first.deletedAt === null)
        replyTo = first.messageRef;
    }
    return { message: degraded, links: this.deps.links, replyTo };
  }

  /**
   * Adds the act buttons' command tokens when the channel receives presses and the (degraded)
   * message still carries act actions. The tokens are stored before the platform call.
   */
  private async withTokens(
    entry: RegisteredChannel,
    delivery: ChannelDelivery,
    now: number,
  ): Promise<ChannelDelivery> {
    const mint = this.deps.actions;
    if (mint === undefined || entry.adapter?.presses === undefined) return delivery;
    if (!delivery.message.actions.some((a) => a.kind === 'act')) return delivery;
    const actTokens = await mint.mint(entry.record.channelId, delivery.message, now);
    return { ...delivery, actTokens };
  }

  /** One platform call inside a `notification.deliver` span. */
  private call<T>(
    entry: RegisteredChannel,
    job: NotificationDeliveryRecord,
    revision: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      'notification.deliver',
      {
        attributes: {
          'browserhive.channel_kind': entry.record.kind,
          'browserhive.channel_id': entry.record.channelId,
          'browserhive.notification_id': job.notificationId,
          'browserhive.revision': revision,
          'browserhive.op': job.op,
          'browserhive.attempt': job.attempts + 1,
        },
      },
      async (span) => {
        try {
          const out = await fn();
          span.setAttribute('browserhive.status', 'sent');
          return out;
        } catch (err) {
          const code = err instanceof ChannelSendError ? err.code : 'unavailable';
          span.setAttribute('browserhive.status', 'failed');
          span.setAttribute('browserhive.error_code', code);
          span.setStatus({ code: SpanStatusCode.ERROR, message: code });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async delivered(
    job: NotificationDeliveryRecord,
    entry: RegisteredChannel,
    message: NotificationMessage,
    previous: NotificationChannelMessageRecord | null,
    result: ChannelSendResult,
    started: number,
  ): Promise<void> {
    const done = this.deps.clock.now();
    const rules = entry.record.rules;
    const edit = job.op === 'edit' && previous !== null;
    let expiresAt = edit ? previous.expiresAt : expiryFor(rules, message, done);
    if (deleteWhenResolved(rules, message)) expiresAt = done;
    await this.deps.uow.transaction(async (r) => {
      await r.notificationDeliveries.finish(job.seq, {
        status: 'sent',
        reason: null,
        lastError: null,
        durationMs: Math.max(0, done - started),
        messageRef: result.ref,
        updatedAt: done,
      });
      await r.notificationChannelMessages.upsert({
        channelId: job.channelId,
        notificationId: job.notificationId,
        thread: message.thread,
        messageRef: result.ref,
        lastRevision: message.revision,
        sentAt: edit ? previous.sentAt : done,
        updatedAt: done,
        expiresAt,
        deletedAt: null,
      });
      await r.notificationChannels.recordSuccess(job.channelId, done);
    });
    this.deps.registry.setCachedStatus(job.channelId, entry.record.status, 0);
    this.count(entry.record.kind, 'sent');
    this.changed(job.channelId, job.notificationId);
  }

  private classify(err: unknown): Classified {
    if (err instanceof ChannelSendError) {
      return {
        code: err.code,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs,
        detail: `${err.code}: ${err.message}`,
      };
    }
    return {
      code: 'unavailable',
      retryable: true,
      retryAfterMs: null,
      detail: `unavailable: ${serializeError(err).message}`,
    };
  }

  /** Backoff before the next attempt: the platform's wait, else exponential with jitter. */
  private backoff(attempts: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.max(0, retryAfterMs);
    const raw = Math.min(
      this.opts.maxBackoffMs,
      this.opts.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
    );
    const draw = this.deps.jitter?.() ?? 0.5;
    return Math.max(0, Math.round(raw * (1 + this.opts.jitterRatio * (2 * draw - 1))));
  }

  private scrub(detail: string): string {
    const scrubbed = this.deps.redactor?.scrubText(detail) ?? detail;
    return clip(scrubbed, ERROR_MAX);
  }

  private async failed(
    job: NotificationDeliveryRecord,
    entry: RegisteredChannel,
    err: unknown,
    started: number,
    cm: NotificationChannelMessageRecord | null,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const e = this.classify(err);
    const detail = this.scrub(e.detail);
    const durationMs = Math.max(0, now - started);
    if (e.code === 'message_gone') {
      // Deleted in the chat: not a health failure. Later revisions have nothing to edit.
      await this.deps.uow.transaction(async (r) => {
        await r.notificationDeliveries.finish(job.seq, {
          status: 'superseded',
          reason: 'message_gone',
          lastError: detail,
          durationMs,
          updatedAt: now,
        });
        if (cm !== null)
          await r.notificationChannelMessages.markDeleted(job.channelId, job.notificationId, now);
      });
      this.count(entry.record.kind, 'superseded');
      this.changed(job.channelId, job.notificationId);
      return;
    }
    const attempts = job.attempts + 1;
    const patch: DeliveryFinishPatch = ((): DeliveryFinishPatch => {
      const base = { lastError: detail, durationMs, updatedAt: now };
      if (e.code === 'too_old')
        return { ...base, status: 'dead', reason: 'could_not_delete: too_old' };
      if (!e.retryable) return { ...base, status: 'dead', reason: e.code };
      if (attempts >= this.opts.maxAttempts)
        return { ...base, status: 'dead', reason: 'max_attempts' };
      if (now - job.createdAt >= this.opts.maxAgeMs)
        return { ...base, status: 'dead', reason: 'expired' };
      return {
        ...base,
        status: 'retrying',
        reason: e.code,
        nextAttemptAt: now + this.backoff(attempts, e.retryAfterMs),
      };
    })();
    const health = e.code !== 'too_old';
    const failures = await this.deps.uow.transaction(async (r) => {
      await r.notificationDeliveries.finish(job.seq, patch);
      return health ? r.notificationChannels.recordFailure(job.channelId, now, detail) : 0;
    });
    this.count(entry.record.kind, patch.status);
    this.changed(job.channelId, job.notificationId);
    this.log.warn('delivery failed', {
      channel: entry.record.name,
      seq: job.seq,
      op: job.op,
      status: patch.status,
      code: e.code,
    });
    if (health && failures >= this.opts.breakerThreshold && entry.record.status === 'active') {
      await this.breakChannel(entry, failures, detail, now);
    } else if (health) {
      this.deps.registry.setCachedStatus(job.channelId, entry.record.status, failures);
    }
  }

  /**
   * Opens the breaker: the channel becomes `broken`, its pending jobs are suppressed, and
   * `notification.channel.changed` produces the in-app-only `channel.broken` notification. Never a
   * system degradation: that would be delivered through this channel again (D-34).
   */
  private async breakChannel(
    entry: RegisteredChannel,
    failures: number,
    detail: string,
    now: number,
  ): Promise<void> {
    const channelId = entry.record.channelId;
    const suppressed = await this.deps.uow.transaction(async (r) => {
      await r.notificationChannels.setStatus(channelId, 'broken', now);
      return r.notificationDeliveries.suppressChannel(channelId, 'channel_paused', now);
    });
    this.deps.registry.setCachedStatus(channelId, 'broken', failures);
    for (let i = 0; i < suppressed; i++) this.count(entry.record.kind, 'suppressed');
    this.log.warn('channel breaker opened', { channel: entry.record.name, failures });
    this.deps.bus?.publish('notification.channel.changed', {
      type: 'notification.channel.changed',
      channel_id: channelId,
      name: entry.record.name,
      kind: entry.record.kind,
      status: 'broken',
      previous_status: 'active',
      failure_count: failures,
      last_error: detail,
      at: now,
    });
  }

  private async processDelete(
    job: NotificationDeliveryRecord,
    entry: RegisteredChannel,
    adapter: NotificationChannel,
    cm: NotificationChannelMessageRecord | null,
  ): Promise<void> {
    if (cm === null || cm.deletedAt !== null) {
      return this.settle(job, entry, 'superseded', 'message_deleted');
    }
    const caps = entry.capabilities;
    if (caps === null || !caps.delete || adapter.delete === undefined) {
      return this.settle(job, entry, 'suppressed', 'delete_unsupported');
    }
    const now = this.deps.clock.now();
    if (caps.deleteWindowMs !== null && now - cm.sentAt > caps.deleteWindowMs) {
      this.log.warn('message too old to delete', { channel: entry.record.name, seq: job.seq });
      return this.settle(job, entry, 'dead', 'could_not_delete: too_old');
    }
    if (!(await this.deps.repos.notificationDeliveries.claim(job.seq, now))) return;
    this.changed(job.channelId, job.notificationId);
    const remove = adapter.delete.bind(adapter);
    const started = this.deps.clock.now();
    try {
      await this.call(entry, job, cm.lastRevision, () => remove(cm.messageRef));
      const done = this.deps.clock.now();
      await this.deps.uow.transaction(async (r) => {
        await r.notificationDeliveries.finish(job.seq, {
          status: 'sent',
          reason: null,
          lastError: null,
          durationMs: Math.max(0, done - started),
          messageRef: cm.messageRef,
          updatedAt: done,
        });
        await r.notificationChannelMessages.markDeleted(job.channelId, job.notificationId, done);
        await r.notificationChannels.recordSuccess(job.channelId, done);
      });
      if (cm.expiresAt !== null && done - cm.expiresAt > this.opts.lateDeleteMs) {
        this.log.info('late message delete', {
          channel: entry.record.name,
          late_ms: done - cm.expiresAt,
        });
      }
      this.count(entry.record.kind, 'sent');
      this.changed(job.channelId, job.notificationId);
    } catch (err) {
      await this.failed(job, entry, err, started, cm);
    }
  }
}
