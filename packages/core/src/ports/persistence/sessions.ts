/** @module ports/persistence/sessions — session state table repository (spec 03 §7.2). */

import type { ClosedReason } from './enums.ts';
import type { Page, SessionFacets, SessionListQuery } from './queries.ts';
import type { SessionListRow, SessionPatch, SessionRecord } from './records.ts';

/** Result of a hard delete: rows removed across all tables and artifact paths enqueued for unlinking. */
export interface SessionDeleteResult {
  readonly rows: number;
  readonly paths: readonly string[];
}

/** Repository over `sessions`. Every method throws `AppError` on storage failure. */
export interface SessionRepository {
  /** Inserts a new session row; a duplicate id is ignored (idempotent on primary key). */
  insert(record: SessionRecord): Promise<void>;
  /** Applies a partial update; unknown id is a no-op. Returns true when a row changed. */
  update(sessionId: string, patch: SessionPatch): Promise<boolean>;
  /** Fetches one session with its aggregates, or `null`. */
  get(sessionId: string): Promise<SessionListRow | null>;
  /** Lists sessions with aggregates, keyset paginated. */
  list(query: SessionListQuery): Promise<Page<SessionListRow>>;
  /** Facet counts over the same filters as {@link list} (minus pagination). */
  facets(query: SessionListQuery): Promise<SessionFacets>;
  /** Marks a still-open session closed; returns false when it was already closed. */
  markClosed(sessionId: string, at: number, reason: ClosedReason): Promise<boolean>;
  /** Sets `archived_at`; idempotent. */
  archive(sessionId: string, at: number): Promise<boolean>;
  /** Clears `archived_at`; idempotent. */
  unarchive(sessionId: string): Promise<boolean>;
  /**
   * Hard-deletes the session and every child row (FK cascade) and enqueues its artifacts on the
   * outbox in the same transaction.
   */
  delete(sessionId: string, sessionDir: string): Promise<SessionDeleteResult>;
  /** Closes every row still open (startup recovery). Returns the number reconciled. */
  reconcileOpen(at: number, reason: ClosedReason): Promise<number>;
}
