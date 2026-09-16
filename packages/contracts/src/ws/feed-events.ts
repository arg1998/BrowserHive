/** @module contracts/ws/feed-events — payload schema per feed event name, and the topic → events map (spec 03 §6.6) */
import { z } from 'zod';
import { ClosedReason, DegradationSeverity } from '../enums/index.ts';
import { ScreenshotRow } from '../http/artifacts.ts';
import { OperatorRequestRow } from '../http/attention.ts';
import { BlockedRequestRow } from '../http/blocklist.ts';
import { Count, EpochMs } from '../http/common.ts';
import { LogRecord } from '../http/logs.ts';
import { Notification } from '../http/notifications.ts';
import { PageRow } from '../http/pages.ts';
import { SessionSummary } from '../http/sessions.ts';
import { SystemEvent } from '../http/system.ts';
import { ToolCallRow } from '../http/tool-calls.ts';
import { VaultAccessRow, VaultHandle } from '../http/vault-bindings.ts';
import { SessionId } from '../ids/index.ts';
import type { WsStaticTopic } from './topics.ts';

const ev = <T extends string>(type: T) => ({ type: z.literal(type) });

// sessions ---------------------------------------------------------------------------------------
/** A session row was created (`reserved`/`launching`). */
export const SessionOpenedEvent = z.object({ ...ev('session.opened'), session: SessionSummary });
/** State, url, lease or counts changed (coalesced 250 ms). */
export const SessionUpdatedEvent = z.object({ ...ev('session.updated'), session: SessionSummary });
/** A session reached a terminal state. */
export const SessionClosedEvent = z.object({
  ...ev('session.closed'),
  session_id: SessionId,
  closed_at: EpochMs,
  reason: ClosedReason,
});
/** A session left a list (archived/unarchived/deleted). */
export const SessionRemovedEvent = z.object({
  ...ev('session.removed'),
  session_id: SessionId,
  action: z.enum(['archived', 'unarchived', 'deleted']),
  at: EpochMs,
});
/** Non-fatal per-session warning (e.g. stealth fallback, evaluate disabled fill). */
export const SessionWarningEvent = z.object({
  ...ev('session.warning'),
  session_id: SessionId,
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

// session facts ----------------------------------------------------------------------------------
/** A tool call was recorded; `has_detail` = args/result available via REST. */
export const ToolCalledEvent = z.object({
  ...ev('tool.called'),
  row: ToolCallRow,
  has_detail: z.boolean(),
});
/** A page visit was recorded. */
export const PageVisitedEvent = z.object({ ...ev('page.visited'), row: PageRow });
/** A screenshot was stored. */
export const ScreenshotCapturedEvent = z.object({
  ...ev('screenshot.captured'),
  row: ScreenshotRow,
});
/** A vault access audit row was written (never a secret). */
export const VaultAccessEvent = z.object({ ...ev('vault.access'), row: VaultAccessRow });
/** A request was blocked by the blocklist. */
export const BlocklistHitEvent = z.object({ ...ev('blocklist.hit'), row: BlockedRequestRow });

// operator requests ------------------------------------------------------------------------------
/** An attention request opened. */
export const AttentionCreatedEvent = z.object({
  ...ev('attention.created'),
  request: OperatorRequestRow,
});
/** An attention request settled (any terminal status). */
export const AttentionResolvedEvent = z.object({
  ...ev('attention.resolved'),
  request: OperatorRequestRow,
});
/** A vault fill awaits confirmation. */
export const VaultConfirmCreatedEvent = z.object({
  ...ev('vault.confirm.created'),
  request: OperatorRequestRow,
});
/** A vault confirm settled; deny reason included for operators. */
export const VaultConfirmResolvedEvent = z.object({
  ...ev('vault.confirm.resolved'),
  request: OperatorRequestRow,
});

// vault config -----------------------------------------------------------------------------------
/** A binding was created/updated/removed. */
export const VaultBindingChangedEvent = z.object({
  ...ev('vault.binding.changed'),
  handle: VaultHandle,
  action: z.enum(['created', 'updated', 'removed']),
});
/** A group policy changed (`group_id: null` = ungrouped). */
export const VaultPolicyChangedEvent = z.object({
  ...ev('vault.policy.changed'),
  group_id: z.string().nullable(),
});
/** The backend lock state changed. */
export const VaultLockStateEvent = z.object({ ...ev('vault.lock_state'), unlocked: z.boolean() });

// blocklist --------------------------------------------------------------------------------------
/** The blocklist file was reloaded. */
export const BlocklistReloadedEvent = z.object({
  ...ev('blocklist.reloaded'),
  patterns: Count,
  skipped: Count,
  loaded_at: EpochMs,
});

// system -----------------------------------------------------------------------------------------
/** A degradation was recorded or its count grew. */
export const SystemDegradedEvent = z.object({ ...ev('system.degraded'), event: SystemEvent });
/** A degradation was resolved. */
export const SystemRecoveredEvent = z.object({ ...ev('system.recovered'), event: SystemEvent });
/** Keep-alive sent every 30 s (spec 03 §6.4). */
export const SystemTickEvent = z.object({ ...ev('system.tick'), now: EpochMs });
/** Live session capacity changed. */
export const SystemCapacityEvent = z.object({
  ...ev('system.capacity'),
  live: Count,
  max: Count.nullable(),
});
/** A retention sweep finished. */
export const RetentionCompletedEvent = z.object({
  ...ev('retention.completed'),
  at: EpochMs,
  pruned_rows: Count,
  result: z.enum(['ok', 'partial', 'failed']),
  severity: DegradationSeverity.optional(),
});

// notifications ----------------------------------------------------------------------------------
/** A notification was created for the operator. */
export const NotificationCreatedEvent = z.object({
  ...ev('notification.created'),
  notification: Notification,
});
/** A notification's read/dismissed state changed. */
export const NotificationUpdatedEvent = z.object({
  ...ev('notification.updated'),
  notification: Notification,
});

// logs -------------------------------------------------------------------------------------------
/** One log record from the ring buffer (droppable under backpressure). */
export const LogRecordEvent = z.object({ ...ev('log.record'), record: LogRecord });

/** Every feed event payload, discriminated on `type`. */
export const WsFeedEvent = z.discriminatedUnion('type', [
  SessionOpenedEvent,
  SessionUpdatedEvent,
  SessionClosedEvent,
  SessionRemovedEvent,
  SessionWarningEvent,
  ToolCalledEvent,
  PageVisitedEvent,
  ScreenshotCapturedEvent,
  VaultAccessEvent,
  BlocklistHitEvent,
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  VaultConfirmCreatedEvent,
  VaultConfirmResolvedEvent,
  VaultBindingChangedEvent,
  VaultPolicyChangedEvent,
  VaultLockStateEvent,
  BlocklistReloadedEvent,
  SystemDegradedEvent,
  SystemRecoveredEvent,
  SystemTickEvent,
  SystemCapacityEvent,
  RetentionCompletedEvent,
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
  LogRecordEvent,
]);
/** Every feed event payload. */
export type WsFeedEvent = z.infer<typeof WsFeedEvent>;
/** Feed event name. */
export type WsFeedEventType = WsFeedEvent['type'];

/** Event types published on each static topic (`session:<id>` carries every session-scoped type). */
export const WS_TOPIC_EVENTS: { readonly [T in WsStaticTopic]: readonly WsFeedEventType[] } = {
  sessions: ['session.opened', 'session.updated', 'session.closed', 'session.removed'],
  attention: ['attention.created', 'attention.resolved'],
  'vault.confirm': ['vault.confirm.created', 'vault.confirm.resolved'],
  'vault.config': ['vault.binding.changed', 'vault.policy.changed', 'vault.lock_state'],
  'vault.access': ['vault.access'],
  pages: ['page.visited'],
  blocklist: ['blocklist.hit', 'blocklist.reloaded'],
  system: [
    'system.degraded',
    'system.recovered',
    'system.tick',
    'system.capacity',
    'retention.completed',
  ],
  logs: ['log.record'],
  notifications: ['notification.created', 'notification.updated'],
};

/** Event types published on `session:<id>` topics. */
export const WS_SESSION_TOPIC_EVENTS: readonly WsFeedEventType[] = [
  'session.opened',
  'session.updated',
  'session.closed',
  'session.removed',
  'session.warning',
  'tool.called',
  'page.visited',
  'screenshot.captured',
  'vault.access',
  'blocklist.hit',
  'attention.created',
  'attention.resolved',
  'vault.confirm.created',
  'vault.confirm.resolved',
];
