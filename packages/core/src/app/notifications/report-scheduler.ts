/** @module app/notifications/report-scheduler — the scheduled reports (D-43, D-44, spec 03 §9.7): a 60 s tick while any channel schedules a digest or anomaly alerts; per channel, the durable cursor in `notification_cursors`, the newest missed window sent late once with the skipped count, empty digests stored `suppressed: empty`, the hourly anomaly check with hysteresis; each report an addressed notification written with its delivery row and its cursor in one transaction. */

import type { ChannelReports } from '@browserhive/contracts/http';
import {
  ANOMALY_CHECKS,
  type AnomalyCheck,
  type DigestRule,
  KIND_CATEGORY,
  KIND_TYPE,
  type NotificationChannelRules,
  type NotificationMessage,
} from '@browserhive/contracts/notifications';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { createRedactor, type Redactor } from '../../kernel/redact.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { NotificationCursorRepository } from '../../ports/persistence/notification-actions.ts';
import type {
  NewNotificationDelivery,
  NotificationChannelRecord,
  NotificationRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import { type IntervalScheduler, realIntervalScheduler } from '../maintenance/timer.ts';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.ts';
import { scrubMessage } from './message.ts';
import type { NotificationOutbox } from './outbox.ts';
import type { ReportFacts } from './report-facts.ts';
import {
  type ActiveCheck,
  type AnomalyFacts,
  type AnomalyState,
  buildAnomaly,
  buildDigest,
  evaluateAnomalies,
  isEmptyDigest,
  type ReportContent,
  type ReportContext,
  reportMessage,
} from './reports.ts';
import { contentLevelOf, inQuietHours, quietHoursOf } from './routing.ts';
import {
  digestWindow,
  formatClock,
  nextHour,
  nextOccurrence,
  occurrencesBetween,
  periodMs,
  scheduleKey,
  usableZone,
} from './schedule.ts';

/** Tick of the scheduler while a channel schedules a report. */
export const REPORT_TICK_MS = 60_000;
/** A report produced this long after its scheduled time is late (D-43). */
export const LATE_AFTER_MS = 5 * 60_000;
const HOUR = 3_600_000;

/** Cursor key of a channel's digest schedule. */
export const digestCursorKey = (channelId: string) => `digest:${channelId}`;
/** Cursor key of a channel's anomaly state. */
export const anomalyCursorKey = (channelId: string) => `anomaly:${channelId}`;

/**
 * Every cursor a channel owns (its ntfy reply subscription, its digest schedule, its anomaly
 * state): removed with the channel.
 *
 * @returns The keys.
 */
export function channelCursorKeys(channelId: string): readonly string[] {
  return [`ntfy:${channelId}`, digestCursorKey(channelId), anomalyCursorKey(channelId)];
}

/** Removes every cursor of a channel (a delete, or a startup channel no longer declared). */
export async function forgetChannelCursors(
  cursors: NotificationCursorRepository,
  channelId: string,
): Promise<void> {
  for (const key of channelCursorKeys(channelId)) await cursors.remove(key);
}

/** Where a digest schedule stands. */
interface DigestCursor {
  /** The rule and zone it belongs to (`scheduleKey`). */
  readonly spec: string;
  /** The last handled occurrence, or when the rule was armed. */
  readonly last: number;
  /** End of the last window reported, or `null`. */
  readonly until: number | null;
}

/** Where a channel's anomaly checks stand. */
interface AnomalyCursor {
  /** The last check. */
  readonly last: number;
  readonly active: AnomalyState;
  /** The open alert, or `null`. */
  readonly notificationId: string | null;
}

/** Counter of report decisions (spec 10 §7). */
export interface ReportCounter {
  add(value: number, attributes: { readonly kind: string; readonly outcome: string }): void;
}

/** Dependencies of {@link ReportScheduler}. */
export interface ReportSchedulerDeps {
  readonly registry: ChannelRegistry;
  readonly facts: ReportFacts;
  readonly uow: UnitOfWork;
  readonly repos: Pick<Repositories, 'notificationCursors' | 'notifications'>;
  readonly outbox: Pick<NotificationOutbox, 'plan' | 'kick'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** The host's IANA zone, read at each evaluation (composition: the runtime's default zone). */
  readonly hostZone: () => string;
  readonly redactor?: Redactor;
  readonly scheduler?: IntervalScheduler;
  readonly counter?: ReportCounter;
  /** Called after a report's delivery rows were written (the live delivery log). */
  readonly onDeliveryChange?: (notificationId: string) => void;
  readonly tickMs?: number;
}

