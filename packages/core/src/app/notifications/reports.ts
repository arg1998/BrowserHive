/** @module app/notifications/reports — the pure producers of scheduled reports (D-43, D-44, spec 03 §9.7): the digest from its facts at a channel's content level, the empty-digest rule, the anomaly checks with hysteresis, and the anomaly alert. Table-driven; no I/O and no clock. */

import type {
  NotificationContentLevel,
  NotificationKind,
  NotificationSeverity,
  NotificationState,
} from '@browserhive/contracts/enums';
import { harnessLabel } from '@browserhive/contracts/harness';
import {
  ANOMALY_CHECKS,
  ANOMALY_DEFAULTS,
  type AnomalyCheck,
  type AnomalyRule,
  type Block,
  type DigestRule,
  type Inline,
  type NotificationAction,
  type NotificationMessage,
  type NotificationReport,
} from '@browserhive/contracts/notifications';
import {
  bold,
  buildMessage,
  code,
  formatCount,
  formatDuration,
  formatPercent,
  text,
} from './message.ts';
import { formatClock, formatDay, formatSpan, formatStamp } from './schedule.ts';

/** Tools with fewer calls than this in a window do not compete for "slowest tool". */
export const SLOWEST_TOOL_MIN_CALLS = 5;

/** What a digest reports about one window (gathered by `ReportFacts`). */
export interface DigestFacts {
  readonly window: { readonly since: number; readonly until: number };
  readonly sessionsStarted: number;
  readonly sessionsLive: number;
  readonly toolCalls: number;
  readonly errors: number;
  /** The same counts over the period before the window (the comparison). */
  readonly previous: { readonly toolCalls: number; readonly errors: number };
  readonly attention: {
    readonly created: number;
    readonly resolved: number;
    readonly rejected: number;
    readonly timedOut: number;
    readonly cancelled: number;
    readonly pending: number;
    /** Median wait of the answered requests; `null` without any. */
    readonly medianWaitMs: number | null;
  };
  /** Vault accesses by result, most first. */
  readonly vault: readonly { readonly result: string; readonly count: number }[];
  readonly blocked: {
    readonly count: number;
    readonly topPattern: { readonly pattern: string; readonly count: number } | null;
    readonly topDomain: { readonly domain: string; readonly count: number } | null;
  };
  /** The tool with the highest p95 (≥ {@link SLOWEST_TOOL_MIN_CALLS} calls), and its previous p95. */
  readonly slowest: {
    readonly tool: string;
    readonly p95Ms: number;
    readonly previousP95Ms: number | null;
  } | null;
  readonly topErrors: readonly {
    readonly errorCode: string;
    readonly tool: string;
    readonly count: number;
    readonly sessions: number;
  }[];
  /** Unresolved degradations (warn and error). */
  readonly degradations: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly since: number;
  }[];
  readonly harnesses: readonly {
    readonly harness: string;
    readonly sessions: number;
    readonly toolCalls: number;
    readonly errors: number;
  }[];
  /** Tool calls per bucket over the window (the chart). */
  readonly chart: { readonly start: number; readonly stepMs: number; readonly values: number[] };
}

/** How a report is being produced for one channel. */
export interface ReportContext {
  /** IANA zone the report's dates are written in. */
  readonly zone: string;
  readonly level: NotificationContentLevel;
  /** The scheduled time (a digest), or the check time (an anomaly alert). */
  readonly scheduledAt: number;
  readonly late: boolean;
  readonly skipped: number;
  readonly manual: boolean;
  /** The scheduled time falls in the channel's quiet hours: send silently. */
  readonly quiet: boolean;
}

/** The parts of a report message a producer decides (the rest is the notification's identity). */
export interface ReportContent {
  readonly kind: NotificationKind;
  readonly severity: NotificationSeverity;
  readonly state: NotificationState;
  readonly alert: boolean;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly Block[];
  readonly actions: readonly NotificationAction[];
  readonly report: NotificationReport;
  /** Dashboard path of the in-app row. */
  readonly target: string;
}

