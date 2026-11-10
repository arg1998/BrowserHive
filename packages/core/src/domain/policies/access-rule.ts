/** @module domain/policies/access-rule — who may use an operator-owned resource: the principal rule shared by vault bindings, vault group policies (D-14) and session templates (D-52), and the template grant with D-48's narrowing harness list. */

import { type HarnessSubject, isHarnessAllowed } from '@browserhive/contracts/harness';

/** The authorization rule a vault binding or group policy expresses (D-14). */
export interface AuthorizationRule {
  readonly allowAllSessions: boolean;
  /** Exact slugs or globs (`agent-*`). */
  readonly slugGlobs: readonly string[];
  /** Exact principal ids; empty = any principal. */
  readonly principals: readonly string[];
}

/** Whether `principal` satisfies the rule's principal part (empty list = any principal). */
export function isPrincipalAuthorized(
  rule: Pick<AuthorizationRule, 'principals'>,
  principal: string,
): boolean {
  return rule.principals.length === 0 || rule.principals.includes(principal);
}

/**
 * A session template's grant (spec 13 §6.1, D-52): the vault's principal rule plus one optional
 * harness list with D-48's semantics (`null` = every harness, `[]` = none). Templates have no slug
 * rule: a slug is chosen at launch, after listing.
 */
export interface TemplateAccessRule {
  /** Exact principal ids; empty = any principal. */
  readonly principals: readonly string[];
  /** Known slugs or exact declared names; `null` = every harness. */
  readonly harnesses: readonly string[] | null;
}

/** Who asks: the caller's principal and the harness the call resolved (the launch harness, D-48). */
export interface AccessSubject extends HarnessSubject {
  readonly principal: string;
}

/** Why a grant refused (operator surfaces only: the access tester and the log, never an agent). */
export type AccessRefusal = 'principal_not_allowed' | 'harness_not_allowed';

/** Outcome of {@link checkTemplateAccess}. */
export type AccessVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AccessRefusal };

/**
 * The template gate after "exists and is not recording" (spec 13 §6.1): principal, then harness. The
 * harness list only ever narrows what the principal rule allows; it is self-reported and not a
 * security boundary (D-48).
 */
export function checkTemplateAccess(
  rule: TemplateAccessRule,
  subject: AccessSubject,
): AccessVerdict {
  if (!isPrincipalAuthorized(rule, subject.principal)) {
    return { allowed: false, reason: 'principal_not_allowed' };
  }
  if (!isHarnessAllowed(rule.harnesses, subject)) {
    return { allowed: false, reason: 'harness_not_allowed' };
  }
  return { allowed: true };
}
