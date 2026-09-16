/** @module infra/persistence/mappers/operator-request — `operator_requests` / `operator_actions` rows ↔ records. */

import type { Insertable, Selectable } from 'kysely';
import {
  ATTENTION_MODES,
  OPERATOR_REQUEST_KINDS,
  OPERATOR_REQUEST_STATUSES,
} from '../../../ports/persistence/enums.ts';
import type {
  NewOperatorAction,
  NewOperatorRequest,
  OperatorActionRecord,
  OperatorRequestRecord,
} from '../../../ports/persistence/records.ts';
import type { OperatorActions, OperatorRequests } from '../generated/db.d.ts';
import { parseEnum, parseEnumOrNull, parseJsonObjectOrNull, toJsonOrNull } from './codec.ts';

/** `operator_requests` row → record. */
export function operatorRequestFromRow(row: Selectable<OperatorRequests>): OperatorRequestRecord {
  const where = `operator_requests.${row.request_id}`;
  return {
    requestId: row.request_id,
    kind: parseEnum(OPERATOR_REQUEST_KINDS, row.kind, where),
    sessionId: row.session_id,
    owner: row.owner,
    reason: row.reason,
    mode: parseEnumOrNull(ATTENTION_MODES, row.mode, where),
    entryName: row.entry_name,
    tool: row.tool,
    toolEventId: row.tool_event_id,
    pageUrl: row.page_url,
    options: parseJsonObjectOrNull(row.options_json, where),
    idempotencyKey: row.idempotency_key,
    status: parseEnum(OPERATOR_REQUEST_STATUSES, row.status, where),
    message: row.message,
    resolvedBy: row.resolved_by,
    resolutionReason: row.resolution_reason,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    resolvedAt: row.resolved_at,
  };
}

/** New request → `operator_requests` insert row (always `pending`). */
export function operatorRequestToRow(record: NewOperatorRequest): Selectable<OperatorRequests> {
  return {
    request_id: record.requestId,
    kind: record.kind,
    session_id: record.sessionId,
    owner: record.owner,
    reason: record.reason,
    mode: record.mode,
    entry_name: record.entryName,
    tool: record.tool,
    tool_event_id: record.toolEventId,
    page_url: record.pageUrl,
    options_json: toJsonOrNull(record.options),
    idempotency_key: record.idempotencyKey,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: record.createdAt,
    deadline_at: record.deadlineAt,
    resolved_at: null,
  };
}

/** `operator_actions` row → record. */
export function operatorActionFromRow(row: Selectable<OperatorActions>): OperatorActionRecord {
  return {
    seq: row.seq,
    eventId: row.event_id,
    principalId: row.principal_id,
    action: row.action,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    details: parseJsonObjectOrNull(row.details_json, `operator_actions.${row.event_id}`),
    occurredAt: row.occurred_at,
  };
}

/** New action → `operator_actions` insert row. */
export function operatorActionToRow(action: NewOperatorAction): Insertable<OperatorActions> {
  return {
    event_id: action.eventId,
    principal_id: action.principalId,
    action: action.action,
    resource_kind: action.resourceKind,
    resource_id: action.resourceId,
    details_json: toJsonOrNull(action.details),
    occurred_at: action.occurredAt,
  };
}
