/** @module domain/vault/events — projects a vault access record onto the `vault.access` feed event the catalog carries. */

import { VaultAccessRow } from '@browserhive/contracts/http';
import { VaultAccessEvent } from '@browserhive/contracts/ws';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { VaultAccessRecord } from '../../ports/persistence/records.ts';
import type { VaultEvents } from './types.ts';

/** The wire row of an audit record (spec 03 §4.5 `VaultAccessRow`); ids are validated. */
export function toVaultAccessRow(
  record: VaultAccessRecord,
  sessionSlug: string | null,
): VaultAccessRow {
  return VaultAccessRow.parse({
    event_id: record.eventId,
    session_id: record.sessionId,
    session_slug: sessionSlug,
    tool_event_id: record.toolEventId,
    entry_name: record.entryName,
    handle: record.handle,
    result: record.result,
    reason: record.reason,
    evaluate_enabled: record.evaluateEnabled,
    page_url: record.pageUrl,
    origin_check: record.originCheck,
    principal_id: record.principalId,
    details: record.details,
    ts: record.ts,
  });
}

/** Publishes `vault.access` for one audit row. */
export function publishVaultAccess(
  events: EventPublisher<VaultEvents>,
  record: VaultAccessRecord,
  sessionSlug: string | null,
): void {
  events.publish(
    'vault.access',
    VaultAccessEvent.parse({ type: 'vault.access', row: toVaultAccessRow(record, sessionSlug) }),
  );
}
