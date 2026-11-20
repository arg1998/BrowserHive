/** @module app/events/catalog — the DomainEvents map: versioned event names → payload types for every subsystem (spec 01 §5, 03 §6.6). Append-only; other subsystems add their names here. */

import type { ToolName } from '@browserhive/contracts/tools';
import type {
  ActionRecordedEvent,
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  BlocklistHitEvent,
  BlocklistReloadedEvent,
  ChannelChangedEvent,
  ChannelRemovedEvent,
  DeliveryUpdatedEvent,
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
  SitePackChangedEvent,
  SitePackPendingEvent,
  SitePackStatusEvent,
  SystemCapacityEvent,
  SystemDegradedEvent,
  SystemRecoveredEvent,
  SystemTickEvent,
  TemplateChangedEvent,
  TemplateHealthEvent,
  TemplateHostEvent,
  TemplateOperationEvent,
  TemplateProbeEvent,
  TemplateReloginEvent,
  TemplateRemovedEvent,
  TemplateVersionEvent,
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
import type { TemplateHealthState, TemplateVersionReason } from '../../ports/persistence/enums.ts';
import type { JsonObject, SessionPatch, SessionRecord } from '../../ports/persistence/records.ts';
import type { SiteConfirmEvent, SiteGuardHitEvent } from '../../ports/site-guards.ts';
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

/** Payload of `notification.channel.changed` (internal; the channel page arrives later). */
export interface NotificationChannelChangedEvent {
  readonly type: 'notification.channel.changed';
  readonly channel_id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: 'active' | 'paused' | 'broken';
  readonly previous_status: 'active' | 'paused' | 'broken';
  /** Consecutive failures when the status changed. */
  readonly failure_count: number;
  /** Last platform error, already scrubbed. */
  readonly last_error: string | null;
  readonly at: number;
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
  readonly 'retention.completed': z.infer<typeof RetentionCompletedEvent> & {
    /** Rows deleted per table in this pass (internal: the `retention.pruned_rows{table}` metric). */
    readonly prunedByTable?: Readonly<Record<string, number>>;
  };
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
  /** A notification channel's status changed (the breaker opened, D-34). Internal; not on the feed. */
  readonly 'notification.channel.changed': NotificationChannelChangedEvent;
  // channels (the `channels` topic, spec 03 §6.6)
  readonly 'channel.changed': z.infer<typeof ChannelChangedEvent>;
  readonly 'channel.removed': z.infer<typeof ChannelRemovedEvent>;
  readonly 'delivery.updated': z.infer<typeof DeliveryUpdatedEvent>;
  readonly 'action.recorded': z.infer<typeof ActionRecordedEvent>;
  // templates (the `templates` topic, spec 13 §11.3)
  readonly 'template.changed': z.infer<typeof TemplateChangedEvent> & {
    /**
     * Internal (spec 13 §8.6, D34): the identity providers of the template's sites now and when
     * they were read, so the sign-out thread of a removed site goes `final`.
     */
    readonly providers?: { readonly ids: readonly string[]; readonly at: number };
  };
  readonly 'template.removed': z.infer<typeof TemplateRemovedEvent>;
  readonly 'template.host': z.infer<typeof TemplateHostEvent> & {
    /** Internal (the host notifications): the template's names and the state it left. */
    readonly names?: TemplateNames;
    readonly previous_state?: z.infer<typeof TemplateHostEvent>['host']['state'];
  };
  readonly 'template.health': z.infer<typeof TemplateHealthEvent> & {
    /** Internal (the sign-in notifications, spec 13 §8.6): set when a probe changed the state. */
    readonly transition?: SigninTransition;
  };
  readonly 'template.probe': z.infer<typeof TemplateProbeEvent>;
  readonly 'template.relogin': z.infer<typeof TemplateReloginEvent> & {
    /** Internal (`template.relogin_failed`): the template's names, the site's provider, the machine. */
    readonly names?: TemplateNames;
    readonly provider?: string;
    readonly machine?: string;
  };
  readonly 'template.version': z.infer<typeof TemplateVersionEvent>;
  readonly 'template.operation': z.infer<typeof TemplateOperationEvent>;
  /** A checkpoint or version file was written (internal: `browserhive.template.checkpoints{reason}`). */
  readonly 'template.checkpoint.written': {
    readonly type: 'template.checkpoint.written';
    readonly template_id: string;
    readonly reason: 'checkpoint' | TemplateVersionReason;
  };
  /** A challenge seen on an agent's page (internal: `browserhive.site_pack.challenges{kind,action}`). */
  readonly 'site_pack.challenge': SitePackChallengeEvent;
  // site packs (spec 13 §11.3; internal, not on the feed)
  /** One `site_guard_hits` row (the recorder writes it; `browserhive.site_pack.guard_hits` counts it). */
  readonly 'site_pack.guard_hit': SiteGuardHitEvent;
  /** A template site's write confirmation opened or settled (the `site_pack.write_confirm` notification). */
  readonly 'site_pack.confirm': SiteConfirmEvent;
  // site packs (the `site-packs` topic, spec 13 §11.3)
  readonly 'site_pack.changed': z.infer<typeof SitePackChangedEvent>;
  readonly 'site_pack.pending': z.infer<typeof SitePackPendingEvent>;
  readonly 'site_pack.status': z.infer<typeof SitePackStatusEvent> & {
    /** Internal (`site_pack.update_pending`, spec 13 §8.6): what waits for an operator now. */
    readonly updates?: SitePackUpdatesFact;
  };
  // logs
  readonly 'log.record': z.infer<typeof LogRecordEvent>;
} & AuthEvents; // auth (audit; never on the public feed): `auth.<auth_events.type>`

/** Pending pack updates and local files needing approval (internal key of `site_pack.status`). */
export interface SitePackUpdatesFact {
  readonly at: number;
  readonly items: readonly {
    readonly pack_id: string;
    readonly title: string;
    readonly from_version: number | null;
    /** The candidate's version, or the local file's. */
    readonly to_version: number;
    /** The candidate's or the local file's SHA-256 (a new content is a new notification). */
    readonly sha256: string;
    /** Set for a local file: changed since approval, or never approved. */
    readonly local: 'changed' | 'not_approved' | null;
    /** A candidate's classification (spec 13 §9.7; `revoked` for a revocation's fallback); `null` for a local file. */
    readonly classification?: string | null;
  }[];
}

/** A detected challenge (spec 13 §9.5, §11.7); internal, never on the feed. */
export interface SitePackChallengeEvent {
  readonly type: 'site_pack.challenge';
  readonly template_id: string;
  readonly session_id: string;
  readonly site: string;
  readonly kind: 'checkpoint' | 'captcha' | 'reauth' | 'locked' | 'rejected';
  readonly action: 'attention' | 'stop' | 'notify';
}

/** A template's names, carried by internal event keys for notification titles. */
export interface TemplateNames {
  readonly name: string;
  readonly display_name: string;
}

/** A site's sign-in state changed (internal key of `template.health`, spec 13 §8.6). */
export interface SigninTransition {
  readonly template: TemplateNames;
  /** The identity provider whose thread the notification belongs to (the site until packs, T3a). */
  readonly provider: string;
  /** The enabled sites the provider's sign-in covers. */
  readonly covers: readonly string[];
  readonly from: TemplateHealthState;
  readonly to: TemplateHealthState;
  readonly reason: string | null;
  /** Every enabled site of the provider is signed in now. */
  readonly provider_signed_in: boolean;
  /** The machine sign-in windows open on ("Re-login on <machine>"). */
  readonly machine: string;
  readonly at: number;
  /** The agent session that met the challenge (a session challenge, spec 13 §9.5). */
  readonly session_id?: string;
  /** A takeover request was opened on that session (an `attention`/`stop` challenge over http). */
  readonly session_takeover?: boolean;
}

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