/**
 * The contract message of a report (not yet redacted): the report's own content level and window.
 * A later revision is silent; a message out of `open` keeps its links only while `final`.
 *
 * @returns The message.
 */
export function reportMessage(
  content: ReportContent,
  input: {
    readonly id: string;
    readonly thread: string;
    readonly revision: number;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly level: NotificationContentLevel;
  },
): NotificationMessage {
  const base = buildMessage({
    id: input.id,
    revision: input.revision,
    thread: input.thread,
    kind: content.kind,
    severity: content.severity,
    state: content.state,
    alert: input.revision === 1 ? content.alert : false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    title: content.title,
    summary: content.summary,
    blocks: content.blocks,
    actions: content.state === 'open' || content.state === 'final' ? content.actions : [],
    entities: {},
  });
  return { ...base, privacy: { level: input.level, has_image: false }, report: content.report };
}

/**
 * Whether a window had nothing worth a digest (D-43): no session started, no tool call, no
 * attention request, no vault access, no blocked request and no open degradation.
 *
 * @returns True when a scheduled digest is suppressed as `empty`.
 */
export function isEmptyDigest(facts: DigestFacts): boolean {
  return (
    facts.sessionsStarted === 0 &&
    facts.toolCalls === 0 &&
    facts.attention.created === 0 &&
    facts.vault.every((v) => v.count === 0) &&
    facts.blocked.count === 0 &&
    facts.degradations.length === 0
  );
}

/** A latency with one decimal in seconds below a minute (`4.2 s`), else like a duration. */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  return formatDuration(ms);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function rate(errors: number, calls: number): number {
  return calls === 0 ? 0 : errors / calls;
}

/** Vault results in words. */
const VAULT_RESULT_TEXT: Readonly<Record<string, string>> = {
  success: 'ok',
  origin_mismatch: 'origin mismatch',
  auth_failed: 'auth failed',
  blocked: 'blocked',
  denied: 'denied',
};

function overviewPath(since: number, until: number): string {
  return `/overview?since=${since}&until=${until}`;
}

function reportInfo(
  ctx: ReportContext,
  window: { since: number; until: number },
): NotificationReport {
  return {
    window: { since: window.since, until: window.until },
    time_zone: ctx.zone,
    late: ctx.late,
    skipped: ctx.skipped,
    manual: ctx.manual,
  };
}

/** The "sent late" / "skipped" / "on demand" note, or `null`. */
function timingNote(ctx: ReportContext, noun: string): Inline[] | null {
  const parts: Inline[] = [];
  if (ctx.manual) parts.push(text('Sent on demand.'));
  if (ctx.late) {
    parts.push(
      text(
        `Sent late: BrowserHive was not running at ${formatClock(ctx.scheduledAt, ctx.zone)} (${formatDay(ctx.scheduledAt, ctx.zone)}).`,
      ),
    );
  }
  if (ctx.skipped > 0) {
    parts.push(
      text(
        `${ctx.late ? ' ' : ''}${plural(ctx.skipped, `earlier ${noun}`)} ${ctx.skipped === 1 ? 'was' : 'were'} skipped while BrowserHive was off.`,
      ),
    );
  }
  return parts.length === 0 ? null : parts;
}

/**
 * The digest of one window at a channel's content level (spec 03 §9.7):
 * - `counts`: numbers and fixed labels only;
 * - `titles`: + tool names, error codes, harnesses, vault results, degradation codes, the top
 *   blocklist pattern, the tables;
 * - `full`: + degradation messages and the most blocked domain.
 *
 * @returns The report content (redaction and the contract's limits are applied by the caller).
 */