/** Summary of one tick (tests, logs). */
export interface ReportPass {
  readonly digests: number;
  readonly anomalies: number;
}

/** A report built for a channel, ready to store or send. */
export interface BuiltReport {
  readonly message: NotificationMessage;
  readonly record: NotificationRecord;
  readonly window: { readonly since: number; readonly until: number };
  readonly empty: boolean;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readDigestCursor(raw: string | null): DigestCursor | null {
  const v = parseJson<{ spec?: unknown; last?: unknown; until?: unknown }>(raw);
  if (v === null || typeof v.spec !== 'string' || typeof v.last !== 'number') return null;
  return { spec: v.spec, last: v.last, until: typeof v.until === 'number' ? v.until : null };
}

function readAnomalyCursor(raw: string | null): AnomalyCursor | null {
  const v = parseJson<{ last?: unknown; active?: unknown; notification_id?: unknown }>(raw);
  if (v === null || typeof v.last !== 'number') return null;
  const active: Partial<Record<AnomalyCheck, ActiveCheck>> = {};
  if (v.active !== null && typeof v.active === 'object') {
    for (const check of ANOMALY_CHECKS) {
      const a = (v.active as Record<string, unknown>)[check] as Partial<ActiveCheck> | undefined;
      if (
        a !== undefined &&
        typeof a.since === 'number' &&
        typeof a.value === 'number' &&
        typeof a.threshold === 'number'
      ) {
        active[check] = { since: a.since, value: a.value, threshold: a.threshold };
      }
    }
  }
  return {
    last: v.last,
    active,
    notificationId: typeof v.notification_id === 'string' ? v.notification_id : null,
  };
}

function writeAnomalyCursor(c: AnomalyCursor): string {
  return JSON.stringify({ last: c.last, active: c.active, notification_id: c.notificationId });
}

/**
 * Produces the scheduled reports. `tick()` is idempotent and serialised: a call while a pass runs
 * returns that pass. With no channel scheduling a report no timer is armed (D-43).
 */
export class ReportScheduler {
  private readonly log: Logger;
  private readonly redactor: Redactor;
  private cancel: (() => void) | undefined;
  private offRegistry: (() => void) | undefined;
  private started = false;
  private current: Promise<ReportPass> | undefined;
  private readonly digestCache = new Map<string, DigestCursor>();
  private readonly anomalyCache = new Map<string, AnomalyCursor>();

  constructor(private readonly deps: ReportSchedulerDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
    this.redactor = deps.redactor ?? createRedactor();
  }

  /** Arms the timer while a channel schedules a report, follows reloads, and catches up now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.offRegistry = this.deps.registry.onChange(() => this.arm());
    this.arm();
    if (this.wanted()) void this.tick().catch((err: unknown) => this.report(err));
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.offRegistry?.();
    this.offRegistry = undefined;
    this.cancel?.();
    this.cancel = undefined;
    this.started = false;
  }

  private scheduled(): RegisteredChannel[] {
    return this.deps.registry
      .channels()
      .filter((c) => c.record.rules.digest !== undefined || c.record.rules.anomaly !== undefined);
  }

  private wanted(): boolean {
    return this.scheduled().length > 0;
  }

  private arm(): void {
    const want = this.started && this.wanted();
    if (want && this.cancel === undefined) {
      this.cancel = (this.deps.scheduler ?? realIntervalScheduler).setInterval(() => {
        void this.tick().catch((err: unknown) => this.report(err));
      }, this.deps.tickMs ?? REPORT_TICK_MS);
    } else if (!want && this.cancel !== undefined) {
      this.cancel();
      this.cancel = undefined;
    }
  }

  private report(err: unknown): void {
    this.log.error('report tick failed', { err: serializeError(err) });
  }

  /** The zone a channel's reports use. */
  zoneOf(rules: NotificationChannelRules): string {
    const host = this.hostZone();
    return usableZone(rules.time_zone, host);
  }

  private hostZone(): string {
    return usableZone(this.deps.hostZone(), 'UTC');
  }

