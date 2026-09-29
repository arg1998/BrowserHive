/** @module app/notifications/samples — realistic sample notifications built through the real producers, for the channel preview, the test send and the renderer goldens (spec 03 §4.8.1). Pure: fixed ids and times. */

import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import {
  type Block,
  DEFAULT_CONTENT_LEVEL,
  DEFAULT_DIGEST_AT,
  type DigestRule,
  NotificationMessage,
  type PreviewSample,
} from '@browserhive/contracts/notifications';
import {
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  SessionClosedEvent,
  SystemDegradedEvent,
  ToolCalledEvent,
  VaultConfirmCreatedEvent,
} from '@browserhive/contracts/ws';
import type { DomainEvents } from '../events/catalog.ts';
import { buildMessage, reviseMessage, time } from './message.ts';
import { draftFor, type ProducedEvent, revisionFor } from './producers.ts';
import {
  type AnomalyFacts,
  buildAnomaly,
  buildDigest,
  type DigestFacts,
  evaluateAnomalies,
  reportMessage,
} from './reports.ts';

/** Session id of every sample. */
export const SAMPLE_SESSION_ID = 'checkout-a1b2c3d4';
/** Notification id of every sample. */
export const SAMPLE_NOTIFICATION_ID = 'n-sample000001';
/** Image ref of a sample screenshot (never resolves to bytes). */
export const SAMPLE_IMAGE_REF = 'nimg-sample';
/** Default time of the samples (2026-09-21, a fixed instant so goldens are stable). */
export const SAMPLE_NOW = 1_790_000_000_000;

const REQUEST_ID = 'a-sample000001';

/** Options of {@link sampleMessage}. */
export interface SampleOptions {
  /** Creation time of the sample; later revisions are a few seconds after. */
  readonly now?: number;
  /** Add a screenshot block (attention, vault confirm, crash); default none. */
  readonly image?: 'none' | 'masked' | 'unmasked';
  /** Content level the report samples are built at (reports are built per level); default `titles`. */
  readonly level?: NotificationContentLevel;
  /** Zone of the report samples; default {@link SAMPLE_ZONE}. */
  readonly zone?: string;
  /** Schedule of the digest sample; default daily at 09:00. */
  readonly digest?: DigestRule;
  /** The digest sample was sent late, with this many earlier windows skipped. */
  readonly late?: { readonly skipped: number };
  /** The anomaly sample as its "Back to normal" revision. */
  readonly resolved?: boolean;
}

/** Zone of the report samples (stable goldens). */
export const SAMPLE_ZONE = 'Europe/Berlin';

const HOUR = 3_600_000;

/**
 * Figures of the digest sample: a busy day on a small fleet (the research's R3 example).
 *
 * @returns Digest facts for the window that ends at `until`.
 */
