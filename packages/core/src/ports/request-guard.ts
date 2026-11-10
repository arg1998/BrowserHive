/** @module ports/request-guard — the request guard's audit sink and its operator confirmation (spec 13 §3.8, §9.3). */

import type { RequestGuardAction } from '../domain/policies/request-guard.ts';

/** Who a routed request belongs to (spec 13 §3.8 "Owner of a request"). */
export type RequestOwner =
  | { readonly kind: 'session'; readonly sessionId: string }
  /** A template host's own request (a service worker, a page no session owns). */
  | { readonly kind: 'host' };

/** The outcome of a confirmation (spec 13 §9.9 `site_guard_hits.outcome`). */
export type RequestConfirmOutcome = 'approved' | 'denied' | 'timeout' | 'cancelled';

/**
 * One guard decision. The `site_guard_hits` row of spec 13 §9.9 (PR T3a) is built from it; until
 * then the sink is in memory.
 */
export interface RequestGuardHit {
  /** The owning session, `null` for a host-owned request. */
  readonly sessionId: string | null;
  readonly ruleId: string;
  /** The matching rule's action. */
  readonly ruleAction: Exclude<RequestGuardAction, 'allow'>;
  /** What was done: a `confirm` rule with no one to confirm it is a `block`. */
  readonly action: 'block' | 'confirm' | 'warn';
  /** Confirmations only. */
  readonly outcome: RequestConfirmOutcome | null;
  /** The operator who decided a confirmation. */
  readonly decidedBy: string | null;
  /** The operator request of a confirmation. */
  readonly requestId: string | null;
  /** Upper-cased; not limited to the guard's methods (a rule without `methods` matches any). */
  readonly method: string;
  readonly resourceType: string;
  /** Sanitized (D-20): no query values outside `urlQueryAllowlist`, no fragment, no userinfo. */
  readonly url: string;
  readonly source: 'request';
  readonly ts: number;
}

/** Receives every guard decision. Must not throw; the guard logs and carries on if it does. */
export interface RequestGuardHits {
  record(hit: RequestGuardHit): void;
}

/** What the operator is asked to confirm. */
export interface RequestConfirmation {
  readonly owner: RequestOwner;
  readonly ruleId: string;
  readonly method: string;
  readonly resourceType: string;
  /** Sanitized (D-20). */
  readonly url: string;
  /**
   * Aborted when the held request goes away first (Chromium failed it: a superseded navigation,
   * a closed tab; or the context closed). The confirmer should withdraw the operator request and
   * answer `cancelled`.
   */
  readonly signal: AbortSignal;
}

/** The operator's answer. */
export interface RequestConfirmResult {
  readonly outcome: RequestConfirmOutcome;
  readonly decidedBy: string | null;
  readonly requestId: string | null;
}

/**
 * Asks an operator whether a held request may go out (a `security_intercept` with reason
 * `write_confirm`, PR T3a). The request stays held while the promise is pending; only `approved`
 * releases it. The deadline (the attention timeout, D-15) is the implementation's, and so is
 * answering `cancelled` once {@link RequestConfirmation.signal} aborts.
 */
export interface RequestConfirmer {
  confirm(request: RequestConfirmation): Promise<RequestConfirmResult>;
}
