/** @module app/notifications/producers — the pure producer rules (spec 03 §9, D-16): bus event → notification draft or null. */

import type { NotificationType } from '@browserhive/contracts/enums';
import { ERROR_REGISTRY, isErrorCode } from '@browserhive/contracts/errors';
import { parseSessionId } from '@browserhive/contracts/ids';
import { assertNever } from '../../kernel/errors/app-error.ts';
import type { DomainEvent } from '../../ports/event-bus.ts';
import type { DomainEventName, DomainEvents } from '../events/catalog.ts';

/** What a producer rule yields before persistence assigns id, principal and timestamps. */
export interface NotificationDraft {
  readonly type: NotificationType;
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
}

/** How a draft folds into an existing row. */
export interface NotificationGroup {
  /** Group identity within one inbox (`tool-errors:<session_id>`). */
  readonly key: string;
  /** Title of the row once it holds `count` occurrences. */
  readonly title: (count: number) => string;
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
  'session.closed',
  'tool.called',
  'vault.confirm.created',
  'system.degraded',
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
 * @returns The draft, or `null` for deliberately silent events (opened, page, removed, resolved…).
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
    default:
      return assertNever(event);
  }
}

function attentionCreated(payload: DomainEvents['attention.created']): NotificationDraft {
  const d = payload.request;
  return {
    type: 'attention',
    title: 'Attention requested',
    body: `${d.reason}${d.mode ? ` · ${d.mode}` : ''} — agent blocked, lease frozen`,
    sessionId: d.session_id,
    target: `/sessions/${d.session_id}?live=1${d.mode === 'takeover' ? '&takeover=1' : ''}`,
    sourceEventId: d.request_id,
    dedupKey: `att:${d.request_id}`,
  };
}

function sessionClosed(d: DomainEvents['session.closed']): NotificationDraft | null {
  if (d.reason === 'lease_expired') {
    return {
      type: 'lifecycle',
      title: 'Session reaped (lease expired)',
      body: `reason: ${d.reason}`,
      sessionId: d.session_id,
      target: `/sessions/${d.session_id}`,
      sourceEventId: null,
      dedupKey: `closed:${d.session_id}:${d.closed_at}`,
    };
  }
  // A clean close (an operator or the agent ended it) is routine; only an unexpected death is
  // worth surfacing. Session launches and normal closes are intentionally not notified.
  if (!crashed(d.reason)) return null;
  return {
    type: 'error',
    title: 'Session crashed',
    body: `reason: ${d.reason}`,
    sessionId: d.session_id,
    target: `/sessions/${d.session_id}`,
    sourceEventId: null,
    dedupKey: `closed:${d.session_id}:${d.closed_at}`,
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
  const label =
    sessionId === null ? NO_SESSION_LABEL : (parseSessionId(sessionId)?.slug ?? sessionId);
  return {
    type: 'error',
    title: toolErrorsTitle(label, 1),
    body: `${d.tool} · ${d.error_code ?? 'failed'} (${d.duration_ms} ms)`,
    sessionId,
    target: sessionId === null ? null : `/sessions/${sessionId}?kinds=tool&errors_only=1`,
    sourceEventId: d.event_id,
    dedupKey: `err:${d.event_id}`,
    group: {
      key: `tool-errors:${sessionId ?? 'none'}`,
      title: (count) => toolErrorsTitle(label, count),
    },
  };
}

function vaultConfirmCreated(payload: DomainEvents['vault.confirm.created']): NotificationDraft {
  const d = payload.request;
  return {
    type: 'vault',
    title: 'Vault fill awaiting confirm',
    body: `entry ${d.entry_name ?? ''} — approve or deny the release`,
    sessionId: d.session_id,
    // Send the operator to the vault page's confirm-release queue, where they approve/deny.
    target: '/vault?tab=confirm',
    sourceEventId: d.request_id,
    dedupKey: `vault:${d.request_id}`,
  };
}

function systemDegraded(payload: DomainEvents['system.degraded']): NotificationDraft | null {
  const e = payload.event;
  if (e.severity !== 'error') return null;
  return {
    type: 'system',
    title: e.message,
    body: e.code,
    sessionId: null,
    target: '/system',
    sourceEventId: e.event_id,
    dedupKey: `sys:${e.event_id}`,
  };
}