export function sampleDigestFacts(until: number, rule: DigestRule): DigestFacts {
  const weekly = rule.every === 'week';
  const span = weekly ? 7 * 24 * HOUR : 24 * HOUR;
  const step = weekly ? 6 * HOUR : HOUR;
  const n = span / step;
  const shape = [
    2, 1, 0, 0, 0, 1, 4, 18, 96, 212, 305, 280, 190, 240, 330, 412, 380, 260, 150, 120, 88, 60, 40,
    23,
  ];
  const values = Array.from(
    { length: n },
    (_, i) => (shape[i % shape.length] ?? 0) * (weekly ? 5 : 1),
  );
  const scale = weekly ? 7 : 1;
  return {
    window: { since: until - span, until },
    sessionsStarted: 12 * scale,
    sessionsLive: 2,
    toolCalls: 3412 * scale,
    errors: 68 * scale,
    previous: { toolCalls: 2980 * scale, errors: 36 * scale },
    attention: {
      created: 4 * scale,
      resolved: 3 * scale,
      rejected: 0,
      timedOut: 1 * scale,
      cancelled: 0,
      pending: 0,
      medianWaitMs: 96_000,
    },
    vault: [
      { result: 'success', count: 8 * scale },
      { result: 'origin_mismatch', count: 1 * scale },
    ],
    blocked: {
      count: 27 * scale,
      topPattern: { pattern: '*.doubleclick.net', count: 19 * scale },
      topDomain: { domain: 'ads.example.net', count: 12 * scale },
    },
    slowest: { tool: 'navigate', p95Ms: 4180, previousP95Ms: 2900 },
    topErrors: [
      { errorCode: 'NAVIGATION_TIMEOUT', tool: 'navigate', count: 31 * scale, sessions: 4 },
      { errorCode: 'ELEMENT_NOT_FOUND', tool: 'click', count: 22 * scale, sessions: 6 },
      { errorCode: 'CAPTCHA_DETECTED', tool: 'navigate', count: 15 * scale, sessions: 2 },
    ],
    degradations: [
      {
        code: 'RETENTION_FAILED',
        severity: 'error',
        message: 'retention sweep failed: database is locked',
        since: until - 6 * HOUR,
      },
    ],
    harnesses: [
      { harness: 'claude-code', sessions: 8 * scale, toolCalls: 2410 * scale, errors: 51 * scale },
      { harness: 'cursor', sessions: 3 * scale, toolCalls: 880 * scale, errors: 15 * scale },
      { harness: 'unknown', sessions: 1 * scale, toolCalls: 122 * scale, errors: 2 * scale },
    ],
    chart: { start: until - span, stepMs: step, values },
  };
}

/**
 * Facts of the anomaly sample: failing tool calls and a request nobody answered.
 *
 * @returns Anomaly facts for the hour that ends at `now`.
 */
export function sampleAnomalyFacts(now: number): AnomalyFacts {
  return {
    window: { since: now - HOUR, until: now },
    toolCalls: 212,
    errors: 72,
    blocked: 18,
    blockedBaselinePerHour: 11,
    attentionWaiting: [{ sessionSlug: 'checkout', waitedMs: 47 * 60_000 }],
    live: 3,
    maxSessions: 10,
    degradations: [],
  };
}

function request(kind: 'attention' | 'vault_confirm', now: number, extra: object) {
  return {
    request_id: REQUEST_ID,
    kind,
    session_id: SAMPLE_SESSION_ID,
    session_slug: 'checkout',
    owner: 'local',
    reason: 'CAPTCHA on the checkout page: please solve it, then resume',
    mode: 'takeover',
    options: null,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: now,
    resolved_at: null,
    deadline_at: null,
    waited_ms: null,
    page_url: 'https://shop.example.com/checkout/payment?step=2',
    tool: 'click',
    event_id: null,
    entry_name: null,
    ...extra,
  };
}

function attentionEvent(now: number): ProducedEvent {
  const payload: DomainEvents['attention.created'] = AttentionCreatedEvent.parse({
    type: 'attention.created',
    request: request('attention', now, {}),
  });
  return { name: 'attention.created', at: now, payload };
}

function attentionResolvedEvent(now: number, at: number): ProducedEvent {
  const payload: DomainEvents['attention.resolved'] = AttentionResolvedEvent.parse({
    type: 'attention.resolved',
    request: request('attention', now, {
      status: 'resolved',
      resolved_by: 'admin',
      resolved_at: at,
      waited_ms: at - now,
    }),
  });
  return { name: 'attention.resolved', at, payload };
}

function vaultEvent(now: number): ProducedEvent {
  const payload: DomainEvents['vault.confirm.created'] = VaultConfirmCreatedEvent.parse({
    type: 'vault.confirm.created',
    request: request('vault_confirm', now, {
      mode: null,
      reason: 'vault_fill',
      entry_name: 'github',
      page_url: 'https://github.com/login',
      tool: 'vault_fill',
    }),
  });
  return { name: 'vault.confirm.created', at: now, payload };
}

