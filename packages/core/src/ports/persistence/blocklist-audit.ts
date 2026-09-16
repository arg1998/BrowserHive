/** @module ports/persistence/blocklist-audit — blocked request audit repository. */

import type { BlockedRequestListQuery, BlockedStats, Page, TimeWindow } from './queries.ts';
import type { BlockedRequestRecord } from './records.ts';

/** A blocked request joined with its session slug. */
export interface BlockedRequestListRow extends BlockedRequestRecord {
  readonly sessionSlug: string | null;
}

/** Repository over `blocked_requests` (audit class). */
export interface BlocklistAuditRepository {
  /** Inserts one blocked attempt; duplicate `eventId` is ignored. */
  insert(record: BlockedRequestRecord): Promise<void>;
  /** Lists attempts (`GET /blocklist/attempts`, `GET /sessions/{id}/blocked`). */
  list(query: BlockedRequestListQuery): Promise<Page<BlockedRequestListRow>>;
  /** Window aggregates for `GET /blocklist` (`topLimit` clamped to 1..100). */
  stats(window: TimeWindow, topLimit?: number): Promise<BlockedStats>;
}
