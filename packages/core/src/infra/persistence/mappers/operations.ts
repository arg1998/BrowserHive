/** @module infra/persistence/mappers/operations — notifications, preferences, system_events, artifact_outbox, idempotency_keys, mcp_connections, schema_migrations rows ↔ records. */

import type { Insertable, Selectable, Updateable } from 'kysely';
import {
  ARTIFACT_KINDS,
  MCP_TRANSPORTS,
  NOTIFICATION_TYPES,
  SYSTEM_EVENT_SEVERITIES,
} from '../../../ports/persistence/enums.ts';
import type { McpConnectionPatch } from '../../../ports/persistence/operations.ts';
import type {
  ArtifactOutboxRecord,
  IdempotencyRecord,
  McpConnectionRecord,
  NewArtifact,
  NotificationRecord,
  PreferenceRecord,
  SchemaMigrationRecord,
  SystemEventRecord,
} from '../../../ports/persistence/records.ts';
import type { HarnessConflictRecord } from '../../../ports/persistence/records-identity.ts';
import type {
  ArtifactOutbox,
  IdempotencyKeys,
  McpConnections,
  Notifications,
  Preferences,
  SchemaMigrations,
  SystemEvents,
} from '../generated/db.d.ts';
import { parseEnum, parseJsonObjectOrNull, parseJsonValue, toJson, toJsonOrNull } from './codec.ts';

