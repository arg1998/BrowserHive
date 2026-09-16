/** @module domain/operator-requests/types — inputs, handles and outcomes of the one operator-request broker (D-15). */

import type {
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  VaultConfirmCreatedEvent,
  VaultConfirmResolvedEvent,
} from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type {
  AttentionMode,
  OperatorRequestKind,
  OperatorRequestStatus,
} from '../../ports/persistence/enums.ts';
import type { OperatorRequestRecord } from '../../ports/persistence/records.ts';

/** A terminal status. */
export type OperatorRequestTerminalStatus = Exclude<OperatorRequestStatus, 'pending'>;

/** The value a blocked `request_attention` / vault confirm resolves to. */
export interface OperatorRequestOutcome {
  readonly requestId: string;
  readonly status: OperatorRequestTerminalStatus;
  readonly message: string | null;
  readonly resolvedBy: string | null;
  /** Operator deny reason (vault confirm); audit only, never sent to the agent. */
  readonly resolutionReason: string | null;
  readonly resolvedAt: number | null;
}

/** Input to `OperatorRequestBroker.open`. */
export interface OpenOperatorRequest {
  readonly kind: OperatorRequestKind;
  readonly sessionId: string;
  /** The session's slug, carried on the feed events (decision-grade context). */
  readonly sessionSlug?: string;
  /** Principal that owns the request (the caller). */
  readonly owner: string;
  readonly reason: string;
  /** Attention only. */
  readonly mode?: AttentionMode;
  /** Vault confirm only: the entry handle. */
  readonly entryName?: string;
  /** Decision-grade context: tool name, tool event id, page url. */
  readonly tool?: string;
  readonly toolEventId?: string;
  readonly pageUrl?: string;
  /** Persisted verbatim for the operator. */
  readonly options?: unknown;
  /** Same key within a session returns the existing request instead of opening another. */
  readonly idempotencyKey?: string;
  /** Deadline; `undefined` or `<= 0` waits indefinitely. */
  readonly timeoutMs?: number;
  /** Aborting settles the request as `cancelled` (client disconnect). */
  readonly signal?: AbortSignal;
}

/** Returned by `OperatorRequestBroker.open`. */
export interface OperatorRequestHandle {
  readonly id: string;
  readonly createdAt: number;
  /** Effective deadline in ms, `null` when the request waits indefinitely. */
  readonly timeoutMs: number | null;
  /** Resolves exactly once the request reaches a terminal state. */
  readonly promise: Promise<OperatorRequestOutcome>;
  /** True when an idempotency key matched an existing request. */
  readonly reused: boolean;
}

/** An operator decision on an open request. */
export interface OperatorDecision {
  readonly status: 'resolved' | 'rejected';
  /** Free text sent to the agent (attention). */
  readonly message?: string;
  /** Deny reason kept for the audit (vault confirm). */
  readonly reason?: string;
}

/** Result of `OperatorRequestBroker.resolve`. */
export type ResolveResult =
  | { readonly ok: true; readonly outcome: OperatorRequestOutcome }
  | { readonly ok: false; readonly status: OperatorRequestStatus | null };

/** Narrow lease interface the sessions subsystem provides (structural; never imported from app/sessions). */
export interface LeaseController {
  pause(sessionId: string, at: number): void;
  resume(sessionId: string, at: number): void;
}

/** Bounds on the open queue. */
export interface OperatorRequestLimits {
  readonly perSession: number;
  readonly global: number;
}

/** Domain events the broker publishes — the WS feed shapes, exactly as `app/events/catalog.ts` carries them. */
export type OperatorRequestEvents = {
  readonly 'attention.created': z.infer<typeof AttentionCreatedEvent>;
  readonly 'attention.resolved': z.infer<typeof AttentionResolvedEvent>;
  readonly 'vault.confirm.created': z.infer<typeof VaultConfirmCreatedEvent>;
  readonly 'vault.confirm.resolved': z.infer<typeof VaultConfirmResolvedEvent>;
};

/** Projects a terminal record onto the outcome shape. */
export function outcomeOf(record: OperatorRequestRecord): OperatorRequestOutcome {
  return {
    requestId: record.requestId,
    status: record.status === 'pending' ? 'rejected' : record.status,
    message: record.message,
    resolvedBy: record.resolvedBy,
    resolutionReason: record.resolutionReason,
    resolvedAt: record.resolvedAt,
  };
}
