/** @module domain/operator-requests/wire — projects operator-request records onto the WS feed shapes the event catalog carries. */

import { OperatorRequestRow } from '@browserhive/contracts/http';
import {
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  VaultConfirmCreatedEvent,
  VaultConfirmResolvedEvent,
} from '@browserhive/contracts/ws';
import type { OperatorRequestRecord } from '../../ports/persistence/records.ts';
import type { OperatorRequestEvents } from './types.ts';

/**
 * The wire row of a record (spec 03 §4.4). `session_slug` is `''` when the session is unknown;
 * ids are validated by the contracts schema, so a malformed id fails loudly here.
 */
export function toOperatorRequestRow(
  record: OperatorRequestRecord,
  sessionSlug: string | null,
): OperatorRequestRow {
  return OperatorRequestRow.parse({
    request_id: record.requestId,
    kind: record.kind,
    session_id: record.sessionId,
    session_slug: sessionSlug ?? '',
    owner: record.owner,
    reason: record.reason,
    mode: record.mode,
    options: record.options,
    status: record.status,
    message: record.message,
    resolved_by: record.resolvedBy,
    resolution_reason: record.resolutionReason,
    created_at: record.createdAt,
    resolved_at: record.resolvedAt,
    deadline_at: record.deadlineAt,
    waited_ms: record.resolvedAt === null ? null : record.resolvedAt - record.createdAt,
    page_url: record.pageUrl,
    tool: record.tool,
    event_id: record.toolEventId,
    entry_name: record.entryName,
  });
}

/** The `(name, payload)` pair to publish for a record reaching `phase`. */
export function operatorRequestEvent(
  phase: 'created' | 'resolved',
  record: OperatorRequestRecord,
  sessionSlug: string | null,
): {
  readonly [N in keyof OperatorRequestEvents]: {
    readonly name: N;
    readonly payload: OperatorRequestEvents[N];
  };
}[keyof OperatorRequestEvents] {
  const request = toOperatorRequestRow(record, sessionSlug);
  if (record.kind === 'attention') {
    return phase === 'created'
      ? {
          name: 'attention.created',
          payload: AttentionCreatedEvent.parse({ type: 'attention.created', request }),
        }
      : {
          name: 'attention.resolved',
          payload: AttentionResolvedEvent.parse({ type: 'attention.resolved', request }),
        };
  }
  return phase === 'created'
    ? {
        name: 'vault.confirm.created',
        payload: VaultConfirmCreatedEvent.parse({ type: 'vault.confirm.created', request }),
      }
    : {
        name: 'vault.confirm.resolved',
        payload: VaultConfirmResolvedEvent.parse({ type: 'vault.confirm.resolved', request }),
      };
}
