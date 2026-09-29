/** @module app/notifications/producers — the pure producer rules (spec 03 §9.1, D-16, D-32): bus event → notification draft (with its contract content) or a lifecycle revision of an existing thread, or null. */

import type {
  NotificationKind,
  NotificationSeverity,
  NotificationState,
  NotificationType,
} from '@browserhive/contracts/enums';
import { ERROR_REGISTRY, isErrorCode } from '@browserhive/contracts/errors';
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { parseSessionId } from '@browserhive/contracts/ids';
import {
  type Block,
  KIND_SEVERITY,
  type NotificationAction,
  type NotificationEntities,
} from '@browserhive/contracts/notifications';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { sanitizeUrl } from '../../kernel/url.ts';
import type { DomainEvent } from '../../ports/event-bus.ts';
import type { DomainEventName, DomainEvents } from '../events/catalog.ts';
import {
  code,
  formatDuration,
  type LifecycleChange,
  link,
  type MessageContent,
  text,
  time,
} from './message.ts';

/** What a producer rule yields before persistence assigns id, principal and timestamps. */
export interface NotificationDraft {
  readonly type: NotificationType;
  /** Contract kind (D-32); category follows from it. */
  readonly kind: NotificationKind;
  readonly severity: NotificationSeverity;
  /** State of the first revision (`open` for requests and groups, `final` for one-shot facts). */
  readonly state: NotificationState;
  /** Conversation key (`attention:<request_id>`, `session:<id>`, `tool-errors:<session|none>`). */
  readonly thread: string;
  readonly title: string;
  readonly body: string | null;
  readonly sessionId: string | null;
  /** Dashboard route to open on click. */
  readonly target: string | null;
  /** Id of the originating event/request (for de-duplication across reconnect replays). */
  readonly sourceEventId: string | null;
  /** Idempotency key (`att:<id>`, `closed:<id>:<at>`, `err:<event>`, `vault:<id>`). */
  readonly dedupKey: string;
  /** When set, occurrences fold into one open row of the group instead of new rows (spec 03 §9). */
  readonly group?: NotificationGroup;
  /** Blocks, actions and entities of the message for a row holding `count` occurrences (1 unless grouped). */
  readonly content: (count: number) => MessageContent;
  /**
   * A screenshot this notification may carry (D-36): `live` captures the session's page now
   * (attention, vault confirm: before the fill starts), `last` uses its last stored screenshot (a
   * crash). Taken only when a channel wants it (spec 03 §9.5).
   */
  readonly image?: ImageRequest;
}

/** What screenshot a draft asks for. */
export interface ImageRequest {
  readonly sessionId: string;
  readonly source: 'live' | 'last';
  /** Alt text of the image block. */
  readonly alt: string;
  /** Dashboard page that shows the context (used where a channel cannot carry images). */
  readonly path: string;
}

/** How a draft folds into an existing row. */
export interface NotificationGroup {
  /** Group identity within one inbox (`tool-errors:<session_id>`). */
  readonly key: string;
  /** Title of the row once it holds `count` occurrences. */
  readonly title: (count: number) => string;
}

/** A lifecycle revision of the notification that owns `thread` (spec 03 §9.1). */
export interface ThreadRevision {
  readonly thread: string;
  readonly change: LifecycleChange;
  /** Idempotency key of the revision (`att-res:<id>`). */
  readonly dedupKey: string;
}

/** A group row stops growing once it has been idle this long (a new failure starts a new row). */
export const NOTIFICATION_GROUP_IDLE_MS = 5 * 60_000;
/** A group row stops growing once it is this old, so a long failing run surfaces again hourly. */
export const NOTIFICATION_GROUP_MAX_AGE_MS = 60 * 60_000;

/** Group-key and title label of tool errors that happened outside any session. */
export const NO_SESSION_LABEL = 'No session';

/**
 * Title of a session's tool-error group.
 *
 * @returns `"<slug> · 1 tool error"` / `"<slug> · <n> tool errors"`.
 */
export function toolErrorsTitle(slug: string, count: number): string {
  return `${slug} · ${count} tool error${count === 1 ? '' : 's'}`;
}

/** True for failures the agent fixes by changing its arguments (`retryable: different_args`). */
function isCallerMistake(code: string | null): boolean {
  return code !== null && isErrorCode(code) && ERROR_REGISTRY[code].retryable === 'different_args';
}