export function buildDigest(
  facts: DigestFacts,
  rule: DigestRule,
  ctx: ReportContext,
): ReportContent {
  const { since, until } = facts.window;
  const weekly = rule.every === 'week';
  const names = ctx.level !== 'counts';
  const full = ctx.level === 'full';
  const kind: NotificationKind = weekly ? 'digest.weekly' : 'digest.daily';
  const title = weekly
    ? `Weekly digest · ${formatSpan(since, until, ctx.zone)}`
    : `Daily digest · ${formatDay(until, ctx.zone)}`;
  const empty = isEmptyDigest(facts);
  const errRate = rate(facts.errors, facts.toolCalls);
  const summary = empty
    ? `Nothing happened: no sessions, tool calls or requests ${weekly ? 'this week' : 'today'}.`
    : `${plural(facts.sessionsStarted, 'session')} (${formatCount(facts.sessionsLive)} live) · ${plural(facts.toolCalls, 'tool call')} · ${plural(facts.errors, 'error')} (${formatPercent(errRate)})`;

  const fields: { label: string; value: Inline[] }[] = [];
  fields.push({
    label: 'Sessions',
    value: [
      text(
        `${formatCount(facts.sessionsStarted)} started · ${formatCount(facts.sessionsLive)} live now`,
      ),
    ],
  });
  const calls: Inline[] = [
    text(
      `${formatCount(facts.toolCalls)} · ${plural(facts.errors, 'error')} (${formatPercent(errRate)})`,
    ),
  ];
  if (facts.previous.toolCalls > 0) {
    calls.push(
      text(` · was ${formatPercent(rate(facts.previous.errors, facts.previous.toolCalls))}`),
    );
  }
  fields.push({ label: 'Tool calls', value: calls });
  const a = facts.attention;
  if (a.created > 0 || a.pending > 0) {
    const answered = a.resolved + a.rejected;
    const parts = [plural(a.created, 'request')];
    if (answered > 0) {
      parts.push(
        `${formatCount(answered)} answered${a.medianWaitMs === null ? '' : ` (median ${formatDuration(a.medianWaitMs)})`}`,
      );
    }
    if (a.timedOut > 0) parts.push(`${formatCount(a.timedOut)} timed out`);
    if (a.pending > 0) parts.push(`${formatCount(a.pending)} waiting now`);
    fields.push({ label: 'Attention', value: [text(parts.join(' · '))] });
  }
  const vaultTotal = facts.vault.reduce((n, v) => n + v.count, 0);
  if (vaultTotal > 0) {
    const failed = facts.vault
      .filter((v) => v.result !== 'success')
      .reduce((n, v) => n + v.count, 0);
    const detail = names
      ? facts.vault
          .filter((v) => v.count > 0)
          .map((v) => `${formatCount(v.count)} ${VAULT_RESULT_TEXT[v.result] ?? v.result}`)
          .join(' · ')
      : `${formatCount(failed)} failed`;
    fields.push({
      label: 'Vault fills',
      value: [text(`${formatCount(vaultTotal)} · ${detail}`)],
    });
  }
  if (facts.blocked.count > 0) {
    const value: Inline[] = [text(formatCount(facts.blocked.count))];
    if (names && facts.blocked.topPattern !== null) {
      value.push(text(' · top '), code(facts.blocked.topPattern.pattern));
      value.push(text(` (${formatCount(facts.blocked.topPattern.count)})`));
    }
    if (full && facts.blocked.topDomain !== null) {
      value.push(text(' · most blocked '), code(facts.blocked.topDomain.domain));
      value.push(text(` (${formatCount(facts.blocked.topDomain.count)})`));
    }
    fields.push({ label: 'Blocked requests', value });
  }
  if (names && facts.slowest !== null) {
    const was =
      facts.slowest.previousP95Ms === null
        ? ''
        : ` (was ${formatLatency(facts.slowest.previousP95Ms)})`;
    fields.push({
      label: 'Slowest tool (p95)',
      value: [code(facts.slowest.tool), text(` ${formatLatency(facts.slowest.p95Ms)}${was}`)],
    });
  }
  if (facts.degradations.length > 0) {
    fields.push({
      label: 'Open problems',
      value: names
        ? facts.degradations
            .slice(0, 3)
            .flatMap((d, i) => [
              ...(i > 0 ? [text(', ')] : []),
              code(d.code),
              text(` since ${formatStamp(d.since, ctx.zone)}`),
            ])
        : [text(formatCount(facts.degradations.length))],
    });
  }

  const blocks: Block[] = [];
  const note = timingNote(ctx, weekly ? 'weekly digest' : 'digest');
  if (note !== null) blocks.push({ type: 'text', content: note });
  blocks.push({ type: 'fields', items: fields.slice(0, 12) });
  if (!empty && facts.chart.values.length > 0) {
    blocks.push({
      type: 'chart',
      label: weekly ? 'Tool calls per 6 hours' : 'Tool calls per hour',
      values: facts.chart.values.slice(0, 48),
      start: facts.chart.start,
      step_ms: facts.chart.stepMs,
      unit: 'calls',
    });
  }
  if (names && facts.topErrors.length > 0) {
    blocks.push({ type: 'heading', text: 'Top errors' });
    blocks.push({
      type: 'table',
      columns: ['Error', 'Tool', 'Count', 'Sessions'],
      rows: facts.topErrors
        .slice(0, 5)
        .map((e) => [
          [code(e.errorCode)],
          [code(e.tool)],
          [text(formatCount(e.count))],
          [text(formatCount(e.sessions))],
        ]),
    });
  }
  const harnesses = facts.harnesses.filter((h) => h.sessions > 0 || h.toolCalls > 0);
  if (names && harnesses.length > 0) {
    blocks.push({ type: 'heading', text: 'By harness' });
    blocks.push({
      type: 'table',
      columns: ['Harness', 'Sessions', 'Tool calls', 'Errors'],
      rows: harnesses
        .slice(0, 8)
        .map((h) => [
          [text(harnessLabel(h.harness))],
          [text(formatCount(h.sessions))],
          [text(formatCount(h.toolCalls))],
          [text(formatCount(h.errors))],
        ]),
    });
  }
  if (full && facts.degradations.length > 0) {
    blocks.push({
      type: 'list',
      ordered: false,
      items: facts.degradations
        .slice(0, 5)
        .map((d) => [bold(d.code), text(` since ${formatStamp(d.since, ctx.zone)}: ${d.message}`)]),
    });
  }
  blocks.push({
    type: 'footer',
    content: [
      text(`${formatStamp(since, ctx.zone)} → ${formatStamp(until, ctx.zone)} · ${ctx.zone}`),
    ],
  });
  return {
    kind,
    severity: 'info',
    state: 'final',
    alert: !ctx.quiet,
    title,
    summary,
    blocks,
    actions: [
      {
        kind: 'open',
        id: 'overview',
        label: 'Open Overview',
        style: 'primary',
        path: overviewPath(since, until),
      },
    ],
    report: reportInfo(ctx, facts.window),
    target: overviewPath(since, until),
  };
}

