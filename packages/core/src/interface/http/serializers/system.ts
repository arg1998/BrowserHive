/** @module interface/http/serializers/system — degradations, notifications, log records and config provenance → wire (spec 03 §4.7–4.8). */

import { CONFIG_KEYS } from '@browserhive/contracts/config';
import type {
  LogRecord,
  Notification,
  SystemConfigKey,
  SystemEvent,
} from '@browserhive/contracts/http';
import { LogTransport, REDACTED, SerializedError } from '@browserhive/contracts/http';
import { parseSessionId } from '@browserhive/contracts/ids';
import type { z } from 'zod';
import type { ConfigView } from '../../../app/config/provenance-view.ts';
import type { NotificationRecord, SystemEventRecord } from '../../../ports/persistence/records.ts';
import type { LogEntry } from '../services.ts';

/** One degradation row. */
export function systemEventToWire(record: SystemEventRecord): z.input<typeof SystemEvent> {
  return {
    event_id: record.eventId,
    code: record.code,
    severity: record.severity,
    message: record.message,
    details: record.details,
    first_seen_at: record.firstSeenAt,
    last_seen_at: record.lastSeenAt,
    count: record.count,
    resolved_at: record.resolvedAt,
  };
}

function slugOf(sessionId: string | null): string | null {
  return sessionId === null ? null : (parseSessionId(sessionId)?.slug ?? null);
}

/** One notification. */
export function notificationToWire(record: NotificationRecord): z.input<typeof Notification> {
  return {
    notification_id: record.notificationId,
    principal_id: record.principalId,
    type: record.type,
    title: record.title,
    body: record.body,
    session_id: record.sessionId,
    session_slug: slugOf(record.sessionId),
    target: record.target,
    source_event_id: record.sourceEventId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    count: record.count,
    read_at: record.readAt,
    dismissed_at: record.dismissedAt,
  };
}

/** Reserved record keys typed as plain strings on the wire. */
const STRING_SLOTS: readonly string[] = [
  'trace_id',
  'span_id',
  'request_id',
  'session_id',
  'principal',
];

/** Keys the serializer writes itself. */
const FIXED_KEYS: readonly string[] = ['seq', 'ts', 'level', 'msg', 'module', 'fields'];

function fitsSlot(key: string, value: unknown): boolean {
  if (STRING_SLOTS.includes(key)) return typeof value === 'string';
  if (key === 'transport') return LogTransport.safeParse(value).success;
  if (key === 'err') return SerializedError.safeParse(value).success;
  return true;
}

/**
 * One ring-buffer entry as a wire log record (`seq` is the cursor). Reserved optional keys that
 * are `null` are omitted and values that do not fit their slot move under `fields.<name>`, so one
 * odd record can never fail a whole `GET /logs` page or a `logs` topic frame.
 */
export function logEntryToWire(entry: LogEntry): z.input<typeof LogRecord> {
  const { record } = entry;
  const extra: Record<string, unknown> = {};
  const misfits: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || FIXED_KEYS.includes(key)) continue;
    if (fitsSlot(key, value)) extra[key] = value;
    else if (value !== null) misfits[key] = value;
  }
  const nested = record['fields'];
  const fields: Record<string, unknown> =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? { ...nested, ...misfits }
      : misfits;
  if (record['seq'] !== undefined) fields['seq'] = record['seq'];
  return {
    ...extra,
    ts: record.ts,
    level: record.level,
    msg: record.msg,
    module: record.module,
    ...(Object.keys(fields).length > 0 && { fields }),
    seq: entry.seq,
  };
}

function isRedacted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'redacted' in value;
}

/**
 * `GET /system/config` keys: secrets → `[REDACTED]`, shadowed values kept as rendered text. The
 * variables config-file references used are always named (`refs`); the value as written
 * (`template`) only when the key is not redacted (spec 08 §3.1).
 */
export function configKeysToWire(view: ConfigView): z.input<typeof SystemConfigKey>[] {
  return CONFIG_KEYS.map((key) => {
    const entry = view[key];
    const secret = isRedacted(entry.value);
    return {
      key,
      value: secret ? REDACTED : (entry.value ?? null),
      source: entry.source,
      ...(entry.refs !== undefined && { refs: entry.refs.map((ref) => ({ ...ref })) }),
      ...(entry.template !== undefined && !secret && { template: entry.template }),
      shadowed: entry.shadowed.map((s) => ({
        source: s.source,
        value: secret ? REDACTED : s.value,
        ...(s.refs !== undefined && { refs: s.refs.map((ref) => ({ ...ref })) }),
      })),
      secret,
    };
  });
}