/** Bus events the producer subscribes to. */
export const PRODUCED_EVENTS = [
  'attention.created',
  'attention.resolved',
  'session.closed',
  'tool.called',
  'vault.confirm.created',
  'vault.confirm.resolved',
  'system.degraded',
  'system.recovered',
  'notification.channel.changed',
] as const satisfies readonly DomainEventName[];

/** Element of {@link PRODUCED_EVENTS}. */
export type ProducedEventName = (typeof PRODUCED_EVENTS)[number];

/**
 * Heuristic over the free-text close reason: whether it reads as an unexpected death.
 *
 * @returns True for reasons mentioning crash/dead/error/killed.
 */
export function crashed(reason: string): boolean {
  const r = reason.toLowerCase();
  return r.includes('crash') || r.includes('dead') || r.includes('error') || r.includes('killed');
}

/** One published event of a produced name, distributed so `switch (event.name)` narrows the payload. */
export type ProducedEvent = {
  [N in ProducedEventName]: DomainEvent<N, DomainEvents[N]>;
}[ProducedEventName];

/**
 * Applies the producer table to one event.
 *
 * @returns The draft, or `null` for deliberately silent events and for events that only revise an
 * existing notification (see {@link revisionFor}).
 */
export function draftFor(event: ProducedEvent): NotificationDraft | null {
  switch (event.name) {
    case 'attention.created':
      return attentionCreated(event.payload);
    case 'session.closed':
      return sessionClosed(event.payload);
    case 'tool.called':
      return toolCalled(event.payload);
    case 'vault.confirm.created':
      return vaultConfirmCreated(event.payload);
    case 'system.degraded':
      return systemDegraded(event.payload);
    case 'notification.channel.changed':
      return channelChanged(event.payload);
    case 'attention.resolved':
    case 'vault.confirm.resolved':
    case 'system.recovered':
      return null;
    default:
      return assertNever(event);
  }
}

/**
 * Applies the revision table to one event: a resolved request or a recovered degradation revises
 * the notification of its thread (spec 03 §9.1).
 *
 * @returns The revision, or `null` for events that create or say nothing.
 */
export function revisionFor(event: ProducedEvent): ThreadRevision | null {
  switch (event.name) {
    case 'attention.resolved':
      return requestSettled('attention', factsOf(event.payload.request));
    case 'vault.confirm.resolved':
      return requestSettled('vault', factsOf(event.payload.request));
    case 'system.recovered': {
      const e = event.payload.event;
      return {
        thread: `system:${e.event_id}`,
        dedupKey: `sys-rec:${e.event_id}:${e.resolved_at ?? 0}`,
        change: {
          state: 'resolved',
          summary: `Recovered: ${e.message}`,
          fields:
            e.resolved_at === null ? [] : [{ label: 'Recovered', value: [time(e.resolved_at)] }],
        },
      };
    }
    default:
      return null;
  }
}

function sessionLabel(sessionId: string): string {
  return parseSessionId(sessionId)?.slug ?? sessionId;
}

function sessionEntities(sessionId: string | null): NotificationEntities {
  if (sessionId === null) return {};
  return { session_id: sessionId, session_slug: sessionLabel(sessionId) };
}

function sessionField(sessionId: string) {
  return { label: 'Session', value: [link(sessionLabel(sessionId), `/sessions/${sessionId}`)] };
}

