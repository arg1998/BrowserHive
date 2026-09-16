/** @module ports/persistence/operator-requests — attention / vault-confirm request repository (D-15). */

import type { OperatorRequestKind, OperatorRequestStatus } from './enums.ts';
import type { FacetCount, OperatorRequestListQuery, Page } from './queries.ts';
import type { NewOperatorRequest, OperatorRequestRecord } from './records.ts';

/** An operator request joined with its session slug and the wait so far. */
export interface OperatorRequestListRow extends OperatorRequestRecord {
  readonly sessionSlug: string | null;
  /** `resolved_at - created_at`, or `null` while pending. */
  readonly waitedMs: number | null;
}

/** Terminal outcome written by {@link OperatorRequestRepository.resolve}. */
export interface OperatorRequestResolution {
  readonly status: Exclude<OperatorRequestStatus, 'pending'>;
  readonly at: number;
  readonly message?: string;
  readonly resolvedBy?: string;
  readonly reason?: string;
}

/**
 * Facet counts next to an operator-request list. Disjunctive: each dimension is counted under every
 * other filter of the query but ignoring its own, so unselected chips keep their real counts.
 */
export interface OperatorRequestFacets {
  readonly statuses: readonly FacetCount[];
  /** Attention modes; rows without a mode (vault confirms) are not counted. */
  readonly modes: readonly FacetCount[];
}

/** Repository over `operator_requests`. */
export interface OperatorRequestRepository {
  /** Inserts a `pending` request; a duplicate id or `(session, idempotency_key)` is ignored. */
  insert(record: NewOperatorRequest): Promise<void>;
  /** Settles a still-pending request; first writer wins. Returns false when it was not pending. */
  resolve(requestId: string, resolution: OperatorRequestResolution): Promise<boolean>;
  /** Pending requests, oldest first, optionally of one kind. */
  open(kind?: OperatorRequestKind): Promise<readonly OperatorRequestListRow[]>;
  /** Fetches one request or `null`. */
  get(requestId: string): Promise<OperatorRequestListRow | null>;
  /** Existing request for an idempotency key within a session, or `null`. */
  getByIdempotencyKey(sessionId: string, key: string): Promise<OperatorRequestListRow | null>;
  /** Lists requests (open and history) with filters. */
  listHistory(query: OperatorRequestListQuery): Promise<Page<OperatorRequestListRow>>;
  /** Status and mode counts for the list filters (see {@link OperatorRequestFacets}). */
  facets(query: OperatorRequestListQuery): Promise<OperatorRequestFacets>;
  /** Number of pending requests, optionally of one kind. */
  countOpen(kind?: OperatorRequestKind): Promise<number>;
}
