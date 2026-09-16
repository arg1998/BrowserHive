/** @module ports/persistence/vault-audit — vault fill audit repository. */

import type { Page, VaultAccessListQuery } from './queries.ts';
import type { VaultAccessRecord } from './records.ts';

/** A vault access row joined with its session slug. */
export interface VaultAccessListRow extends VaultAccessRecord {
  readonly sessionSlug: string | null;
}

/** Repository over `vault_access` (audit class, never byte-pruned). */
export interface VaultAuditRepository {
  /** Inserts one audit row (exactly one per fill attempt); duplicate `eventId` is ignored. */
  insert(record: VaultAccessRecord): Promise<void>;
  /** Lists audit rows (`GET /vault/log`, `GET /sessions/{id}/vault-access`). */
  list(query: VaultAccessListQuery): Promise<Page<VaultAccessListRow>>;
}