/** Hostname of a sanitized page URL, for routing (`entities.domain`). */
function domainOf(pageUrl: string | null): string | undefined {
  if (pageUrl === null) return undefined;
  try {
    const host = new URL(pageUrl).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Page, tool and wait fields shared by attention and vault confirm requests. */
function requestFields(d: OperatorRequestRow) {
  return [
    sessionField(d.session_id),
    ...(d.page_url === null ? [] : [{ label: 'Page', value: [code(sanitizeUrl(d.page_url))] }]),
    ...(d.tool === null ? [] : [{ label: 'Tool', value: [code(d.tool)] }]),
    { label: 'Waiting since', value: [time(d.created_at)] },
  ];
}

function requestEntities(d: OperatorRequestRow): NotificationEntities {
  const domain = domainOf(d.page_url);
  return {
    ...sessionEntities(d.session_id),
    owner: d.owner,
    request_id: d.request_id,
    ...(d.tool !== null && { tool: d.tool }),
    ...(domain !== undefined && { domain }),
  };
}

function attentionCreated(payload: DomainEvents['attention.created']): NotificationDraft {
  const d = payload.request;
  const live = `/sessions/${d.session_id}?live=1`;
  const takeover = d.mode === 'takeover';
  const actions: NotificationAction[] = [
    takeover
      ? {
          kind: 'open',
          id: 'take-over',
          label: 'Take over',
          style: 'primary',
          path: `${live}&takeover=1`,
        }
      : { kind: 'open', id: 'open-live', label: 'Open live view', style: 'primary', path: live },
    {
      kind: 'act',
      id: 'resolve',
      label: 'Mark resolved',
      style: 'default',
      command: { op: 'attention.resolve', args: { request_id: d.request_id, decision: 'resolve' } },
      confirm: null,
      fallback: { label: 'Open in BrowserHive', path: live },
    },
    {
      kind: 'act',
      id: 'reject',
      label: 'Reject',
      style: 'danger',
      command: { op: 'attention.resolve', args: { request_id: d.request_id, decision: 'reject' } },
      confirm: 'Reject this request? The agent is told it was rejected.',
      fallback: { label: 'Open in BrowserHive', path: live },
    },
  ];
  const blocks: Block[] = [
    { type: 'quote', content: [text(d.reason)], collapsible: true },
    {
      type: 'fields',
      items: [{ label: 'Mode', value: [text(d.mode ?? 'notify')] }, ...requestFields(d)],
    },
  ];
  return {
    type: 'attention',
    kind: 'attention.requested',
    severity: KIND_SEVERITY['attention.requested'],
    state: 'open',
    thread: `attention:${d.request_id}`,
    title: 'Attention requested',
    body: `${d.reason}${d.mode ? ` · ${d.mode}` : ''} — agent blocked, lease frozen`,
    sessionId: d.session_id,
    target: `/sessions/${d.session_id}?live=1${takeover ? '&takeover=1' : ''}`,
    sourceEventId: d.request_id,
    dedupKey: `att:${d.request_id}`,
    content: () => ({ blocks, actions, entities: requestEntities(d) }),
    image: {
      sessionId: d.session_id,
      source: 'live',
      alt: 'The page when the agent asked for attention',
      path: live,
    },
  };
}

function vaultConfirmCreated(payload: DomainEvents['vault.confirm.created']): NotificationDraft {
  const d = payload.request;
  const queue = '/vault?tab=confirm';
  const entry = d.entry_name ?? '';
  const actions: NotificationAction[] = [
    {
      kind: 'act',
      id: 'approve',
      label: 'Approve',
      style: 'primary',
      command: {
        op: 'vault.confirm.resolve',
        args: { request_id: d.request_id, decision: 'approve' },
      },
      confirm: null,
      fallback: { label: 'Review in BrowserHive', path: queue },
    },
    {
      kind: 'act',
      id: 'deny',
      label: 'Deny',
      style: 'danger',
      command: {
        op: 'vault.confirm.resolve',
        args: { request_id: d.request_id, decision: 'deny' },
      },
      confirm: 'Deny this vault fill?',
      fallback: { label: 'Review in BrowserHive', path: queue },
    },
    { kind: 'open', id: 'review', label: 'Review', style: 'default', path: queue },
  ];
  const blocks: Block[] = [
    {
      type: 'fields',
      items: [{ label: 'Entry', value: [code(entry)] }, ...requestFields(d)],
    },
  ];
  return {
    type: 'vault',
    kind: 'vault.confirm',
    severity: KIND_SEVERITY['vault.confirm'],
    state: 'open',
    thread: `vault:${d.request_id}`,
    title: 'Vault fill awaiting confirm',
    body: `entry ${entry} — approve or deny the release`,
    sessionId: d.session_id,
    // Send the operator to the vault page's confirm-release queue, where they approve/deny.
    target: queue,
    sourceEventId: d.request_id,
    dedupKey: `vault:${d.request_id}`,
    content: () => ({ blocks, actions, entities: requestEntities(d) }),
    // Captured when the confirmation is created: the fill waits for it, so this is before the
    // fill sequence starts (D-36); the capture refuses while a secret window is open.
    image: {
      sessionId: d.session_id,
      source: 'live',
      alt: 'The login page before the fill',
      path: `/sessions/${d.session_id}`,
    },
  };
}

/** What the revision of a settled operator request is built from (a wire row or a stored record). */
export interface SettledRequestFacts {
  readonly requestId: string;
  readonly status: OperatorRequestRow['status'];
  readonly resolvedBy: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly waitedMs: number | null;
}

function factsOf(d: OperatorRequestRow): SettledRequestFacts {
  return {
    requestId: d.request_id,
    status: d.status,
    resolvedBy: d.resolved_by,
    createdAt: d.created_at,
    resolvedAt: d.resolved_at,
    waitedMs: d.waited_ms,
  };
}

/**
 * Outcome of a settled operator request as a lifecycle change: resolved/approved and
 * rejected/denied → `resolved`, a timeout → `expired`, cancelled → `final`. Serves the live
 * `*.resolved` events and the startup catch-up of requests settled while nothing listened.
 *
 * @returns The revision of the request's thread, or `null` while it is pending.
 */
export function requestSettled(
  prefix: 'attention' | 'vault',
  f: SettledRequestFacts,
): ThreadRevision | null {
  if (f.status === 'pending') return null;
  const waited = f.waitedMs ?? (f.resolvedAt === null ? null : f.resolvedAt - f.createdAt);
  const after = waited === null ? '' : ` after ${formatDuration(waited)}`;
  // Orphan recovery and shutdown settle a request with no actor: the summary names none.
  const by = f.resolvedBy === null ? '' : ` by ${f.resolvedBy}`;
  const vault = prefix === 'vault';
  const outcome: { state: NotificationState; label: string; summary: string } = (() => {
    switch (f.status) {
      case 'resolved':
        return {
          state: 'resolved',
          label: vault ? 'approved' : 'resolved',
          summary: `${vault ? 'Approved' : 'Resolved'}${by}${after}`,
        };
      case 'rejected':
        return {
          state: 'resolved',
          label: vault ? 'denied' : 'rejected',
          summary: `${vault ? 'Denied' : 'Rejected'}${by}${after}`,
        };
      case 'timeout':
        return { state: 'expired', label: 'timed out', summary: `Timed out${after}` };
      case 'cancelled':
        return {
          state: 'final',
          label: 'cancelled',
          summary: `Cancelled${after}: the agent stopped waiting`,
        };
    }
  })();
  return {
    thread: `${prefix}:${f.requestId}`,
    dedupKey: `${prefix}-res:${f.requestId}`,
    change: {
      state: outcome.state,
      summary: outcome.summary,
      fields: [
        { label: 'Outcome', value: [text(outcome.label)] },
        ...(f.resolvedAt === null ? [] : [{ label: 'Settled', value: [time(f.resolvedAt)] }]),
      ],
    },
  };
}

function sessionClosed(d: DomainEvents['session.closed']): NotificationDraft | null {
  const open: NotificationAction[] = [
    {
      kind: 'open',
      id: 'open-session',
      label: 'Open session',
      style: 'primary',
      path: `/sessions/${d.session_id}`,
    },
  ];
  const content = (): MessageContent => ({
    blocks: [
      {
        type: 'fields',
        items: [
          sessionField(d.session_id),
          { label: 'Reason', value: [code(d.reason)] },
          { label: 'Closed', value: [time(d.closed_at)] },
        ],
      },
    ],
    actions: open,
    entities: sessionEntities(d.session_id),
  });
  if (d.reason === 'lease_expired') {
    return {
      type: 'lifecycle',
      kind: 'session.reaped',
      severity: KIND_SEVERITY['session.reaped'],
      state: 'final',
      thread: `session:${d.session_id}`,
      title: 'Session reaped (lease expired)',
      body: `reason: ${d.reason}`,
      sessionId: d.session_id,
      target: `/sessions/${d.session_id}`,
      sourceEventId: null,
      dedupKey: `closed:${d.session_id}:${d.closed_at}`,
      content,
    };
  }
  // A clean close (an operator or the agent ended it) is routine; only an unexpected death is
  // worth surfacing. Session launches and normal closes are intentionally not notified.
  if (!crashed(d.reason)) return null;
  return {
    type: 'error',
    kind: 'session.crashed',
    severity: KIND_SEVERITY['session.crashed'],
    state: 'final',
    thread: `session:${d.session_id}`,
    title: 'Session crashed',
    body: `reason: ${d.reason}`,
    sessionId: d.session_id,
    target: `/sessions/${d.session_id}`,
    sourceEventId: null,
    dedupKey: `closed:${d.session_id}:${d.closed_at}`,
    content,
    image: {
      sessionId: d.session_id,
      source: 'last',
      alt: 'The last screenshot before the crash',
      path: `/sessions/${d.session_id}`,
    },
  };
}

function toolCalled(payload: DomainEvents['tool.called']): NotificationDraft | null {
  const d = payload.row;
  if (d.ok) return null; // only failures are noteworthy
  const sessionId = d.session_id;
  // Outside a session, a caller mistake (bad arguments, unknown session id) has nothing for the
  // operator to open or fix; the tool-call log keeps it. Other session-less failures (a launch that
  // could not start a browser) still reach the inbox, grouped under "No session".
  if (sessionId === null && isCallerMistake(d.error_code)) return null;
  const label = sessionId === null ? NO_SESSION_LABEL : sessionLabel(sessionId);
  const target = sessionId === null ? null : `/sessions/${sessionId}?kinds=tool&errors_only=1`;
  const harness = payload.observation.harness;
  const entities: NotificationEntities = {
    ...sessionEntities(sessionId),
    tool: d.tool,
    ...(d.error_code !== null && { error_code: d.error_code }),
    harness,
  };
  return {
    type: 'error',
    kind: 'tool.errors',
    severity: KIND_SEVERITY['tool.errors'],
    state: 'open',
    thread: `tool-errors:${sessionId ?? 'none'}`,
    title: toolErrorsTitle(label, 1),
    body: `${d.tool} · ${d.error_code ?? 'failed'} (${d.duration_ms} ms)`,
    sessionId,
    target,
    sourceEventId: d.event_id,
    dedupKey: `err:${d.event_id}`,
    group: {
      key: `tool-errors:${sessionId ?? 'none'}`,
      title: (count) => toolErrorsTitle(label, count),
    },
    content: (count) => ({
      blocks: [
        {
          type: 'fields',
          items: [
            sessionId === null
              ? { label: 'Session', value: [text(NO_SESSION_LABEL)] }
              : sessionField(sessionId),
            { label: 'Errors', value: [text(String(count))] },
            { label: 'Latest', value: [code(`${d.tool} · ${d.error_code ?? 'failed'}`)] },
            { label: 'Duration', value: [text(formatDuration(d.duration_ms))] },
          ],
        },
      ],
      actions:
        target === null
          ? []
          : [
              {
                kind: 'open',
                id: 'open-errors',
                label: 'Open errors',
                style: 'primary',
                path: target,
              },
            ],
      entities,
    }),
  };
}

function systemDegraded(payload: DomainEvents['system.degraded']): NotificationDraft | null {
  const e = payload.event;
  if (e.severity !== 'error') return null;
  return {
    type: 'system',
    kind: 'system.degraded',
    severity: KIND_SEVERITY['system.degraded'],
    state: 'open',
    thread: `system:${e.event_id}`,
    title: e.message,
    body: e.code,
    sessionId: null,
    target: '/system',
    sourceEventId: e.event_id,
    dedupKey: `sys:${e.event_id}`,
    content: () => ({
      blocks: [
        {
          type: 'fields',
          items: [
            { label: 'Code', value: [code(e.code)] },
            { label: 'Since', value: [time(e.first_seen_at)] },
          ],
        },
      ],
      actions: [
        {
          kind: 'open',
          id: 'open-system',
          label: 'Open System',
          style: 'primary',
          path: '/system',
        },
      ],
      entities: { error_code: e.code },
    }),
  };
}

/**
 * The circuit breaker opened on a channel (D-34). Delivered in-app only: `channel.broken` is never
 * enqueued for an external channel, which cuts the degradation loop by kind.
 */
function channelChanged(d: DomainEvents['notification.channel.changed']): NotificationDraft | null {
  if (d.status !== 'broken' || d.previous_status === 'broken') return null;
  const reason = d.last_error ?? 'unknown error';
  return {
    type: 'system',
    kind: 'channel.broken',
    severity: KIND_SEVERITY['channel.broken'],
    state: 'final',
    thread: `channel:${d.channel_id}`,
    title: `Notification channel ${d.name} is failing`,
    body: `${d.failure_count} deliveries failed in a row; paused until resumed. Last error: ${reason}`,
    sessionId: null,
    target: '/notifications',
    sourceEventId: null,
    dedupKey: `channel:${d.channel_id}:${d.at}`,
    content: () => ({
      blocks: [
        {
          type: 'fields',
          items: [
            { label: 'Channel', value: [text(d.name)] },
            { label: 'Platform', value: [text(d.kind)] },
            { label: 'Failures', value: [text(String(d.failure_count))] },
          ],
        },
        { type: 'code', text: reason, language: null },
      ],
      actions: [],
      entities: {},
    }),
  };
}
