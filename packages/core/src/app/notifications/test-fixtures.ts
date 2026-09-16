/** @module app/notifications/test-fixtures — schema-parsed bus payloads for the notification suites (test support, not a test). */

import type { ClosedReason } from '@browserhive/contracts/enums';
import type { ToolName } from '@browserhive/contracts/tools';
import {
  AttentionCreatedEvent,
  SessionClosedEvent,
  SystemDegradedEvent,
  ToolCalledEvent,
  VaultConfirmCreatedEvent,
} from '@browserhive/contracts/ws';
import type { DomainEvents } from '../events/catalog.ts';
import type { ProducedEvent } from './producers.ts';

/** A valid session id. */
export const SESSION = 'shop-a1b2c3d4';

/** `e-<ulid>` from an ordinal. */
export function eventId(n: number): string {
  return `e-${String(n).padStart(26, '0')}`;
}

function request(kind: 'attention' | 'vault_confirm', id: string, extra: object) {
  return {
    request_id: id,
    kind,
    session_id: SESSION,
    session_slug: 'shop',
    owner: 'local',
    reason: 'captcha',
    mode: null,
    options: null,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: 1,
    resolved_at: null,
    deadline_at: null,
    waited_ms: null,
    page_url: null,
    tool: null,
    event_id: null,
    entry_name: null,
    ...extra,
  };
}

/** `attention.created`. */
export function attentionCreated(id: string, mode: 'takeover' | 'notify' | null): ProducedEvent {
  const payload: DomainEvents['attention.created'] = AttentionCreatedEvent.parse({
    type: 'attention.created',
    request: request('attention', id, { mode }),
  });
  return { name: 'attention.created', at: 1, payload };
}

/** `vault.confirm.created`. */
export function vaultConfirmCreated(id: string, entry: string): ProducedEvent {
  const payload: DomainEvents['vault.confirm.created'] = VaultConfirmCreatedEvent.parse({
    type: 'vault.confirm.created',
    request: request('vault_confirm', id, { entry_name: entry }),
  });
  return { name: 'vault.confirm.created', at: 1, payload };
}

/** `session.closed`. */
export function sessionClosed(reason: ClosedReason, at = 5): ProducedEvent {
  const payload: DomainEvents['session.closed'] = SessionClosedEvent.parse({
    type: 'session.closed',
    session_id: SESSION,
    closed_at: at,
    reason,
  });
  return { name: 'session.closed', at, payload };
}

/** `tool.called`. */
export function toolCalled(
  n: number,
  opts: { ok: boolean; tool?: ToolName; code?: string | null; sessionId?: string | null },
): ProducedEvent {
  const sessionId = opts.sessionId === undefined ? SESSION : opts.sessionId;
  const base = ToolCalledEvent.parse({
    type: 'tool.called',
    has_detail: false,
    row: {
      event_id: eventId(n),
      session_id: sessionId,
      tool: opts.tool ?? 'navigate',
      tab_id: null,
      ok: opts.ok,
      error_code: opts.code === undefined ? 'NAVIGATION_TIMEOUT' : opts.code,
      error_message: null,
      duration_ms: 1200,
      result_size_bytes: 0,
      ts: n,
      trace_id: null,
      has_screenshot: false,
    },
  });
  const payload: DomainEvents['tool.called'] = {
    ...base,
    observation: {
      eventId: base.row.event_id,
      sessionId,
      connectionId: null,
      tool: opts.tool ?? 'navigate',
      tabId: null,
      args: {},
      ok: opts.ok,
      errorCode: base.row.error_code,
      errorMessage: null,
      resultText: null,
      resultSizeBytes: 0,
      durationMs: 1200,
      ts: n,
      principal: 'local',
      traceId: null,
      spanId: null,
      seq: n,
    },
  };
  return { name: 'tool.called', at: n, payload };
}

/** `system.degraded`. */
export function systemDegraded(severity: 'info' | 'warn' | 'error', n = 1): ProducedEvent {
  const payload: DomainEvents['system.degraded'] = SystemDegradedEvent.parse({
    type: 'system.degraded',
    event: {
      event_id: eventId(n),
      code: 'RETENTION_FAILED',
      severity,
      message: 'retention sweep failed',
      details: null,
      first_seen_at: 1,
      last_seen_at: 1,
      count: 1,
      resolved_at: null,
    },
  });
  return { name: 'system.degraded', at: 1, payload };
}