  /**
   * One pass over every scheduling channel: due digests, then the anomaly check when due.
   *
   * @returns How many digests and anomaly decisions were written.
   */
  tick(): Promise<ReportPass> {
    if (this.current !== undefined) return this.current;
    const run = this.pass().finally(() => {
      this.current = undefined;
    });
    this.current = run;
    return run;
  }

  private async pass(): Promise<ReportPass> {
    const now = this.deps.clock.now();
    let digests = 0;
    let anomalies = 0;
    let anomalyFacts: Promise<AnomalyFacts> | undefined;
    for (const entry of this.scheduled()) {
      const rules = entry.record.rules;
      try {
        if (rules.digest !== undefined && (await this.digestTick(entry, rules.digest, now))) {
          digests++;
        }
      } catch (err) {
        this.log.error('digest failed', { channel: entry.record.name, err: serializeError(err) });
      }
      try {
        if (rules.anomaly !== undefined) {
          const facts = () => {
            anomalyFacts ??= this.deps.facts.anomaly(now);
            return anomalyFacts;
          };
          if (await this.anomalyTick(entry, now, facts)) anomalies++;
        }
      } catch (err) {
        this.log.error('anomaly check failed', {
          channel: entry.record.name,
          err: serializeError(err),
        });
      }
    }
    return { digests, anomalies };
  }

  // -----------------------------------------------------------------------------------------------
  // Digests
  // -----------------------------------------------------------------------------------------------

  private async digestCursor(channelId: string): Promise<DigestCursor | null> {
    const cached = this.digestCache.get(channelId);
    if (cached !== undefined) return cached;
    const read = readDigestCursor(
      await this.deps.repos.notificationCursors.get(digestCursorKey(channelId)),
    );
    if (read !== null) this.digestCache.set(channelId, read);
    return read;
  }

  /** Handles a channel's due digest; `true` when one was produced. */
  private async digestTick(entry: RegisteredChannel, rule: DigestRule, now: number) {
    const record = entry.record;
    const zone = this.zoneOf(record.rules);
    const spec = scheduleKey(rule, zone);
    const cursor = await this.digestCursor(record.channelId);
    if (cursor === null || cursor.spec !== spec) {
      // A new schedule (or a changed one) arms from now: an edit never causes a late digest.
      const armed: DigestCursor = { spec, last: now, until: cursor?.until ?? null };
      await this.deps.repos.notificationCursors.set(
        digestCursorKey(record.channelId),
        JSON.stringify(armed),
        now,
      );
      this.digestCache.set(record.channelId, armed);
      return false;
    }
    const due = occurrencesBetween(rule, zone, cursor.last, now);
    const newest = due.at[due.at.length - 1];
    if (newest === undefined) return false;
    const skipped = due.at.length - 1 + due.older;
    const late = now - newest > LATE_AFTER_MS;
    const window = digestWindow(rule, zone, newest, cursor.until);
    const quietHours = quietHoursOf(record.rules);
    const built = await this.buildDigestFor(record, rule, window, now, {
      zone,
      level: contentLevelOf(record.rules),
      scheduledAt: newest,
      late,
      skipped,
      manual: false,
      quiet: quietHours !== null && inQuietHours(newest, quietHours),
    });
    const next: DigestCursor = { spec, last: newest, until: window.until };
    let jobs = this.deps.outbox.plan(built.message, now, record.channelId);
    if (built.empty) {
      jobs = jobs.map((j) =>
        j.status === 'pending'
          ? { ...j, status: 'suppressed', reason: 'empty', nextAttemptAt: null }
          : j,
      );
    }
    await this.write(
      built.record,
      jobs,
      digestCursorKey(record.channelId),
      JSON.stringify(next),
      now,
    );
    this.digestCache.set(record.channelId, next);
    const kind = built.message.kind;
    this.count(kind, built.empty ? 'empty' : late ? 'late' : 'sent');
    if (skipped > 0) this.count(kind, 'skipped', skipped);
    this.log.info(built.empty ? 'digest empty' : 'digest produced', {
      channel: record.name,
      late,
      skipped,
    });
    return true;
  }