function toolEvent(now: number): ProducedEvent {
  const base = ToolCalledEvent.parse({
    type: 'tool.called',
    has_detail: false,
    row: {
      event_id: 'e-00000000000000000000000003',
      session_id: SAMPLE_SESSION_ID,
      tool: 'navigate',
      tab_id: null,
      ok: false,
      error_code: 'NAVIGATION_TIMEOUT',
      error_message: null,
      duration_ms: 30_000,
      result_size_bytes: 0,
      ts: now,
      trace_id: null,
      has_screenshot: false,
    },
  });
  const payload: DomainEvents['tool.called'] = {
    ...base,
    observation: {
      eventId: base.row.event_id,
      sessionId: SAMPLE_SESSION_ID,
      connectionId: null,
      harness: 'claude-code',
      tool: 'navigate',
      tabId: null,
      args: {},
      ok: false,
      errorCode: 'NAVIGATION_TIMEOUT',
      errorMessage: null,
      resultText: null,
      resultSizeBytes: 0,
      durationMs: 30_000,
      ts: now,
      principal: 'local',
      traceId: null,
      spanId: null,
      seq: 3,
    },
  };
  return { name: 'tool.called', at: now, payload };
}

function crashEvent(now: number): ProducedEvent {
  const payload: DomainEvents['session.closed'] = SessionClosedEvent.parse({
    type: 'session.closed',
    session_id: SAMPLE_SESSION_ID,
    closed_at: now,
    reason: 'crash',
  });
  return { name: 'session.closed', at: now, payload };
}

function degradedEvent(now: number): ProducedEvent {
  const payload: DomainEvents['system.degraded'] = SystemDegradedEvent.parse({
    type: 'system.degraded',
    event: {
      event_id: 'e-00000000000000000000000009',
      code: 'RETENTION_FAILED',
      severity: 'error',
      message: 'The retention sweep failed: database is locked',
      details: null,
      first_seen_at: now,
      last_seen_at: now,
      count: 1,
      resolved_at: null,
    },
  });
  return { name: 'system.degraded', at: now, payload };
}

/** The first revision of a producer's draft for `event`, with `count` occurrences. */
function fromEvent(event: ProducedEvent, now: number, count = 1): NotificationMessage {
  const draft = draftFor(event);
  if (draft === null) throw new TypeError(`no draft for ${event.name}`);
  return buildMessage({
    id: SAMPLE_NOTIFICATION_ID,
    revision: count,
    thread: draft.thread,
    kind: draft.kind,
    severity: draft.severity,
    state: draft.state,
    alert: count === 1,
    createdAt: now,
    updatedAt: now + (count - 1) * 20_000,
    title: draft.group === undefined ? draft.title : draft.group.title(count),
    summary: draft.body ?? '',
    ...draft.content(count),
  });
}

/** Inserts a screenshot block after the first quote (or first) block. */
function withImage(
  message: NotificationMessage,
  masked: boolean,
  now: number,
  path: string,
): NotificationMessage {
  const image: Block = {
    type: 'image',
    ref: SAMPLE_IMAGE_REF,
    alt: `Screenshot of session ${SAMPLE_SESSION_ID.replace(/-[0-9a-z]{8}$/, '')}`,
    captured_at: now,
    masked,
    path,
  };
  const quote = message.blocks.findIndex((b) => b.type === 'quote');
  const at = quote >= 0 ? quote + 1 : 0;
  const blocks = [...message.blocks.slice(0, at), image, ...message.blocks.slice(at)];
  return { ...message, blocks, privacy: { ...message.privacy, has_image: true } };
}

function testMessage(now: number): NotificationMessage {
  return buildMessage({
    id: SAMPLE_NOTIFICATION_ID,
    revision: 1,
    thread: 'test:sample',
    kind: 'test',
    severity: 'info',
    state: 'final',
    alert: true,
    createdAt: now,
    updatedAt: now,
    title: 'BrowserHive test message',
    summary:
      'This channel works. Tap "Open dashboard" on your phone to check that links reach BrowserHive.',
    blocks: [
      {
        type: 'fields',
        items: [
          { label: 'Sent', value: [time(now)] },
          { label: 'Kind', value: [{ type: 'code', text: 'test' }] },
        ],
      },
    ],
    actions: [
      {
        kind: 'open',
        id: 'open-dashboard',
        label: 'Open dashboard',
        style: 'primary',
        path: '/notifications/channels',
      },
    ],
    entities: {},
  });
}

