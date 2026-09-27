/** @module infra/persistence/mappers/notifications — `notification_channels`, `notification_deliveries` and `notification_channel_messages` rows ↔ records (spec 03 §7). */

import { NotificationChannelRules } from '@browserhive/contracts/notifications';
import type { Insertable, Selectable } from 'kysely';
import {
  NOTIFICATION_CHANNEL_SOURCES,
  NOTIFICATION_CHANNEL_STATUSES,
  NOTIFICATION_DELIVERY_OPS,
  NOTIFICATION_DELIVERY_STATUSES,
} from '../../../ports/persistence/enums.ts';
import type {
  NewNotificationDelivery,
  NotificationChannelMessageRecord,
  NotificationChannelRecord,
  NotificationDeliveryRecord,
  PlatformMessageRef,
} from '../../../ports/persistence/records.ts';
import type {
  NotificationChannelMessages,
  NotificationChannels,
  NotificationDeliveries,
} from '../generated/db.d.ts';
import { parseEnum, parseJsonObject } from './codec.ts';

/** A JSON object column whose values are all strings (target, secret refs). */
function stringMap(text: string, where: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseJsonObject(text, where))) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** A platform ref column: an object of string/number leaves. */
function messageRef(text: string, where: string): PlatformMessageRef {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(parseJsonObject(text, where))) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/** `notification_channels` row → record. Unknown rule keys (a newer release) are dropped. */
export function channelFromRow(row: Selectable<NotificationChannels>): NotificationChannelRecord {
  const where = `notification_channels.${row.channel_id}`;
  const rules = NotificationChannelRules.safeParse(parseJsonObject(row.rules_json, where));
  return {
    channelId: row.channel_id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    source: parseEnum(NOTIFICATION_CHANNEL_SOURCES, row.source, `${where}.source`),
    status: parseEnum(NOTIFICATION_CHANNEL_STATUSES, row.status, `${where}.status`),
    target: stringMap(row.target_json, `${where}.target`),
    secretRefs: stringMap(row.secret_refs_json, `${where}.secret_refs`),
    rules: rules.success ? rules.data : {},
    failureCount: row.failure_count,
    lastError: row.last_error,
    lastOkAt: row.last_ok_at,
    lastFailureAt: row.last_failure_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record → `notification_channels` insert row. */
export function channelToRow(record: NotificationChannelRecord): Insertable<NotificationChannels> {
  return {
    channel_id: record.channelId,
    name: record.name,
    kind: record.kind,
    mode: record.mode,
    source: record.source,
    status: record.status,
    target_json: JSON.stringify(record.target),
    secret_refs_json: JSON.stringify(record.secretRefs),
    rules_json: JSON.stringify(record.rules),
    failure_count: record.failureCount,
    last_error: record.lastError,
    last_ok_at: record.lastOkAt,
    last_failure_at: record.lastFailureAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

/** `notification_deliveries` row → record. */
export function deliveryFromRow(
  row: Selectable<NotificationDeliveries>,
): NotificationDeliveryRecord {
  const seq = row.seq ?? 0;
  const where = `notification_deliveries.${seq}`;
  return {
    seq,
    channelId: row.channel_id,
    notificationId: row.notification_id,
    revision: row.revision,
    op: parseEnum(NOTIFICATION_DELIVERY_OPS, row.op, `${where}.op`),
    status: parseEnum(NOTIFICATION_DELIVERY_STATUSES, row.status, `${where}.status`),
    reason: row.reason,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    durationMs: row.duration_ms,
    messageRef:
      row.message_ref_json === null ? null : messageRef(row.message_ref_json, `${where}.ref`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** New job → `notification_deliveries` insert row. */
export function deliveryToRow(job: NewNotificationDelivery): Insertable<NotificationDeliveries> {
  return {
    channel_id: job.channelId,
    notification_id: job.notificationId,
    revision: job.revision,
    op: job.op,
    status: job.status,
    reason: job.reason,
    attempts: 0,
    next_attempt_at: job.nextAttemptAt,
    last_error: null,
    duration_ms: null,
    message_ref_json: null,
    created_at: job.createdAt,
    updated_at: job.createdAt,
  };
}

/** `notification_channel_messages` row → record. */
export function channelMessageFromRow(
  row: Selectable<NotificationChannelMessages>,
): NotificationChannelMessageRecord {
  return {
    channelId: row.channel_id,
    notificationId: row.notification_id,
    thread: row.thread,
    messageRef: messageRef(
      row.message_ref_json,
      `notification_channel_messages.${row.channel_id}.${row.notification_id}`,
    ),
    lastRevision: row.last_revision,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  };
}

/** Record → `notification_channel_messages` row. */
export function channelMessageToRow(
  record: NotificationChannelMessageRecord,
): Selectable<NotificationChannelMessages> {
  return {
    channel_id: record.channelId,
    notification_id: record.notificationId,
    thread: record.thread,
    message_ref_json: JSON.stringify(record.messageRef),
    last_revision: record.lastRevision,
    sent_at: record.sentAt,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt,
    deleted_at: record.deletedAt,
  };
}