  /**
   * The digest of a window for a channel, sealed (redacted, validated) with a fresh notification
   * id and its in-app row (read and dismissed: reports are channel-only, D-43).
   *
   * @returns The report.
   */
  async buildDigestFor(
    record: NotificationChannelRecord,
    rule: DigestRule,
    window: { readonly since: number; readonly until: number },
    now: number,
    ctx: ReportContext,
  ): Promise<BuiltReport> {
    const facts = await this.deps.facts.digest(window, rule);
    const content = buildDigest(facts, rule, ctx);
    const thread = `digest:${record.channelId}:${window.until}`;
    const built = this.seal(this.messageOf(content, thread, now, 1, ctx.level, null));
    return {
      message: built,
      record: this.recordOf(built, content.target, now),
      window,
      empty: isEmptyDigest(facts),
    };
  }

  /**
   * The on-demand digest of a channel: the period that ends now (a day, or a week), never late and
   * never suppressed as empty; the schedule and its cursor are untouched.
   *
   * @returns The report, or `null` when the channel schedules no digest (a daily one is used).
   */
  async manualDigest(record: NotificationChannelRecord): Promise<BuiltReport> {
    const now = this.deps.clock.now();
    const rule: DigestRule = record.rules.digest ?? { every: 'day', at: '09:00' };
    const window = { since: now - periodMs(rule), until: now };
    return this.buildDigestFor(record, rule, window, now, {
      zone: this.zoneOf(record.rules),
      level: contentLevelOf(record.rules),
      scheduledAt: now,
      late: false,
      skipped: 0,
      manual: true,
      quiet: false,
    });
  }

  // -----------------------------------------------------------------------------------------------
  // Anomaly checks
  // -----------------------------------------------------------------------------------------------

  private async anomalyCursor(channelId: string): Promise<AnomalyCursor | null> {
    const cached = this.anomalyCache.get(channelId);
    if (cached !== undefined) return cached;
    const read = readAnomalyCursor(
      await this.deps.repos.notificationCursors.get(anomalyCursorKey(channelId)),
    );
    if (read !== null) this.anomalyCache.set(channelId, read);
    return read;
  }

  /** Runs a channel's check when due; `true` when a notification was written or revised. */
  private async anomalyTick(
    entry: RegisteredChannel,
    now: number,
    factsOf: () => Promise<AnomalyFacts>,
  ): Promise<boolean> {
    const record = entry.record;
    const rule = record.rules.anomaly;
    if (rule === undefined) return false;
    const cursor = await this.anomalyCursor(record.channelId);
    const slot = Math.floor(now / HOUR) * HOUR;
    if (cursor !== null && cursor.last >= slot) return false;
    const quiet = quietHoursOf(record.rules);
    // During quiet hours no check runs and `last` stays: the first tick after them checks.
    if (quiet !== null && inQuietHours(now, quiet)) return false;
    const facts = await factsOf();
    const previous: AnomalyState = cursor?.active ?? {};
    const evaluation = evaluateAnomalies(facts, rule, previous, now);
    const zone = this.zoneOf(record.rules);
    const ctx: ReportContext = {
      zone,
      level: contentLevelOf(record.rules),
      scheduledAt: now,
      late: false,
      skipped: 0,
      manual: false,
      quiet: false,
    };
    const key = anomalyCursorKey(record.channelId);
    const openId = cursor?.notificationId ?? null;
    const activeNow = Object.keys(evaluation.active).length > 0;
    if (evaluation.fired.length > 0) {
      const content = buildAnomaly(
        { facts, active: evaluation.active, fired: evaluation.fired },
        ctx,
      );
      const message = this.seal(
        this.messageOf(content, `anomaly:${record.channelId}`, now, 1, ctx.level, null),
      );
      const row = this.recordOf(message, content.target, now);
      const next: AnomalyCursor = {
        last: now,
        active: evaluation.active,
        notificationId: message.id,
      };
      const jobs = this.deps.outbox.plan(message, now, record.channelId);
      const superseded =
        openId === null
          ? null
          : await this.revision(openId, now, (prev) => ({
              ...prev,
              state: 'final',
              alert: false,
              summary: `Superseded by the report of ${formatClock(now, zone)}.`,
              actions: [],
            }));
      await this.write(
        row,
        jobs,
        key,
        writeAnomalyCursor(next),
        now,
        superseded ?? undefined,
        record.channelId,
      );
      this.anomalyCache.set(record.channelId, next);
      this.count('report.anomaly', 'sent');
      this.log.info('anomaly alert', { channel: record.name, fired: evaluation.fired.length });
      return true;
    }
    if (!activeNow && evaluation.cleared.length > 0 && openId !== null) {
      const began = Math.min(...Object.values(previous).map((a) => a?.since ?? now), now);
      const content = buildAnomaly({ facts, active: {}, fired: [], resolvedSince: began }, ctx);
      const revised = await this.revision(openId, now, (prev) =>
        this.messageOf(content, prev.thread, now, prev.revision + 1, ctx.level, prev),
      );
      const next: AnomalyCursor = { last: now, active: {}, notificationId: null };
      await this.write(
        null,
        [],
        key,
        writeAnomalyCursor(next),
        now,
        revised ?? undefined,
        record.channelId,
      );
      this.anomalyCache.set(record.channelId, next);
      this.count('report.anomaly', 'resolved');
      this.log.info('anomaly cleared', { channel: record.name });
      return true;
    }
    if (activeNow && evaluation.cleared.length > 0 && openId !== null) {
      const content = buildAnomaly({ facts, active: evaluation.active, fired: [] }, ctx);
      const revised = await this.revision(openId, now, (prev) =>
        this.messageOf(content, prev.thread, now, prev.revision + 1, ctx.level, prev),
      );
      const next: AnomalyCursor = { last: now, active: evaluation.active, notificationId: openId };
      await this.write(
        null,
        [],
        key,
        writeAnomalyCursor(next),
        now,
        revised ?? undefined,
        record.channelId,
      );
      this.anomalyCache.set(record.channelId, next);
      return true;
    }
    const next: AnomalyCursor = {
      last: now,
      active: evaluation.active,
      notificationId: activeNow ? openId : null,
    };
    await this.deps.repos.notificationCursors.set(key, writeAnomalyCursor(next), now);
    this.anomalyCache.set(record.channelId, next);
    return false;
  }

