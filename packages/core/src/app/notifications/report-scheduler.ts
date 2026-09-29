/** @module app/notifications/report-scheduler — the scheduled reports (D-43, D-44, D-45, spec 03 §9.7): a 60 s tick while any channel or the in-app settings schedule a digest or anomaly alerts; per schedule, the durable cursor in `notification_cursors`, the newest missed window sent late once with the skipped count, empty digests stored `suppressed: empty`, the hourly anomaly check with hysteresis; one in-app copy per report period (shared by every schedule of that period) and one anomaly watch per set of thresholds; each report written with its delivery rows, its in-app copy and its cursor in one transaction. */

import type { ChannelReports, Notification } from '@browserhive/contracts/http';
import {
  ANOMALY_CHECKS,
  type AnomalyCheck,
  type AnomalyRule,
  type DigestRule,
  digestDay,
  KIND_CATEGORY,
  KIND_TYPE,
  type NotificationChannelRules,
  type NotificationMessage,
  type ReportSettings,
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
import type { ChannelRegistry } from './channel-registry.ts';
import { scrubMessage } from './message.ts';
import { toNotification } from './notification-service.ts';
import type { NotificationOutbox } from './outbox.ts';
import type { ReportFacts } from './report-facts.ts';
import { schedulesReports } from './report-settings.ts';
import {
  type ActiveCheck,
  type AnomalyFacts,
  type AnomalyState,
  anomalyThresholds,
  buildAnomaly,
  buildDigest,
  type DigestFacts,
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

/** Tick of the scheduler while a schedule wants a report. */
export const REPORT_TICK_MS = 60_000;
/** A report produced this long after its scheduled time is late (D-43). */
export const LATE_AFTER_MS = 5 * 60_000;
const HOUR = 3_600_000;

/** Key of the in-app schedule (D-45): its cursors are `digest:in-app` and `anomaly:in-app`. */
export const IN_APP_SCHEDULE = 'in-app';
/** Threads of in-app report copies start with this (D-45). */
export const IN_APP_REPORT_THREAD = 'report:';

/** Cursor key of a schedule's digest (a channel id, or `in-app`). */
export const digestCursorKey = (key: string) => `digest:${key}`;
/** Cursor key of a channel's anomaly state (`anomaly:in-app` holds the watches). */
export const anomalyCursorKey = (key: string) => `anomaly:${key}`;

/** Thread of the in-app copy of a scheduled digest's period: schedule identity + window (D-45). */
export function digestPeriodThread(
  spec: string,
  window: { readonly since: number; readonly until: number },
): string {
  return `${IN_APP_REPORT_THREAD}digest:${spec}:${window.since}:${window.until}`;
}

/** Thread of the in-app copy of an on-demand digest (a period of its own). */
export function manualPeriodThread(
  zone: string,
  window: { readonly since: number; readonly until: number },
): string {
  return `${IN_APP_REPORT_THREAD}digest:now:${zone}:${window.since}:${window.until}`;
}

/** Dashboard path of an in-app report copy. */
export function reportPath(notificationId: string): string {
  return `/notifications/reports/${notificationId}`;
}

/**
 * Identity of an anomaly watch: the effective thresholds of a rule (D-45), so rules that differ
 * only in how they spell a default share a watch.
 *
 * @returns A stable key.
 */
export function watchKey(rule: AnomalyRule): string {
  const t = anomalyThresholds(rule);
  return [
    t.errorRate ?? 'off',
    t.minCalls,
    t.attentionMinutes ?? 'off',
    t.blockedSpike ?? 'off',
    t.blockedMin,
    t.capacity ? 'on' : 'off',
    t.degraded ? 'on' : 'off',
  ].join('/');
}

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

/** Where a channel's (or a watch's) anomaly checks stand. */
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

/** The in-app settings as the scheduler reads them. */
export interface ReportSettingsSource {
  current(): ReportSettings;
  onChange(listener: () => void): () => void;
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
  /** The in-app reports (D-45); absent = none. */
  readonly settings?: ReportSettingsSource;
  /** Announces an in-app copy on the `notifications` topic (created, or revised). */
  readonly inbox?: (op: 'created' | 'updated', notification: Notification) => void;
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
  /** The facts it was built from (its in-app copy reuses them). */
  readonly facts: DigestFacts;
  readonly rule: DigestRule;
  readonly ctx: ReportContext;
}

/** A schedule: a channel, or the in-app settings (D-45). */
interface Schedule {
  /** Channel id, or {@link IN_APP_SCHEDULE}. */
  readonly key: string;
  readonly name: string;
  readonly rules: NotificationChannelRules;
  /** The channel; `null` for the in-app schedule. */
  readonly channel: NotificationChannelRecord | null;
}

/** An in-app copy to find by thread, or to insert (prepared outside the transaction). */
interface InAppCopy {
  readonly thread: string;
  readonly copy: { readonly record: NotificationRecord } | null;
}

/** A stored message revised (its row patch and its new message). */
interface Revised {
  readonly record: NotificationRecord;
  readonly message: NotificationMessage;
}

/** Everything one report decision writes in its transaction. */
interface WritePlan {
  /** The channel copy of a new report, or `null`. */
  readonly row?: NotificationRecord | null;
  readonly jobs?: readonly NewNotificationDelivery[];
  /** Revisions of channel copies (planned for `channelId`) or of in-app copies (no jobs). */
  readonly revised?: readonly Revised[];
  readonly channelId?: string;
  /** The period's in-app copy the new row links to (found or inserted). */
  readonly inApp?: InAppCopy | null;
  /** New in-app rows to insert as they are (anomaly watch alerts). */
  readonly inAppRows?: readonly NotificationRecord[];
  /** An in-app row the new channel row names (an anomaly watch's open alert). */
  readonly linkTo?: string | null;
  readonly cursor: { readonly key: string; readonly value: string };
  readonly now: number;
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

function anomalyCursorOf(v: {
  last?: unknown;
  active?: unknown;
  notification_id?: unknown;
}): AnomalyCursor | null {
  if (typeof v.last !== 'number') return null;
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

function readAnomalyCursor(raw: string | null): AnomalyCursor | null {
  const v = parseJson<{ last?: unknown; active?: unknown; notification_id?: unknown }>(raw);
  return v === null ? null : anomalyCursorOf(v);
}

function anomalyCursorJson(c: AnomalyCursor) {
  return { last: c.last, active: c.active, notification_id: c.notificationId };
}

function writeAnomalyCursor(c: AnomalyCursor): string {
  return JSON.stringify(anomalyCursorJson(c));
}

function readWatches(raw: string | null): Map<string, AnomalyCursor> {
  const v = parseJson<{ watches?: unknown }>(raw);
  const out = new Map<string, AnomalyCursor>();
  if (v === null || v.watches === null || typeof v.watches !== 'object') return out;
  for (const [key, value] of Object.entries(v.watches as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const c = anomalyCursorOf(value as Record<string, unknown>);
    if (c !== null) out.set(key, c);
  }
  return out;
}

function writeWatches(watches: ReadonlyMap<string, AnomalyCursor>): string {
  const out: Record<string, unknown> = {};
  for (const [key, c] of watches) out[key] = anomalyCursorJson(c);
  return JSON.stringify({ watches: out });
}

function sameWatches(
  a: ReadonlyMap<string, AnomalyCursor>,
  b: ReadonlyMap<string, AnomalyCursor>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || writeAnomalyCursor(other) !== writeAnomalyCursor(value)) {
      return false;
    }
  }
  return true;
}

/** A short, stable hash of a watch key for its threads (FNV-1a, 8 hex digits). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** How a report row sits in the inbox. */
type RowMode = 'channel' | 'digest' | 'alert';

/**
 * Produces the scheduled reports. `tick()` is idempotent and serialised: a call while a pass runs
 * returns that pass. With nothing scheduling a report no timer is armed (D-43).
 */
export class ReportScheduler {
  private readonly log: Logger;
  private readonly redactor: Redactor;
  private cancel: (() => void) | undefined;
  private offRegistry: (() => void) | undefined;
  private offSettings: (() => void) | undefined;
  private started = false;
  private current: Promise<ReportPass> | undefined;
  private readonly digestCache = new Map<string, DigestCursor>();
  private readonly anomalyCache = new Map<string, AnomalyCursor>();
  private watchCache: Map<string, AnomalyCursor> | undefined;

  constructor(private readonly deps: ReportSchedulerDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
    this.redactor = deps.redactor ?? createRedactor();
  }

  /** Arms the timer while a schedule wants a report, follows reloads, and catches up now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.offRegistry = this.deps.registry.onChange(() => this.arm());
    this.offSettings = this.deps.settings?.onChange(() => {
      this.arm();
      if (this.wanted()) void this.tick().catch((err: unknown) => this.report(err));
    });
    this.arm();
    if (this.wanted()) void this.tick().catch((err: unknown) => this.report(err));
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.offRegistry?.();
    this.offRegistry = undefined;
    this.offSettings?.();
    this.offSettings = undefined;
    this.cancel?.();
    this.cancel = undefined;
    this.started = false;
  }

  /** Every schedule: the channels with a digest or anomaly alerts, then the in-app settings. */
  private schedules(): Schedule[] {
    const out: Schedule[] = this.deps.registry
      .channels()
      .filter((c) => c.record.rules.digest !== undefined || c.record.rules.anomaly !== undefined)
      .map((c) => ({
        key: c.record.channelId,
        name: c.record.name,
        rules: c.record.rules,
        channel: c.record,
      }));
    const settings = this.settings();
    if (schedulesReports(settings)) {
      out.push({ key: IN_APP_SCHEDULE, name: IN_APP_SCHEDULE, rules: settings, channel: null });
    }
    return out;
  }

  private settings(): ReportSettings {
    return this.deps.settings?.current() ?? {};
  }

  /** Something to do: a schedule, or a watch left to close. */
  private wanted(): boolean {
    return this.schedules().length > 0 || (this.watchCache?.size ?? 0) > 0;
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

  /** The zone a schedule's reports use. */
  zoneOf(rules: Pick<NotificationChannelRules, 'time_zone'>): string {
    return usableZone(rules.time_zone, this.hostZone());
  }

  private hostZone(): string {
    return usableZone(this.deps.hostZone(), 'UTC');
  }

  /**
   * One pass: the anomaly watches (the in-app alerts), then every schedule's due digest and, for
   * channels, the anomaly check when due.
   *
   * @returns How many digests and anomaly decisions were written.
   */
  tick(): Promise<ReportPass> {
    if (this.current !== undefined) return this.current;
    const run = this.pass().finally(() => {
      this.current = undefined;
      // A watch closed in this pass may leave nothing to do.
      this.arm();
    });
    this.current = run;
    return run;
  }

  private async pass(): Promise<ReportPass> {
    const now = this.deps.clock.now();
    let digests = 0;
    let anomalies = 0;
    let anomalyFacts: Promise<AnomalyFacts> | undefined;
    const facts = () => {
      anomalyFacts ??= this.deps.facts.anomaly(now);
      return anomalyFacts;
    };
    try {
      anomalies += await this.watchTick(now, facts);
    } catch (err) {
      this.log.error('anomaly watch failed', { err: serializeError(err) });
    }
    for (const schedule of this.schedules()) {
      const rules = schedule.rules;
      try {
        if (rules.digest !== undefined && (await this.digestTick(schedule, rules.digest, now))) {
          digests++;
        }
      } catch (err) {
        this.log.error('digest failed', { channel: schedule.name, err: serializeError(err) });
      }
      if (schedule.channel === null || rules.anomaly === undefined) continue;
      try {
        if (await this.anomalyTick(schedule.channel, now, facts)) anomalies++;
      } catch (err) {
        this.log.error('anomaly check failed', {
          channel: schedule.name,
          err: serializeError(err),
        });
      }
    }
    return { digests, anomalies };
  }

  // -----------------------------------------------------------------------------------------------
  // Digests
  // -----------------------------------------------------------------------------------------------

  private async digestCursor(key: string): Promise<DigestCursor | null> {
    const cached = this.digestCache.get(key);
    if (cached !== undefined) return cached;
    const read = readDigestCursor(
      await this.deps.repos.notificationCursors.get(digestCursorKey(key)),
    );
    if (read !== null) this.digestCache.set(key, read);
    return read;
  }

  /** Handles a schedule's due digest; `true` when one was produced. */
  private async digestTick(schedule: Schedule, rule: DigestRule, now: number) {
    const zone = this.zoneOf(schedule.rules);
    const spec = scheduleKey(rule, zone);
    const cursorKey = digestCursorKey(schedule.key);
    const cursor = await this.digestCursor(schedule.key);
    if (cursor === null || cursor.spec !== spec) {
      // A new schedule (or a changed one) arms from now: an edit never causes a late digest.
      const armed: DigestCursor = { spec, last: now, until: cursor?.until ?? null };
      await this.deps.repos.notificationCursors.set(cursorKey, JSON.stringify(armed), now);
      this.digestCache.set(schedule.key, armed);
      return false;
    }
    const due = occurrencesBetween(rule, zone, cursor.last, now);
    const newest = due.at[due.at.length - 1];
    if (newest === undefined) return false;
    const skipped = due.at.length - 1 + due.older;
    const late = now - newest > LATE_AFTER_MS;
    const window = digestWindow(rule, zone, newest, cursor.until);
    const facts = await this.deps.facts.digest(window, rule);
    const empty = isEmptyDigest(facts);
    const timing = { zone, scheduledAt: newest, late, skipped, manual: false };
    const next: DigestCursor = { spec, last: newest, until: window.until };
    let row: NotificationRecord | null = null;
    let jobs: readonly NewNotificationDelivery[] = [];
    const record = schedule.channel;
    if (record !== null) {
      const quietHours = quietHoursOf(record.rules);
      const built = this.digestOf(record, rule, facts, now, {
        ...timing,
        level: contentLevelOf(record.rules),
        quiet: quietHours !== null && inQuietHours(newest, quietHours),
      });
      row = built.record;
      jobs = this.deps.outbox.plan(built.message, now, record.channelId);
      if (empty) {
        jobs = jobs.map((j) =>
          j.status === 'pending'
            ? { ...j, status: 'suppressed', reason: 'empty', nextAttemptAt: null }
            : j,
        );
      }
    }
    // An empty period has no in-app copy (never empty, D-43).
    const inApp = empty
      ? null
      : await this.inAppDigest(digestPeriodThread(spec, window), rule, facts, now, timing);
    const inserted = await this.write({
      row,
      jobs,
      inApp,
      cursor: { key: cursorKey, value: JSON.stringify(next) },
      now,
      ...(record !== null && { channelId: record.channelId }),
    });
    this.digestCache.set(schedule.key, next);
    const kind = rule.every === 'week' ? 'digest.weekly' : 'digest.daily';
    if (record !== null) this.count(kind, empty ? 'empty' : late ? 'late' : 'sent');
    if (inserted) this.count(kind, 'in_app');
    if (skipped > 0) this.count(kind, 'skipped', skipped);
    this.log.info(empty ? 'digest empty' : 'digest produced', {
      channel: schedule.name,
      late,
      skipped,
    });
    return row !== null || inserted;
  }

  /** The channel copy of a digest: the channel's level, zone and quiet hours, out of the inbox. */
  private digestOf(
    record: NotificationChannelRecord,
    rule: DigestRule,
    facts: DigestFacts,
    now: number,
    ctx: ReportContext,
  ): { message: NotificationMessage; record: NotificationRecord } {
    const content = buildDigest(facts, rule, ctx);
    const thread = `digest:${record.channelId}:${facts.window.until}`;
    const message = this.seal(this.messageOf(content, thread, now, 1, ctx.level, null));
    return { message, record: this.recordOf(message, content.target, now, 'channel') };
  }

  /**
   * The in-app copy of a digest period (D-45): looked up by thread, built at `full` only when
   * missing (the transaction checks again).
   */
  private async inAppDigest(
    thread: string,
    rule: DigestRule,
    facts: DigestFacts,
    now: number,
    timing: Pick<ReportContext, 'zone' | 'scheduledAt' | 'late' | 'skipped' | 'manual'>,
  ): Promise<InAppCopy> {
    const existing = await this.deps.repos.notifications.findLatestByThread(null, thread);
    if (existing !== null) return { thread, copy: null };
    const content = buildDigest(facts, rule, { ...timing, level: 'full', quiet: false });
    const id = this.newId();
    const message = this.seal(
      reportMessage(
        // A digest never rings in the dashboard.
        { ...content, alert: false },
        { id, thread, revision: 1, createdAt: now, updatedAt: now, level: 'full' },
      ),
    );
    return { thread, copy: { record: this.recordOf(message, reportPath(id), now, 'digest') } };
  }

  /**
   * The digest of a window for a channel, sealed (redacted, validated) with a fresh notification
   * id and its channel row (read and dismissed: the inbox shows the period's in-app copy, D-45).
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
    const built = this.digestOf(record, rule, facts, now, ctx);
    return { ...built, window, empty: isEmptyDigest(facts), facts, rule, ctx };
  }

  /**
   * The on-demand digest of a channel: the period that ends now (a day, or a week), never late and
   * never suppressed as empty; the schedule and its cursor are untouched.
   *
   * @returns The report (a daily one when the channel schedules no digest).
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

  /**
   * Stores the in-app copy of an on-demand digest that is being sent (D-45: a period of its own,
   * kept even when empty because someone asked for it) and announces it.
   *
   * @returns The copy's notification id, for the channel row's `source_event_id`.
   */
  async storeManualCopy(built: BuiltReport): Promise<string | null> {
    const now = this.deps.clock.now();
    const thread = manualPeriodThread(built.ctx.zone, built.window);
    const inApp = await this.inAppDigest(thread, built.rule, built.facts, now, built.ctx);
    let found: { id: string | null; inserted: NotificationRecord | null } = {
      id: null,
      inserted: null,
    };
    await this.deps.uow.transaction(async (repos) => {
      found = await this.linkInApp(repos, inApp);
    });
    if (found.inserted !== null) {
      this.announce('created', found.inserted);
      this.count(built.message.kind, 'in_app');
    }
    return found.id;
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

  private async watches(): Promise<Map<string, AnomalyCursor>> {
    if (this.watchCache !== undefined) return this.watchCache;
    const read = readWatches(
      await this.deps.repos.notificationCursors.get(anomalyCursorKey(IN_APP_SCHEDULE)),
    );
    this.watchCache = read;
    return read;
  }

  /** The watches the schedules want: one per distinct effective thresholds (D-45). */
  private wantedWatches(): Map<string, AnomalyRule> {
    const out = new Map<string, AnomalyRule>();
    for (const schedule of this.schedules()) {
      const rule = schedule.rules.anomaly;
      if (rule !== undefined) out.set(watchKey(rule), rule);
    }
    return out;
  }

  /**
   * One step of the anomaly checks for a stored state: the outcome of D-44 as the rows to write.
   * `thread` names the thread of a new alert; `mode` says how its row sits in the inbox.
   */
  private async anomalyStep(input: {
    readonly cursor: AnomalyCursor | null;
    readonly rule: AnomalyRule;
    readonly facts: AnomalyFacts;
    readonly now: number;
    readonly ctx: ReportContext;
    readonly thread: () => string;
    readonly mode: RowMode;
  }): Promise<{
    readonly row: NotificationRecord | null;
    readonly message: NotificationMessage | null;
    readonly revised: Revised | null;
    readonly next: AnomalyCursor;
    readonly outcome: 'sent' | 'resolved' | 'revised' | 'none';
  }> {
    const { cursor, facts, now, ctx } = input;
    const previous: AnomalyState = cursor?.active ?? {};
    const evaluation = evaluateAnomalies(facts, input.rule, previous, now);
    const openId = cursor?.notificationId ?? null;
    const activeNow = Object.keys(evaluation.active).length > 0;
    if (evaluation.fired.length > 0) {
      const content = buildAnomaly(
        { facts, active: evaluation.active, fired: evaluation.fired },
        ctx,
      );
      const id = this.newId();
      const target = input.mode === 'channel' ? content.target : reportPath(id);
      const message = this.seal(
        reportMessage(content, {
          id,
          thread: input.thread(),
          revision: 1,
          createdAt: now,
          updatedAt: now,
          level: ctx.level,
        }),
      );
      const superseded =
        openId === null
          ? null
          : await this.revision(openId, now, (prev) => ({
              ...prev,
              state: 'final',
              alert: false,
              summary: `Superseded by the report of ${formatClock(now, ctx.zone)}.`,
              actions: [],
            }));
      return {
        row: this.recordOf(message, target, now, input.mode),
        message,
        revised: superseded,
        next: { last: now, active: evaluation.active, notificationId: id },
        outcome: 'sent',
      };
    }
    if (!activeNow && evaluation.cleared.length > 0 && openId !== null) {
      const began = Math.min(...Object.values(previous).map((a) => a?.since ?? now), now);
      const content = buildAnomaly({ facts, active: {}, fired: [], resolvedSince: began }, ctx);
      const revised = await this.revision(openId, now, (prev) =>
        this.messageOf(content, prev.thread, now, prev.revision + 1, ctx.level, prev),
      );
      return {
        row: null,
        message: null,
        revised,
        next: { last: now, active: {}, notificationId: null },
        outcome: 'resolved',
      };
    }
    if (activeNow && evaluation.cleared.length > 0 && openId !== null) {
      const content = buildAnomaly({ facts, active: evaluation.active, fired: [] }, ctx);
      const revised = await this.revision(openId, now, (prev) =>
        this.messageOf(content, prev.thread, now, prev.revision + 1, ctx.level, prev),
      );
      return {
        row: null,
        message: null,
        revised,
        next: { last: now, active: evaluation.active, notificationId: openId },
        outcome: 'revised',
      };
    }
    return {
      row: null,
      message: null,
      revised: null,
      next: { last: now, active: evaluation.active, notificationId: activeNow ? openId : null },
      outcome: 'none',
    };
  }

  /**
   * The anomaly watches (D-45): each wanted watch checked at its hourly slot (no quiet hours,
   * `full`, the in-app zone); a watch no longer wanted is dropped and its open alert closed.
   *
   * @returns How many watch decisions wrote a notification.
   */
  private async watchTick(now: number, factsOf: () => Promise<AnomalyFacts>): Promise<number> {
    const wanted = this.wantedWatches();
    const stored = await this.watches();
    if (wanted.size === 0 && stored.size === 0) return 0;
    const slot = Math.floor(now / HOUR) * HOUR;
    const zone = this.zoneOf(this.settings());
    const next = new Map(stored);
    const rows: NotificationRecord[] = [];
    const revised: Revised[] = [];
    let decisions = 0;
    for (const [key, cursor] of stored) {
      if (wanted.has(key)) continue;
      next.delete(key);
      if (cursor.notificationId === null) continue;
      const closed = await this.revision(cursor.notificationId, now, (prev) => ({
        ...prev,
        state: 'final',
        alert: false,
        summary: 'No longer checked.',
        actions: [],
      }));
      if (closed !== null) revised.push(closed);
    }
    for (const [key, rule] of wanted) {
      const cursor = stored.get(key) ?? null;
      if (cursor !== null && cursor.last >= slot) continue;
      const step = await this.anomalyStep({
        cursor,
        rule,
        facts: await factsOf(),
        now,
        ctx: {
          zone,
          level: 'full',
          scheduledAt: now,
          late: false,
          skipped: 0,
          manual: false,
          quiet: false,
        },
        thread: () => `${IN_APP_REPORT_THREAD}anomaly:${shortHash(key)}:${now}`,
        mode: 'alert',
      });
      next.set(key, step.next);
      if (step.row !== null) rows.push(step.row);
      if (step.revised !== null) revised.push(step.revised);
      if (step.outcome !== 'none') {
        decisions++;
        this.count('report.anomaly', step.outcome === 'sent' ? 'in_app' : step.outcome);
      }
    }
    if (rows.length === 0 && revised.length === 0 && sameWatches(stored, next)) return 0;
    await this.write({
      inAppRows: rows,
      revised,
      cursor: { key: anomalyCursorKey(IN_APP_SCHEDULE), value: writeWatches(next) },
      now,
    });
    this.watchCache = next;
    if (rows.length > 0) this.log.info('anomaly alert', { channel: IN_APP_SCHEDULE });
    return decisions;
  }

  /** Runs a channel's check when due; `true` when a notification was written or revised. */
  private async anomalyTick(
    record: NotificationChannelRecord,
    now: number,
    factsOf: () => Promise<AnomalyFacts>,
  ): Promise<boolean> {
    const rule = record.rules.anomaly;
    if (rule === undefined) return false;
    const cursor = await this.anomalyCursor(record.channelId);
    const slot = Math.floor(now / HOUR) * HOUR;
    if (cursor !== null && cursor.last >= slot) return false;
    const quiet = quietHoursOf(record.rules);
    // During quiet hours no check runs and `last` stays: the first tick after them checks.
    if (quiet !== null && inQuietHours(now, quiet)) return false;
    const key = anomalyCursorKey(record.channelId);
    const step = await this.anomalyStep({
      cursor,
      rule,
      facts: await factsOf(),
      now,
      ctx: {
        zone: this.zoneOf(record.rules),
        level: contentLevelOf(record.rules),
        scheduledAt: now,
        late: false,
        skipped: 0,
        manual: false,
        quiet: false,
      },
      thread: () => `anomaly:${record.channelId}`,
      mode: 'channel',
    });
    if (step.outcome === 'none') {
      await this.deps.repos.notificationCursors.set(key, writeAnomalyCursor(step.next), now);
      this.anomalyCache.set(record.channelId, step.next);
      return false;
    }
    // A new channel alert names its watch's open alert (the in-app copy of the episode).
    const linkTo =
      step.row === null
        ? null
        : ((await this.watches()).get(watchKey(rule))?.notificationId ?? null);
    await this.write({
      row: step.row,
      jobs: step.message === null ? [] : this.deps.outbox.plan(step.message, now, record.channelId),
      revised: step.revised === null ? [] : [step.revised],
      channelId: record.channelId,
      linkTo,
      cursor: { key, value: writeAnomalyCursor(step.next) },
      now,
    });
    this.anomalyCache.set(record.channelId, step.next);
    if (step.outcome !== 'revised') this.count('report.anomaly', step.outcome);
    this.log.info(step.outcome === 'resolved' ? 'anomaly cleared' : 'anomaly alert', {
      channel: record.name,
    });
    return true;
  }

  /** A revision of a stored report notification, or `null` when it is gone. */
  private async revision(
    notificationId: string,
    now: number,
    change: (prev: NotificationMessage) => NotificationMessage,
  ): Promise<Revised | null> {
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
        messageJson: JSON.stringify(message),
      },
      message,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Shared
  // -----------------------------------------------------------------------------------------------

  private newId(): string {
    return `n-${this.deps.ids.opaque(12)}`;
  }

  private messageOf(
    content: ReportContent,
    thread: string,
    now: number,
    revision: number,
    level: NotificationMessage['privacy']['level'],
    prev: NotificationMessage | null,
  ): NotificationMessage {
    return reportMessage(content, {
      id: prev?.id ?? this.newId(),
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

  /**
   * The row of a report: a channel copy (read and dismissed: never in the inbox), an in-app digest
   * (read: no badge) or an in-app anomaly alert (unread) (D-45).
   */
  private recordOf(
    message: NotificationMessage,
    target: string,
    now: number,
    mode: RowMode,
  ): NotificationRecord {
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
      readAt: mode === 'alert' ? null : now,
      dismissedAt: mode === 'channel' ? now : null,
      kind: message.kind,
      category: KIND_CATEGORY[message.kind],
      severity: message.severity,
      state: message.state,
      revision: message.revision,
      thread: message.thread,
      messageJson: JSON.stringify(message),
    };
  }

  /** Finds the period's in-app copy in the transaction, inserting the prepared one when missing. */
  private async linkInApp(
    repos: Repositories,
    inApp: InAppCopy,
  ): Promise<{ id: string | null; inserted: NotificationRecord | null }> {
    const existing = await repos.notifications.findLatestByThread(null, inApp.thread);
    if (existing !== null) return { id: existing.notificationId, inserted: null };
    if (inApp.copy === null) return { id: null, inserted: null };
    await repos.notifications.insert(inApp.copy.record);
    return { id: inApp.copy.record.notificationId, inserted: inApp.copy.record };
  }

  /**
   * Writes one report decision in one transaction: the period's in-app copy (found or inserted),
   * new in-app rows, revisions, the channel row naming its in-app copy, their delivery rows and the
   * cursor; then announces the in-app changes and wakes the outbox.
   *
   * @returns Whether an in-app copy of a digest period was inserted.
   */
  private async write(plan: WritePlan): Promise<boolean> {
    const { now } = plan;
    const revised = plan.revised ?? [];
    // With a channel, the revisions are that channel's copies; without, in-app copies (no jobs).
    const channelId = plan.channelId;
    const channelRevisions = channelId === undefined ? [] : revised;
    const revisionJobs =
      channelId === undefined
        ? []
        : channelRevisions.flatMap((r) => this.deps.outbox.plan(r.message, now, channelId));
    const jobs = [...revisionJobs, ...(plan.jobs ?? [])];
    let found: { id: string | null; inserted: NotificationRecord | null } = {
      id: plan.linkTo ?? null,
      inserted: null,
    };
    await this.deps.uow.transaction(async (repos) => {
      if (plan.inApp !== undefined && plan.inApp !== null) {
        found = await this.linkInApp(repos, plan.inApp);
      }
      for (const r of revised) {
        await repos.notifications.revise(r.record.notificationId, {
          state: r.message.state,
          severity: r.message.severity,
          revision: r.message.revision,
          messageJson: JSON.stringify(r.message),
        });
      }
      for (const row of plan.inAppRows ?? []) await repos.notifications.insert(row);
      if (plan.row !== undefined && plan.row !== null) {
        await repos.notifications.insert(
          found.id === null ? plan.row : { ...plan.row, sourceEventId: found.id },
        );
      }
      if (jobs.length > 0) await repos.notificationDeliveries.enqueue(jobs);
      await repos.notificationCursors.set(plan.cursor.key, plan.cursor.value, now);
    });
    if (found.inserted !== null) this.announce('created', found.inserted);
    for (const row of plan.inAppRows ?? []) this.announce('created', row);
    if (channelId === undefined) for (const r of revised) this.announce('updated', r.record);
    const touched = [
      ...channelRevisions.map((r) => r.record.notificationId),
      ...(plan.row === undefined || plan.row === null ? [] : [plan.row.notificationId]),
    ];
    for (const id of touched) {
      try {
        this.deps.onDeliveryChange?.(id);
      } catch (err) {
        this.log.warn('delivery feed failed', { err: serializeError(err) });
      }
    }
    if (jobs.some((j) => j.status === 'pending')) this.deps.outbox.kick();
    return found.inserted !== null;
  }

  /** Publishes an in-app copy on the `notifications` topic. */
  private announce(op: 'created' | 'updated', record: NotificationRecord): void {
    if (this.deps.inbox === undefined) return;
    try {
      this.deps.inbox(op, toNotification(record));
    } catch (err) {
      this.log.warn('inbox announce failed', { err: serializeError(err) });
    }
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
    return reportsView(record.rules, this.deps.clock.now(), this.hostZone(), {
      until: this.digestCache.get(record.channelId)?.until ?? null,
      ...(ac !== undefined && { anomaly: { last: ac.last, active: ac.active } }),
    });
  }

  /**
   * The in-app reports as the Reports tab shows them: the next digest and the in-app watch.
   *
   * @returns The view.
   */
  inAppView(settings: ReportSettings): ChannelReports {
    const watch =
      settings.anomaly === undefined ? undefined : this.watchCache?.get(watchKey(settings.anomaly));
    return reportsView(settings, this.deps.clock.now(), this.hostZone(), {
      until: this.digestCache.get(IN_APP_SCHEDULE)?.until ?? null,
      ...(watch !== undefined && { anomaly: { last: watch.last, active: watch.active } }),
    });
  }

  /** The host's zone (the in-app reports without `time_zone`). */
  hostTimeZone(): string {
    return this.hostZone();
  }

  /** Reads every schedule's cursors into the cache (the views before the first tick). */
  async load(): Promise<void> {
    for (const schedule of this.schedules()) {
      await this.digestCursor(schedule.key);
      if (schedule.channel !== null) await this.anomalyCursor(schedule.key);
    }
    await this.watches();
  }
}

/**
 * The scheduled reports of a channel (or of the in-app settings) as the API shows them
 * (`ChannelView.reports`), from its rules and, when known, its cursors (without them: armed now,
 * a check due now).
 *
 * @returns The view.
 */
export function reportsView(
  rules: Pick<NotificationChannelRules, 'digest' | 'anomaly' | 'time_zone'>,
  now: number,
  hostZone: string,
  state: {
    readonly until?: number | null;
    readonly anomaly?: { readonly last: number; readonly active: AnomalyState };
  } = {},
): ChannelReports {
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
            day: digest.every === 'week' ? digestDay(digest) : null,
            weekdays_only: digest.every === 'day' && digest.weekdays_only === true,
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