// -------------------------------------------------------------------------------------------------
// Anomaly checks (D-44)
// -------------------------------------------------------------------------------------------------

/** What the hourly check looks at (the trailing hour, gathered once for every channel). */
export interface AnomalyFacts {
  readonly window: { readonly since: number; readonly until: number };
  readonly toolCalls: number;
  readonly errors: number;
  readonly blocked: number;
  /** Blocked requests per hour over the 24 hours before the window. */
  readonly blockedBaselinePerHour: number;
  /** Pending attention requests with how long each has waited, longest first. */
  readonly attentionWaiting: readonly {
    readonly sessionSlug: string | null;
    readonly waitedMs: number;
  }[];
  readonly live: number;
  readonly maxSessions: number;
  /** Unresolved error-severity system events. */
  readonly degradations: readonly {
    readonly code: string;
    readonly message: string;
    readonly since: number;
  }[];
}

/** One active check: when it became active, what was measured and against what. */
export interface ActiveCheck {
  readonly since: number;
  readonly value: number;
  readonly threshold: number;
}

/** The active checks of a channel. */
export type AnomalyState = Readonly<Partial<Record<AnomalyCheck, ActiveCheck>>>;

/** Resolved thresholds (`null` = check off). */
export interface AnomalyThresholds {
  readonly errorRate: number | null;
  readonly minCalls: number;
  readonly attentionMinutes: number | null;
  readonly blockedSpike: number | null;
  readonly blockedMin: number;
  readonly capacity: boolean;
  readonly degraded: boolean;
}

