/** @module ports/security-intercepts — `security_intercept` operator requests (spec 13 §9.3, §9.5, D-15): write approvals and site checks on template sessions, their bounds, the one-time passes and the tool hold. Implemented over `OperatorRequestBroker` in `app/site-packs/security-intercepts.ts`. */

import type { PackChallengeKind, PackGuardKind } from '@browserhive/contracts/site-packs';
import type { RequestConfirmer } from './request-guard.ts';

/**
 * Tools a held or stopped template session may still call (spec 13 §9.5): they end or only
 * inspect a session, or wait for the operator. The dispatcher's hold and the tool gate share it.
 */
export const SITE_HOLD_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'close_session',
  'list_sessions',
  'server_status',
  'session_info',
  'list_tabs',
  'screenshot',
  'list_templates',
  'get_attention_result',
  'list_saved_auths',
  'vault_list_available',
]);

/** Why a session is held (`SITE_OPERATOR_PENDING.details.reason`). */
export type SiteHoldReason = 'challenge' | 'write_confirm';

/** The open intercept a session waits for. */
export interface SiteHold {
  readonly requestId: string;
  readonly site: string;
  readonly reason: SiteHoldReason;
}

/** A write the tool layer wants approved (an element guard or a `GET` document guard with `confirm`). */
export interface WriteApprovalInput {
  readonly sessionId: string;
  readonly templateId: string;
  /** The registrable domain. */
  readonly site: string;
  readonly packId: string;
  /** The pack's guard id (without the pack prefix). */
  readonly guardId: string;
  readonly guardKind: PackGuardKind;
  readonly method: string | null;
  /** Sanitized (D-20). */
  readonly url: string;
  readonly tool: string;
  readonly source: 'element' | 'request';
  /**
   * The control the agent named (its selector, or role and name), so an approval's one-time pass
   * covers that control only, not another control of the same guard on the page (review L6).
   */
  readonly target?: string;
}

/** The tool layer's answer for a `confirm` action. */
export type WriteApprovalResult =
  /** An approval of the same guard and URL within the last 10 minutes covers it (consumed). */
  | { readonly kind: 'pass' }
  /** A request is open (new or the session's existing one): answer `SITE_OPERATOR_PENDING`. */
  | { readonly kind: 'pending'; readonly requestId: string }
  /** No operator can answer (`transport=stdio`) or the per-template bound is reached: act as `block`. */
  | { readonly kind: 'blocked'; readonly reason: 'no_operator' | 'bounds' };

/** A challenge seen on a page of an agent's virtual session (spec 13 §9.5 "Outcome"). */
export interface ChallengeInput {
  readonly sessionId: string;
  readonly templateId: string;
  readonly site: string;
  readonly siteTitle: string;
  readonly packId: string | null;
  readonly challenge: {
    readonly id: string;
    readonly kind: PackChallengeKind;
    readonly action: 'attention' | 'stop';
  };
  /** Sanitized (D-20). */
  readonly pageUrl: string;
}

/** Security intercepts of template sessions. */
export interface SecurityIntercepts {
  /** The network path's confirmer; `null` when no operator can answer (`transport=stdio`). */
  readonly confirmer: RequestConfirmer | null;
  /** The open intercept holding `sessionId`, or `null`. */
  holdOf(sessionId: string): SiteHold | null;
  /** The tool path of a `confirm` action: never waits for the operator. */
  requestWriteApproval(input: WriteApprovalInput): Promise<WriteApprovalResult>;
  /**
   * Opens a site check (`mode: 'takeover'`) unless the per-session or per-template bounds say
   * otherwise (at most one open per session, one new per session per 5 min, ten per template);
   * returns the request id now holding the session, or `null` when none was opened (stdio, bounds).
   */
  raiseChallenge(input: ChallengeInput): Promise<string | null>;
}
