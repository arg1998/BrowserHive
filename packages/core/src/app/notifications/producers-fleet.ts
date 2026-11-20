/** @module app/notifications/producers-fleet — producer rules of sessions, tools and the system (spec 03 §9.1, D-16, D-32): a session that closed unexpectedly, grouped tool errors, degradations and broken channels. */

import { ERROR_REGISTRY, isErrorCode } from '@browserhive/contracts/errors';
import {
  KIND_SEVERITY,
  type NotificationAction,
  type NotificationEntities,
} from '@browserhive/contracts/notifications';
import type { DomainEvents } from '../events/catalog.ts';
import { code, formatDuration, type MessageContent, text, time } from './message.ts';
import type { NotificationDraft } from './producer-types.ts';
import { sessionEntities, sessionField, sessionLabel } from './producers-requests.ts';

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

/**
 * Heuristic over the free-text close reason: whether it reads as an unexpected death.
 *
 * @returns True for reasons mentioning crash/dead/error/killed.
 */
export function crashed(reason: string): boolean {
  const r = reason.toLowerCase();
  return r.includes('crash') || r.includes('dead') || r.includes('error') || r.includes('killed');
}

export function sessionClosed(d: DomainEvents['session.closed']): NotificationDraft | null {
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

export function toolCalled(payload: DomainEvents['tool.called']): NotificationDraft | null {
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

export function systemDegraded(payload: DomainEvents['system.degraded']): NotificationDraft | null {
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
export function channelChanged(
  d: DomainEvents['notification.channel.changed'],
): NotificationDraft | null {
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
