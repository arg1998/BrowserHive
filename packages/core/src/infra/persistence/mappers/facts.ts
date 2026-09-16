/** @module infra/persistence/mappers/facts — tool_calls, pages, screenshots, vault_access, blocked_requests, events rows ↔ records. */

import type { Insertable, Selectable } from 'kysely';
import {
  ACTOR_KINDS,
  BLOCK_SOURCES,
  ORIGIN_CHECKS,
  PAGE_CATEGORIES,
  SCREENSHOT_KINDS,
  VAULT_ACCESS_RESULTS,
} from '../../../ports/persistence/enums.ts';
import type {
  BlockedRequestRecord,
  EventRecord,
  NewEvent,
  PageRecord,
  ScreenshotRecord,
  ToolCallRecord,
  VaultAccessRecord,
} from '../../../ports/persistence/records.ts';
import type {
  BlockedRequests,
  Events,
  Pages,
  Screenshots,
  ToolCalls,
  VaultAccess,
} from '../generated/db.d.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseJsonObject,
  parseJsonObjectOrNull,
  toJson,
  toJsonOrNull,
} from './codec.ts';

/** `tool_calls` row → record. */
export function toolCallFromRow(row: Selectable<ToolCalls>): ToolCallRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    connectionId: row.connection_id,
    tool: row.tool,
    tabId: row.tab_id,
    args: parseJsonObject(row.args_json, `tool_calls.${row.event_id}`),
    ok: intToBool(row.ok),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultText: row.result_text,
    resultSizeBytes: row.result_size_bytes,
    durationMs: row.duration_ms,
    ts: row.ts,
    traceId: row.trace_id,
    spanId: row.span_id,
    seq: row.seq,
  };
}

/** Record → `tool_calls` insert row. */
export function toolCallToRow(record: ToolCallRecord): Selectable<ToolCalls> {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    connection_id: record.connectionId,
    tool: record.tool,
    tab_id: record.tabId,
    args_json: toJson(record.args),
    ok: boolToInt(record.ok),
    error_code: record.errorCode,
    error_message: record.errorMessage,
    result_text: record.resultText,
    result_size_bytes: record.resultSizeBytes,
    duration_ms: record.durationMs,
    ts: record.ts,
    trace_id: record.traceId,
    span_id: record.spanId,
    seq: record.seq,
  };
}

/** `pages` row → record. */
export function pageFromRow(row: Selectable<Pages>): PageRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    tabId: row.tab_id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    category: parseEnum(PAGE_CATEGORIES, row.category, `pages.${row.event_id}`),
    ts: row.ts,
  };
}

/** Record → `pages` insert row. */
export function pageToRow(record: PageRecord): Selectable<Pages> {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    tab_id: record.tabId,
    url: record.url,
    title: record.title,
    domain: record.domain,
    category: record.category,
    ts: record.ts,
  };
}

/** `screenshots` row → record. */
export function screenshotFromRow(row: Selectable<Screenshots>): ScreenshotRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    path: row.path,
    kind: parseEnum(SCREENSHOT_KINDS, row.kind, `screenshots.${row.event_id}`),
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    ts: row.ts,
  };
}

/** Record → `screenshots` insert row. */
export function screenshotToRow(record: ScreenshotRecord): Selectable<Screenshots> {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    path: record.path,
    kind: record.kind,
    content_type: record.contentType,
    width: record.width,
    height: record.height,
    size_bytes: record.sizeBytes,
    ts: record.ts,
  };
}

/** `vault_access` row → record. */
export function vaultAccessFromRow(row: Selectable<VaultAccess>): VaultAccessRecord {
  const where = `vault_access.${row.event_id}`;
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    toolEventId: row.tool_event_id,
    entryName: row.entry_name,
    handle: row.handle,
    result: parseEnum(VAULT_ACCESS_RESULTS, row.result, where),
    reason: row.reason,
    evaluateEnabled: intToBool(row.evaluate_enabled),
    pageUrl: row.page_url,
    originCheck: parseEnum(ORIGIN_CHECKS, row.origin_check, where),
    principalId: row.principal_id,
    details: parseJsonObjectOrNull(row.details_json, where),
    ts: row.ts,
  };
}

/** Record → `vault_access` insert row. */
export function vaultAccessToRow(record: VaultAccessRecord): Selectable<VaultAccess> {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    tool_event_id: record.toolEventId,
    entry_name: record.entryName,
    handle: record.handle,
    result: record.result,
    reason: record.reason,
    evaluate_enabled: boolToInt(record.evaluateEnabled),
    page_url: record.pageUrl,
    origin_check: record.originCheck,
    principal_id: record.principalId,
    details_json: toJsonOrNull(record.details),
    ts: record.ts,
  };
}

/** `blocked_requests` row → record. */
export function blockedRequestFromRow(row: Selectable<BlockedRequests>): BlockedRequestRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    toolEventId: row.tool_event_id,
    url: row.url,
    domain: row.domain,
    pattern: row.pattern,
    source: parseEnum(BLOCK_SOURCES, row.source, `blocked_requests.${row.event_id}`),
    tool: row.tool,
    ts: row.ts,
  };
}

/** Record → `blocked_requests` insert row. */
export function blockedRequestToRow(record: BlockedRequestRecord): Selectable<BlockedRequests> {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    tool_event_id: record.toolEventId,
    url: record.url,
    domain: record.domain,
    pattern: record.pattern,
    source: record.source,
    tool: record.tool,
    ts: record.ts,
  };
}

/** `events` row → record. */
export function eventFromRow(row: Selectable<Events>): EventRecord {
  return {
    seq: row.seq,
    eventId: row.event_id,
    type: row.type,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    actorKind: parseEnum(ACTOR_KINDS, row.actor_kind, `events.${row.event_id}`),
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    traceId: row.trace_id,
    payload: parseJsonObject(row.payload_json, `events.${row.event_id}`),
  };
}

/** New event → `events` insert row (`seq` is assigned by SQLite). */
export function eventToRow(event: NewEvent): Insertable<Events> {
  return {
    event_id: event.eventId,
    type: event.type,
    session_id: event.sessionId,
    tenant_id: event.tenantId,
    actor_kind: event.actorKind,
    actor_id: event.actorId,
    occurred_at: event.occurredAt,
    trace_id: event.traceId,
    payload_json: toJson(event.payload),
  };
}