/**
 * A channel's thresholds with the defaults of D-44 filled in.
 *
 * @returns The thresholds.
 */
export function anomalyThresholds(rule: AnomalyRule): AnomalyThresholds {
  const pick = <T>(value: T | null | undefined, fallback: T): T | null =>
    value === null ? null : (value ?? fallback);
  return {
    errorRate: pick(rule.error_rate, ANOMALY_DEFAULTS.error_rate),
    minCalls: rule.min_calls ?? ANOMALY_DEFAULTS.min_calls,
    attentionMinutes: pick(rule.attention_minutes, ANOMALY_DEFAULTS.attention_minutes),
    blockedSpike: pick(rule.blocked_spike, ANOMALY_DEFAULTS.blocked_spike),
    blockedMin: rule.blocked_min ?? ANOMALY_DEFAULTS.blocked_min,
    capacity: rule.capacity ?? ANOMALY_DEFAULTS.capacity,
    degraded: rule.degraded ?? ANOMALY_DEFAULTS.degraded,
  };
}

/** Outcome of one evaluation. */
export interface AnomalyEvaluation {
  readonly active: AnomalyState;
  /** Checks that became active now (crossings), in report order. */
  readonly fired: readonly AnomalyCheck[];
  /** Checks that were active and cleared. */
  readonly cleared: readonly AnomalyCheck[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Evaluates a channel's checks on the facts of the trailing hour with hysteresis (the table of
 * D-44): a check fires at its threshold and, once active, stays active until it falls below its
 * clear level.
 *
 * @returns The new active set, the crossings and the clears.
 */
export function evaluateAnomalies(
  facts: AnomalyFacts,
  rule: AnomalyRule,
  previous: AnomalyState,
  now: number,
): AnomalyEvaluation {
  const t = anomalyThresholds(rule);
  const measured: Partial<Record<AnomalyCheck, { value: number; threshold: number; on: boolean }>> =
    {};
  if (t.errorRate !== null) {
    const pct = facts.toolCalls === 0 ? 0 : (facts.errors / facts.toolCalls) * 100;
    const was = previous.error_rate !== undefined;
    const on = was
      ? facts.toolCalls >= Math.ceil(t.minCalls / 2) && pct >= t.errorRate / 2
      : facts.toolCalls >= t.minCalls && pct >= t.errorRate;
    measured.error_rate = { value: round1(pct), threshold: t.errorRate, on };
  }
  if (t.attentionMinutes !== null) {
    const longest = facts.attentionWaiting.reduce((m, r) => Math.max(m, r.waitedMs), 0);
    const minutes = Math.floor(longest / 60_000);
    measured.attention = {
      value: minutes,
      threshold: t.attentionMinutes,
      on: minutes >= t.attentionMinutes,
    };
  }
  if (t.capacity && facts.maxSessions > 0) {
    const max = facts.maxSessions;
    const was = previous.capacity !== undefined;
    const on = was ? facts.live >= Math.min(0.9 * max, max - 1) : facts.live >= max;
    measured.capacity = { value: facts.live, threshold: max, on };
  }
  if (t.blockedSpike !== null) {
    const base = facts.blockedBaselinePerHour;
    const threshold = Math.max(t.blockedMin, Math.ceil(t.blockedSpike * base));
    const was = previous.blocked !== undefined;
    const on = was
      ? facts.blocked >= t.blockedMin / 2 && facts.blocked >= (t.blockedSpike / 2) * base
      : facts.blocked >= t.blockedMin && facts.blocked >= t.blockedSpike * base;
    measured.blocked = { value: facts.blocked, threshold, on };
  }
  if (t.degraded) {
    measured.degraded = {
      value: facts.degradations.length,
      threshold: 1,
      on: facts.degradations.length > 0,
    };
  }
  const active: Partial<Record<AnomalyCheck, ActiveCheck>> = {};
  const fired: AnomalyCheck[] = [];
  const cleared: AnomalyCheck[] = [];
  for (const check of ANOMALY_CHECKS) {
    const m = measured[check];
    const before = previous[check];
    if (m?.on === true) {
      active[check] = { since: before?.since ?? now, value: m.value, threshold: m.threshold };
      if (before === undefined) fired.push(check);
    } else if (before !== undefined) {
      cleared.push(check);
    }
  }
  return { active, fired, cleared };
}

/** Label of a check in a report table. */
const CHECK_LABEL: { readonly [C in AnomalyCheck]: string } = {
  error_rate: 'Tool-call error rate',
  attention: 'Attention waiting',
  capacity: 'Live sessions',
  blocked: 'Blocked requests (hour)',
  degraded: 'Open degradations',
};

/** Minutes as `47 min` or `2h 05m`. */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${formatCount(minutes)} min`;
  return formatDuration(minutes * 60_000);
}

function checkValue(check: AnomalyCheck, value: number): string {
  switch (check) {
    case 'error_rate':
      return `${formatCount(value)}%`;
    case 'attention':
      return formatMinutes(value);
    default:
      return formatCount(value);
  }
}

function checkThreshold(check: AnomalyCheck, threshold: number): string {
  switch (check) {
    case 'error_rate':
      return `≥ ${formatCount(threshold)}%`;
    case 'attention':
      return `≥ ${formatMinutes(threshold)}`;
    case 'capacity':
      return `limit ${formatCount(threshold)}`;
    default:
      return `≥ ${formatCount(threshold)}`;
  }
}

/** One-line headline of an active check. */
function headline(
  check: AnomalyCheck,
  a: ActiveCheck,
  facts: AnomalyFacts,
  names: boolean,
): string {
  switch (check) {
    case 'error_rate':
      return `${formatCount(a.value)}% of tool calls failed in the last hour`;
    case 'attention':
      return `An attention request has waited ${formatMinutes(a.value)}`;
    case 'capacity':
      return `Sessions at the limit (${formatCount(a.value)} of ${formatCount(a.threshold)})`;
    case 'blocked':
      return `Blocked requests spiked: ${formatCount(a.value)} in the last hour`;
    case 'degraded': {
      const first = facts.degradations[0];
      return names && first !== undefined
        ? `BrowserHive is degraded: ${first.code}`
        : 'BrowserHive is degraded';
    }
  }
}

/** One sentence with the numbers behind a single active check (the summary of a one-check alert). */
function detail(
  check: AnomalyCheck,
  a: ActiveCheck,
  facts: AnomalyFacts,
  ctx: ReportContext,
  names: boolean,
): string {
  const span = `between ${formatClock(facts.window.since, ctx.zone)} and ${formatClock(facts.window.until, ctx.zone)}`;
  switch (check) {
    case 'error_rate':
      return `${formatCount(facts.errors)} of ${formatCount(facts.toolCalls)} tool calls failed ${span} (alert at ${formatCount(a.threshold)}%).`;
    case 'attention': {
      const slug = names ? facts.attentionWaiting[0]?.sessionSlug : null;
      const who =
        slug === null || slug === undefined ? 'The oldest request' : `The request of ${slug}`;
      return `${who} has waited ${formatMinutes(a.value)} for an answer (alert at ${formatMinutes(a.threshold)}).`;
    }
    case 'capacity':
      return `${formatCount(facts.live)} of ${formatCount(facts.maxSessions)} sessions are live; new sessions are refused until one closes.`;
    case 'blocked':
      return `${formatCount(facts.blocked)} requests were blocked ${span}, against about ${formatCount(Math.round(facts.blockedBaselinePerHour))} an hour the day before.`;
    case 'degraded':
      return `${formatCount(facts.degradations.length)} problem${facts.degradations.length === 1 ? ' is' : 's are'} open on the System page.`;
  }
}

/** Inputs of {@link buildAnomaly}. */
export interface AnomalyInput {
  readonly facts: AnomalyFacts;
  readonly active: AnomalyState;
  /** The crossings of this check (listed first, marked new). */
  readonly fired: readonly AnomalyCheck[];
  /** `resolved` when every check cleared (with when the episode began). */
  readonly resolvedSince?: number;
}

/**
 * The anomaly alert (D-44): every active check with its value, threshold and since when, the new
 * ones first; or "Back to normal" once all cleared (a silent, resolved revision).
 *
 * @returns The report content.
 */
export function buildAnomaly(input: AnomalyInput, ctx: ReportContext): ReportContent {
  const { facts } = input;
  const names = ctx.level !== 'counts';
  const window = facts.window;
  const target = '/overview?range=24h';
  const actions: NotificationAction[] = [
    { kind: 'open', id: 'overview', label: 'Open Overview', style: 'primary', path: target },
  ];
  const footer: Block = {
    type: 'footer',
    content: [
      text(
        `Checked ${formatClock(window.since, ctx.zone)}–${formatClock(window.until, ctx.zone)} · ${ctx.zone}`,
      ),
    ],
  };
  if (input.resolvedSince !== undefined) {
    const lasted = formatDuration(Math.max(0, ctx.scheduledAt - input.resolvedSince));
    return {
      kind: 'report.anomaly',
      severity: 'info',
      state: 'resolved',
      alert: false,
      title: 'Back to normal',
      summary: `Every check is back under its threshold since ${formatClock(ctx.scheduledAt, ctx.zone)} · it lasted ${lasted}.`,
      blocks: [footer],
      actions: [],
      report: reportInfo(ctx, window),
      target,
    };
  }
  const order = [
    ...input.fired,
    ...ANOMALY_CHECKS.filter((c) => input.active[c] !== undefined && !input.fired.includes(c)),
  ];
  const lines = order.flatMap((c) => {
    const a = input.active[c];
    return a === undefined ? [] : [{ check: c, active: a }];
  });
  const first = lines[0];
  const title =
    first === undefined
      ? 'Something looks off'
      : lines.length === 1
        ? `Something looks off: ${headline(first.check, first.active, facts, names)}`
        : `Something looks off: ${lines.length} checks`;
  const summary =
    first !== undefined && lines.length === 1
      ? detail(first.check, first.active, facts, ctx, names)
      : lines.map((l) => headline(l.check, l.active, facts, names)).join(' · ');
  const blocks: Block[] = [];
  blocks.push({
    type: 'table',
    columns: ['Check', 'Now', 'Threshold', 'Since'],
    rows: lines.map((l) => [
      [
        text(CHECK_LABEL[l.check]),
        ...(input.fired.includes(l.check) ? [text(' '), bold('new')] : []),
      ],
      [text(checkValue(l.check, l.active.value))],
      [text(checkThreshold(l.check, l.active.threshold))],
      [text(formatClock(l.active.since, ctx.zone))],
    ]),
  });
  if (names && input.active.degraded !== undefined && facts.degradations.length > 0) {
    blocks.push({
      type: 'list',
      ordered: false,
      items: facts.degradations
        .slice(0, 5)
        .map((d) => [
          code(d.code),
          text(
            ctx.level === 'full'
              ? ` since ${formatStamp(d.since, ctx.zone)}: ${d.message}`
              : ` since ${formatStamp(d.since, ctx.zone)}`,
          ),
        ]),
    });
  }
  if (names && input.active.attention !== undefined) {
    const slugs = facts.attentionWaiting
      .map((r) => r.sessionSlug)
      .filter((s): s is string => s !== null)
      .slice(0, 3);
    if (slugs.length > 0) {
      blocks.push({
        type: 'text',
        content: [
          text('Waiting: '),
          ...slugs.flatMap((s, i) => [...(i > 0 ? [text(', ')] : []), code(s)]),
        ],
      });
    }
  }
  blocks.push(footer);
  const severe = input.active.degraded !== undefined || input.active.capacity !== undefined;
  return {
    kind: 'report.anomaly',
    severity: severe ? 'error' : 'warn',
    state: 'open',
    alert: input.fired.length > 0,
    title,
    summary,
    blocks,
    actions,
    report: reportInfo(ctx, window),
    target,
  };
}