  /** A revision of a stored report notification, or `null` when it is gone. */
  private async revision(
    notificationId: string,
    now: number,
    change: (prev: NotificationMessage) => NotificationMessage,
  ): Promise<{ record: NotificationRecord; message: NotificationMessage } | null> {
    const row = await this.deps.repos.notifications.get(notificationId);
    if (row === null || row.messageJson === null) return null;
    let prev: NotificationMessage;
    try {
      prev = JSON.parse(row.messageJson) as NotificationMessage;
    } catch {
      return null;
    }
    const next = change(prev);
    const message = this.seal({
      ...next,
      id: prev.id,
      thread: prev.thread,
      revision: prev.revision + 1,
      alert: false,
      at: { created: prev.at.created, updated: Math.max(now, prev.at.updated) },
    });
    return {
      record: {
        ...row,
        state: message.state,
        severity: message.severity,
        revision: message.revision,
      },
      message,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Shared
  // -----------------------------------------------------------------------------------------------

  private messageOf(
    content: ReportContent,
    thread: string,
    now: number,
    revision: number,
    level: NotificationMessage['privacy']['level'],
    prev: NotificationMessage | null,
  ): NotificationMessage {
    return reportMessage(content, {
      id: prev?.id ?? `n-${this.deps.ids.opaque(12)}`,
      thread,
      revision,
      createdAt: prev?.at.created ?? now,
      updatedAt: now,
      level,
    });
  }

  /** Redacts and validates; a message that still fails loses its blocks rather than the report. */
  private seal(message: NotificationMessage): NotificationMessage {
    try {
      return scrubMessage(message, this.redactor);
    } catch (err) {
      this.log.error('report build failed', { kind: message.kind, err: serializeError(err) });
      return scrubMessage({ ...message, blocks: [], actions: [] }, this.redactor);
    }
  }

  private recordOf(message: NotificationMessage, target: string, now: number): NotificationRecord {
    return {
      notificationId: message.id,
      principalId: null,
      type: KIND_TYPE[message.kind],
      title: message.title,
      body: message.summary,
      sessionId: null,
      target,
      sourceEventId: null,
      createdAt: now,
      updatedAt: now,
      count: 1,
      groupKey: null,
      readAt: now,
      dismissedAt: now,
      kind: message.kind,
      category: KIND_CATEGORY[message.kind],
      severity: message.severity,
      state: message.state,
      revision: message.revision,
      thread: message.thread,
      messageJson: JSON.stringify(message),
    };
  }

  /**
   * Writes a new report row (or none), a revision of an earlier one (or none), their delivery rows
   * and the cursor in one transaction, then wakes the outbox.
   */
  private async write(
    row: NotificationRecord | null,
    jobs: readonly NewNotificationDelivery[],
    cursorKey: string,
    cursorValue: string,
    now: number,
    revised?: { record: NotificationRecord; message: NotificationMessage },
    channelId?: string,
  ): Promise<void> {
    const revisionJobs =
      revised === undefined || channelId === undefined
        ? []
        : this.deps.outbox.plan(revised.message, now, channelId);
    await this.deps.uow.transaction(async (repos) => {
      if (revised !== undefined) {
        await repos.notifications.revise(revised.record.notificationId, {
          state: revised.message.state,
          severity: revised.message.severity,
          revision: revised.message.revision,
          messageJson: JSON.stringify(revised.message),
        });
      }
      if (row !== null) await repos.notifications.insert(row);
      const all = [...revisionJobs, ...jobs];
      if (all.length > 0) await repos.notificationDeliveries.enqueue(all);
      await repos.notificationCursors.set(cursorKey, cursorValue, now);
    });
    const touched = [
      ...(revised === undefined ? [] : [revised.record.notificationId]),
      ...(row === null ? [] : [row.notificationId]),
    ];
    for (const id of touched) {
      try {
        this.deps.onDeliveryChange?.(id);
      } catch (err) {
        this.log.warn('delivery feed failed', { err: serializeError(err) });
      }
    }
    if ([...revisionJobs, ...jobs].some((j) => j.status === 'pending')) this.deps.outbox.kick();
  }

  private count(kind: string, outcome: string, n = 1): void {
    this.deps.counter?.add(n, { kind, outcome });
  }

  /** Drops a channel's cached cursors (after its cursors were removed). */
  forget(channelId: string): void {
    this.digestCache.delete(channelId);
    this.anomalyCache.delete(channelId);
  }

  /**
   * The scheduled reports of a channel as the API shows them (`ChannelView.reports`).
   *
   * @returns The view; cursors not yet read count as "armed now".
   */
  view(record: NotificationChannelRecord): ChannelReports {
    const ac = this.anomalyCache.get(record.channelId);
    return reportsView(record, this.deps.clock.now(), this.hostZone(), {
      until: this.digestCache.get(record.channelId)?.until ?? null,
      ...(ac !== undefined && { anomaly: { last: ac.last, active: ac.active } }),
    });
  }

  /** Reads every scheduling channel's cursors into the cache (the views before the first tick). */
  async load(): Promise<void> {
    for (const entry of this.scheduled()) {
      await this.digestCursor(entry.record.channelId);
      await this.anomalyCursor(entry.record.channelId);
    }
  }
}

/**
 * The scheduled reports of a channel as the API shows them (`ChannelView.reports`), from its rules
 * and, when known, its cursors (without them: armed now, a check due now).
 *
 * @returns The view.
 */
export function reportsView(
  record: NotificationChannelRecord,
  now: number,
  hostZone: string,
  state: {
    readonly until?: number | null;
    readonly anomaly?: { readonly last: number; readonly active: AnomalyState };
  } = {},
): ChannelReports {
  const rules = record.rules;
  const zone = usableZone(rules.time_zone, usableZone(hostZone, 'UTC'));
  const digest = rules.digest;
  const ac = state.anomaly;
  return {
    time_zone: zone,
    host_zone: rules.time_zone === undefined,
    digest:
      digest === undefined
        ? null
        : {
            every: digest.every,
            at: digest.at,
            day: digest.every === 'week' ? (digest.day ?? 'mon') : null,
            next_at: nextOccurrence(digest, zone, now),
            last_until: state.until ?? null,
          },
    anomaly:
      rules.anomaly === undefined
        ? null
        : {
            next_check_at:
              ac === undefined || ac.last < Math.floor(now / HOUR) * HOUR
                ? now
                : nextHour(Math.max(now, ac.last)),
            active: ANOMALY_CHECKS.flatMap((check) => {
              const a = ac?.active[check];
              return a === undefined
                ? []
                : [{ check, since: a.since, value: a.value, threshold: a.threshold }];
            }),
          },
  };
}