function reportContext(now: number, options: SampleOptions) {
  return {
    zone: options.zone ?? SAMPLE_ZONE,
    level: options.level ?? DEFAULT_CONTENT_LEVEL,
    scheduledAt: now,
    late: options.late !== undefined,
    skipped: options.late?.skipped ?? 0,
    manual: false,
    quiet: false,
  };
}

function digestSample(now: number, options: SampleOptions): NotificationMessage {
  const rule: DigestRule = options.digest ?? { every: 'day', at: DEFAULT_DIGEST_AT };
  const ctx = reportContext(now, options);
  const content = buildDigest(sampleDigestFacts(now, rule), rule, ctx);
  return NotificationMessage.parse(
    reportMessage(content, {
      id: SAMPLE_NOTIFICATION_ID,
      thread: `digest:sample:${now}`,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      level: ctx.level,
    }),
  );
}

function anomalySample(now: number, options: SampleOptions): NotificationMessage {
  const facts = sampleAnomalyFacts(now);
  const evaluation = evaluateAnomalies(facts, {}, {}, now);
  const ctx = reportContext(now, options);
  const content =
    options.resolved === true
      ? buildAnomaly(
          { facts, active: {}, fired: [], resolvedSince: now - 2 * HOUR - 5 * 60_000 },
          ctx,
        )
      : buildAnomaly({ facts, active: evaluation.active, fired: evaluation.fired }, ctx);
  return NotificationMessage.parse(
    reportMessage(content, {
      id: SAMPLE_NOTIFICATION_ID,
      thread: 'anomaly:sample',
      revision: options.resolved === true ? 2 : 1,
      createdAt: now,
      updatedAt: now,
      level: ctx.level,
    }),
  );
}

/**
 * A realistic notification of the given sample kind, built through the real producers so a
 * preview or a golden shows exactly what a real notification would carry.
 *
 * @returns The message (validated against the contract).
 */
export function sampleMessage(
  sample: PreviewSample,
  options: SampleOptions = {},
): NotificationMessage {
  const now = options.now ?? SAMPLE_NOW;
  const image = options.image ?? 'none';
  const live = `/sessions/${SAMPLE_SESSION_ID}?live=1`;
  let message: NotificationMessage;
  let imagePath: string | null = null;
  switch (sample) {
    case 'attention':
      message = fromEvent(attentionEvent(now), now);
      imagePath = live;
      break;
    case 'attention-resolved': {
      const first = fromEvent(attentionEvent(now), now);
      const at = now + 130_000;
      const revision = revisionFor(attentionResolvedEvent(now, at));
      if (revision === null) throw new TypeError('no revision for attention.resolved');
      message = reviseMessage(
        image === 'none' ? first : withImage(first, image === 'masked', now, live),
        revision.change,
        at,
      );
      return NotificationMessage.parse(message);
    }
    case 'vault-confirm':
      message = fromEvent(vaultEvent(now), now);
      imagePath = live;
      break;
    case 'tool-errors':
      message = fromEvent(toolEvent(now), now, 3);
      break;
    case 'crash':
      message = fromEvent(crashEvent(now), now);
      imagePath = `/sessions/${SAMPLE_SESSION_ID}`;
      break;
    case 'degraded':
      message = fromEvent(degradedEvent(now), now);
      break;
    case 'test':
      message = testMessage(now);
      break;
    case 'digest':
      return digestSample(now, options);
    case 'anomaly':
      return anomalySample(now, options);
  }
  if (image !== 'none' && imagePath !== null) {
    message = withImage(message, image === 'masked', now, imagePath);
  }
  return NotificationMessage.parse(message);
}
