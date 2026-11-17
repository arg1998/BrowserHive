/** @module domain/operator-requests/idempotency — the broker's idempotent open: the same key within a session returns the open request (or the settled one) instead of opening another. */

import type { OperatorRequestListRow } from '../../ports/persistence/operator-requests.ts';
import type { OperatorRequestRecord } from '../../ports/persistence/records.ts';
import type {
  OpenOperatorRequest,
  OperatorRequestHandle,
  OperatorRequestOutcome,
} from './types.ts';

/** What the lookup reads from the broker. */
export interface IdempotencySources {
  /** The open requests with their waiters. */
  pending(): readonly {
    readonly record: OperatorRequestRecord;
    readonly promise: Promise<OperatorRequestOutcome>;
  }[];
  stored(sessionId: string, key: string): Promise<OperatorRequestListRow | null>;
  result(id: string): Promise<OperatorRequestOutcome | null>;
}

/** The handle of the request `input`'s idempotency key names, or `null`. */
export async function findIdempotent(
  input: OpenOperatorRequest,
  sources: IdempotencySources,
): Promise<OperatorRequestHandle | null> {
  const key = input.idempotencyKey;
  if (key === undefined) return null;
  for (const p of sources.pending()) {
    const r = p.record;
    if (r.sessionId === input.sessionId && r.idempotencyKey === key && r.kind === input.kind) {
      return {
        id: r.requestId,
        createdAt: r.createdAt,
        timeoutMs: r.deadlineAt === null ? null : r.deadlineAt - r.createdAt,
        promise: p.promise,
        reused: true,
      };
    }
  }
  const stored = await sources.stored(input.sessionId, key);
  if (stored === null || stored.kind !== input.kind) return null;
  const outcome = await sources.result(stored.requestId);
  if (outcome === null) return null;
  return {
    id: stored.requestId,
    createdAt: stored.createdAt,
    timeoutMs: stored.deadlineAt === null ? null : stored.deadlineAt - stored.createdAt,
    promise: Promise.resolve(outcome),
    reused: true,
  };
}
