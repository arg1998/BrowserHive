/** @module app/events/catalog — the DomainEvents map: versioned event names → payload types for every subsystem (spec 01 §5, 03 §6.6). Append-only; other subsystems add their names here. */

import type { ToolName } from '@browserhive/contracts/tools';
import type {
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  BlocklistHitEvent,
  BlocklistReloadedEvent,
  LogRecordEvent,
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
  PageVisitedEvent,
  RetentionCompletedEvent,
  ScreenshotCapturedEvent,
  SessionClosedEvent,
  SessionOpenedEvent,
  SessionRemovedEvent,
  SessionUpdatedEvent,
  SessionWarningEvent,
  SystemCapacityEvent,
  SystemDegradedEvent,
  SystemRecoveredEvent,
  SystemTickEvent,
  ToolCalledEvent,
  VaultAccessEvent,
  VaultBindingChangedEvent,
  VaultConfirmCreatedEvent,
  VaultConfirmResolvedEvent,
  VaultLockStateEvent,
  VaultPolicyChangedEvent,
} from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { DomainEvent } from '../../ports/event-bus.ts';
import type { JsonObject, SessionPatch, SessionRecord } from '../../ports/persistence/records.ts';
import type { AuthEvents } from '../auth/events.ts';

/*
 * Design: every payload that has a WS feed schema *is* that schema's `z.infer` (including its
 * `type` literal), so the WS hub forwards bus payloads untouched (zod strips the internal extras
 * when it validates). Internal-only detail the recorder needs but the wire must not carry rides
 * in additional keys (`record`, `patch`, `observation`, `path`).
 */

/**
 * The one observation the MCP dispatcher emits per terminal tool outcome (spec 02 §2.3). Raw
 * `args`/`resultText` are already key-redacted; the recorder applies the result policy and cap.
 */
export interface ToolObservation {
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly connectionId: string | null;
  readonly tool: ToolName;
  readonly tabId: string | null;
  readonly args: JsonObject;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultText: string | null;
  readonly resultSizeBytes: number;
  readonly durationMs: number;
  readonly ts: number;
  readonly principal: string;
  /**
   * The harness resolved for this call (spec 02 §1.4; `unknown` when none), so consumers such as
   * notification producers can branch on it without a query. Self-reported: never a decision input.
   */
  readonly harness: string;
  readonly traceId: string | null;
  readonly spanId: string | null;
  /** Per-session ordinal assigned by the dispatcher (`tool_calls.seq`). */
  readonly seq: number;
}

/** Payload of the `auth.*` events: the audit row as written (see `app/auth/events.ts`). */
export type { AuthEventPayload } from '../auth/events.ts';

/** Notification state payload for the internal read/dismiss names (the wire uses `notification.updated`). */
export type NotificationStatePayload = z.infer<typeof NotificationUpdatedEvent>['notification'];

/**
 * Event name → payload. A `type` alias (not an interface) so it satisfies the bus's
 * `Record<string, unknown>` constraint.
 */
export type DomainEvents = {
  // sessions (this subsystem)
  readonly 'session.opened': z.infer<typeof SessionOpenedEvent> & {
    readonly record: SessionRecord;
  };
  readonly 'session.updated': z.infer<typeof SessionUpdatedEvent> & {
    readonly patch: SessionPatch;
  };
  readonly 'session.closed': z.infer<typeof SessionClosedEvent>;
  readonly 'session.removed': z.infer<typeof SessionRemovedEvent>;
  readonly 'session.warning': z.infer<typeof SessionWarningEvent>;
  /** D-13: which proxy a session launched with (`null` = direct). Internal; not on the feed. */
  readonly 'session.proxy_assigned': {
    readonly type: 'session.proxy_assigned';
    readonly session_id: string;
    readonly proxy_label: string | null;
    readonly source: 'byo' | 'managed' | null;
  };
  // session facts
  readonly 'tool.called': z.infer<typeof ToolCalledEvent> & {
    readonly observation: ToolObservation;
  };
  readonly 'page.visited': z.infer<typeof PageVisitedEvent>;
  readonly 'screenshot.captured': z.infer<typeof ScreenshotCapturedEvent> & {
    readonly path: string;
  };
  readonly 'blocklist.hit': z.infer<typeof BlocklistHitEvent>;
  readonly 'blocklist.reloaded': z.infer<typeof BlocklistReloadedEvent>;
  readonly 'vault.access': z.infer<typeof VaultAccessEvent>;
  // operator requests
  readonly 'attention.created': z.infer<typeof AttentionCreatedEvent>;
  readonly 'attention.resolved': z.infer<typeof AttentionResolvedEvent>;
  readonly 'vault.confirm.created': z.infer<typeof VaultConfirmCreatedEvent>;
  readonly 'vault.confirm.resolved': z.infer<typeof VaultConfirmResolvedEvent>;
  // vault config
  readonly 'vault.binding.changed': z.infer<typeof VaultBindingChangedEvent>;
  readonly 'vault.policy.changed': z.infer<typeof VaultPolicyChangedEvent>;
  readonly 'vault.lock_state': z.infer<typeof VaultLockStateEvent>;
  // system
  readonly 'system.degraded': z.infer<typeof SystemDegradedEvent>;
  readonly 'system.recovered': z.infer<typeof SystemRecoveredEvent>;
  readonly 'system.tick': z.infer<typeof SystemTickEvent>;
  readonly 'system.capacity': z.infer<typeof SystemCapacityEvent>;
  readonly 'system.status': {
    readonly type: 'system.status';
    readonly status: 'starting' | 'ready' | 'degraded' | 'stopping';
    readonly at: number;
  };
  readonly 'retention.completed': z.infer<typeof RetentionCompletedEvent>;
  // notifications
  readonly 'notification.created': z.infer<typeof NotificationCreatedEvent>;
  readonly 'notification.updated': z.infer<typeof NotificationUpdatedEvent>;
  readonly 'notification.read': {
    readonly type: 'notification.read';
    readonly notification: NotificationStatePayload;
  };
  readonly 'notification.dismissed': {
    readonly type: 'notification.dismissed';
    readonly notification: NotificationStatePayload;
  };
  // logs
  readonly 'log.record': z.infer<typeof LogRecordEvent>;
} & AuthEvents; // auth (audit; never on the public feed): `auth.<auth_events.type>`

/** Every event name. */
export type DomainEventName = keyof DomainEvents;

/** Payload of one event name. */
export type DomainEventPayload<N extends DomainEventName> = DomainEvents[N];

/** A published event of one name. */
export type PublishedEvent<N extends DomainEventName = DomainEventName> = DomainEvent<
  N,
  DomainEvents[N]
>;

/** Extracts the session id an event is scoped to, or `null` for fleet/system events. */
export function sessionIdOf(event: PublishedEvent): string | null {
  const payload: unknown = event.payload;
  if (!isRecord(payload)) return null;
  const record = payload;
  const direct = record['session_id'];
  if (typeof direct === 'string') return direct;
  for (const key of ['session', 'row', 'request', 'notification'] as const) {
    const nested = record[key];
    if (isRecord(nested)) {
      const id = nested['session_id'];
      if (typeof id === 'string') return id;
    }
  }
  return null;
}

/** Structural guard for loosely typed payloads. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