/** `notifications` row → record. */
export function notificationFromRow(row: Selectable<Notifications>): NotificationRecord {
  return {
    notificationId: row.notification_id,
    principalId: row.principal_id,
    type: parseEnum(NOTIFICATION_TYPES, row.type, `notifications.${row.notification_id}`),
    title: row.title,
    body: row.body,
    sessionId: row.session_id,
    target: row.target,
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
    updatedAt: Math.max(row.updated_at, row.created_at),
    count: row.count,
    groupKey: row.group_key,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

/** Record → `notifications` insert row. */
export function notificationToRow(record: NotificationRecord): Selectable<Notifications> {
  return {
    notification_id: record.notificationId,
    principal_id: record.principalId,
    type: record.type,
    title: record.title,
    body: record.body,
    session_id: record.sessionId,
    target: record.target,
    source_event_id: record.sourceEventId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    count: record.count,
    group_key: record.groupKey,
    read_at: record.readAt,
    dismissed_at: record.dismissedAt,
  };
}

/** `preferences` row → record. */
export function preferenceFromRow(row: Selectable<Preferences>): PreferenceRecord {
  return {
    principalId: row.principal_id,
    key: row.key,
    value: parseJsonValue(row.value_json, `preferences.${row.principal_id}.${row.key}`),
    updatedAt: row.updated_at,
  };
}

/** Record → `preferences` insert row. */
export function preferenceToRow(record: PreferenceRecord): Selectable<Preferences> {
  return {
    principal_id: record.principalId,
    key: record.key,
    value_json: toJson(record.value),
    updated_at: record.updatedAt,
  };
}

/** `system_events` row → record. */
export function systemEventFromRow(row: Selectable<SystemEvents>): SystemEventRecord {
  const where = `system_events.${row.event_id}`;
  return {
    seq: row.seq,
    eventId: row.event_id,
    code: row.code,
    severity: parseEnum(SYSTEM_EVENT_SEVERITIES, row.severity, where),
    message: row.message,
    details: parseJsonObjectOrNull(row.details_json, where),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    count: row.count,
    resolvedAt: row.resolved_at,
  };
}

/** `artifact_outbox` row → record. */
export function artifactFromRow(row: Selectable<ArtifactOutbox>): ArtifactOutboxRecord {
  return {
    outboxId: row.outbox_id,
    kind: parseEnum(ARTIFACT_KINDS, row.kind, `artifact_outbox.${row.outbox_id}`),
    path: row.path,
    sessionId: row.session_id,
    enqueuedAt: row.enqueued_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/** New artifact → `artifact_outbox` insert row. */
export function artifactToRow(artifact: NewArtifact): Insertable<ArtifactOutbox> {
  return {
    kind: artifact.kind,
    path: artifact.path,
    session_id: artifact.sessionId,
    enqueued_at: artifact.enqueuedAt,
  };
}

/** `idempotency_keys` row → record. */
export function idempotencyFromRow(row: Selectable<IdempotencyKeys>): IdempotencyRecord {
  return {
    key: row.key,
    principalId: row.principal_id,
    route: row.route,
    response: parseJsonValue(row.response_json, `idempotency_keys.${row.key}`),
    createdAt: row.created_at,
  };
}

/** Record → `idempotency_keys` insert row. */
export function idempotencyToRow(record: IdempotencyRecord): Selectable<IdempotencyKeys> {
  return {
    key: record.key,
    principal_id: record.principalId,
    route: record.route,
    response_json: toJson(record.response),
    created_at: record.createdAt,
  };
}

function conflictsToJson(conflicts: readonly HarnessConflictRecord[]): string | null {
  return conflicts.length === 0 ? null : JSON.stringify(conflicts);
}

function metaToJson(meta: Readonly<Record<string, string>>): string | null {
  return Object.keys(meta).length === 0 ? null : JSON.stringify(meta);
}

function conflictsFromJson(text: string | null, where: string): readonly HarnessConflictRecord[] {
  if (text === null) return [];
  const value = parseJsonValue(text, where);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HarnessConflictRecord[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const { source, value: raw, harness } = item;
    return typeof source === 'string' && typeof raw === 'string' && typeof harness === 'string'
      ? [{ source, value: raw, harness }]
      : [];
  });
}

function metaFromJson(text: string | null, where: string): Readonly<Record<string, string>> {
  if (text === null) return {};
  const value = parseJsonValue(text, where);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** `mcp_connections` row → record. */
export function mcpConnectionFromRow(row: Selectable<McpConnections>): McpConnectionRecord {
  const where = `mcp_connections.${row.connection_id}`;
  return {
    connectionId: row.connection_id,
    principalId: row.principal_id,
    transport: parseEnum(MCP_TRANSPORTS, row.transport, where),
    mcpSessionId: row.mcp_session_id,
    clientName: row.client_name,
    clientVersion: row.client_version,
    protocolVersion: row.protocol_version,
    capabilities: parseJsonObjectOrNull(row.capabilities_json, where),
    clientTitle: row.client_title,
    // Rows written before schema v3 carry the workspace only in `agent_name`.
    workspace: row.workspace ?? row.agent_name,
    agentName: row.agent_name,
    model: row.model,
    modelSource: row.model_source,
    harness: row.harness,
    harnessSource: row.harness_source,
    conflicts: conflictsFromJson(row.harness_conflicts_json, where),
    meta: metaFromJson(row.meta_json, where),
    ip: row.ip,
    userAgent: row.user_agent,
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
  };
}

/** Record → `mcp_connections` insert row. */
export function mcpConnectionToRow(record: McpConnectionRecord): Selectable<McpConnections> {
  return {
    connection_id: record.connectionId,
    principal_id: record.principalId,
    transport: record.transport,
    mcp_session_id: record.mcpSessionId,
    client_name: record.clientName,
    client_version: record.clientVersion,
    protocol_version: record.protocolVersion,
    capabilities_json: toJsonOrNull(record.capabilities),
    client_title: record.clientTitle,
    workspace: record.workspace,
    agent_name: record.agentName,
    model: record.model,
    model_source: record.modelSource,
    harness: record.harness,
    harness_source: record.harnessSource,
    harness_conflicts_json: conflictsToJson(record.conflicts),
    meta_json: metaToJson(record.meta),
    ip: record.ip,
    user_agent: record.userAgent,
    connected_at: record.connectedAt,
    last_seen_at: record.lastSeenAt,
    closed_at: record.closedAt,
  };
}

/** Patch → `mcp_connections` update row. */
export function mcpConnectionPatchToRow(patch: McpConnectionPatch): Updateable<McpConnections> {
  return {
    ...(patch.principalId !== undefined && { principal_id: patch.principalId }),
    ...(patch.mcpSessionId !== undefined && { mcp_session_id: patch.mcpSessionId }),
    ...(patch.clientName !== undefined && { client_name: patch.clientName }),
    ...(patch.clientVersion !== undefined && { client_version: patch.clientVersion }),
    ...(patch.protocolVersion !== undefined && { protocol_version: patch.protocolVersion }),
    ...(patch.capabilities !== undefined && {
      capabilities_json: toJsonOrNull(patch.capabilities),
    }),
    ...(patch.clientTitle !== undefined && { client_title: patch.clientTitle }),
    ...(patch.workspace !== undefined && { workspace: patch.workspace }),
    ...(patch.agentName !== undefined && { agent_name: patch.agentName }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.modelSource !== undefined && { model_source: patch.modelSource }),
    ...(patch.harness !== undefined && { harness: patch.harness }),
    ...(patch.harnessSource !== undefined && { harness_source: patch.harnessSource }),
    ...(patch.conflicts !== undefined && {
      harness_conflicts_json: conflictsToJson(patch.conflicts),
    }),
    ...(patch.meta !== undefined && { meta_json: metaToJson(patch.meta) }),
    ...(patch.ip !== undefined && { ip: patch.ip }),
    ...(patch.userAgent !== undefined && { user_agent: patch.userAgent }),
    ...(patch.lastSeenAt !== undefined && { last_seen_at: patch.lastSeenAt }),
    ...(patch.closedAt !== undefined && { closed_at: patch.closedAt }),
  };
}

/** `schema_migrations` row → record. */
export function schemaMigrationFromRow(row: Selectable<SchemaMigrations>): SchemaMigrationRecord {
  return {
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
    appVersion: row.app_version,
  };
}
