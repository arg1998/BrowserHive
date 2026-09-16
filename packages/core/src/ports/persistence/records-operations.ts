/** @module ports/persistence/records-operations — notification, preference, system event, artifact outbox, idempotency and log records. */

import type { ArtifactKind, NotificationType, SystemEventSeverity } from './enums.ts';
import type { JsonObject, JsonValue } from './json.ts';

// --- notifications, preferences ---------------------------------------------------------------

/** An in-app notification (`notifications`, D-16). */
export interface NotificationRecord {
  readonly notificationId: string;
  readonly principalId: string | null;
  readonly type: NotificationType;
  readonly title: string;
  readonly body: string | null;
  readonly sessionId: string | null;
  readonly target: string | null;
  readonly sourceEventId: string | null;
  readonly createdAt: number;
  /** Latest occurrence folded into the row; equals `createdAt` when `count` is 1. */
  readonly updatedAt: number;
  /** Occurrences folded into the row (≥ 1). */
  readonly count: number;
  /** Coalescing group (`tool-errors:<session_id>`), or `null` for a one-off notification. */
  readonly groupKey: string | null;
  readonly readAt: number | null;
  readonly dismissedAt: number | null;
}

/** What folding one more occurrence into an open group row changes. */
export interface NotificationGroupPatch {
  readonly title: string;
  readonly body: string | null;
  readonly target: string | null;
  readonly sourceEventId: string | null;
  readonly count: number;
  readonly updatedAt: number;
}

/** One preference entry (`preferences`). */
export interface PreferenceRecord {
  readonly principalId: string;
  readonly key: string;
  readonly value: JsonValue;
  readonly updatedAt: number;
}

// --- operations -------------------------------------------------------------------------------

/** A degradation row (`system_events`, spec 10 §3). */
export interface SystemEventRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly code: string;
  readonly severity: SystemEventSeverity;
  readonly message: string;
  readonly details: JsonObject | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly count: number;
  readonly resolvedAt: number | null;
}

/**
 * Input for {@link SystemEventRecord}. Repeats are aggregated under one open row keyed by
 * `code` + the serialised `details` (so producers put only stable keys in `details`).
 */
export interface NewSystemEvent {
  readonly eventId: string;
  readonly code: string;
  readonly severity: SystemEventSeverity;
  readonly message: string;
  readonly details: JsonObject | null;
  readonly at: number;
}

/** A file scheduled for deletion (`artifact_outbox`). */
export interface ArtifactOutboxRecord {
  readonly outboxId: number;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly sessionId: string | null;
  readonly enqueuedAt: number;
  readonly attempts: number;
  readonly lastError: string | null;
}

/** Input for {@link ArtifactOutboxRecord}. */
export type NewArtifact = Pick<ArtifactOutboxRecord, 'kind' | 'path' | 'sessionId' | 'enqueuedAt'>;

/** A remembered bulk-request response (`idempotency_keys`). */
export interface IdempotencyRecord {
  readonly key: string;
  readonly principalId: string;
  readonly route: string;
  readonly response: JsonValue;
  readonly createdAt: number;
}

/** A durable log record (`logs`, optional sink). */
export interface LogRecordRow {
  readonly seq: number;
  readonly ts: number;
  readonly level: string;
  readonly module: string;
  readonly msg: string;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly principal: string | null;
  readonly fields: JsonObject | null;
}
