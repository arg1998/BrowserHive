/** @module domain/vault/decide-fill — pure policy gates of a fill, in a fixed order, returning (never throwing) stable reason strings. */

import type { OriginCheck } from '@browserhive/contracts/http';
import { type CallerSubject, isCallerAuthorized } from './bindings.ts';
import { checkOrigin, type OriginCheckResult } from './origin.ts';
import type { ResolvedEntry, VaultFillSession } from './types.ts';

/** Inputs to {@link decideFill}. */
export interface FillDecisionInput {
  readonly session: VaultFillSession;
  readonly principal: string;
  /** Whether `evaluate` is globally allowed (combined with the per-session flag). */
  readonly allowEvaluate: boolean;
  /** `page.url()` at fill time (`''` when unreadable). */
  readonly pageUrl: string;
  /** The resolved handle, or `undefined` when nothing an agent may target answers to it. */
  readonly entry: ResolvedEntry | undefined;
  /** Dashboard tester: skip the subject check when no slug/principal was supplied. */
  readonly checkSubject?: boolean;
}

/** Reasons a fill is refused before any credential is fetched. */
export type BlockedReason = 'vault_disabled' | 'not_authorized' | 'evaluate_required_off';

/** Outcome of {@link decideFill}. */
export type FillDecision =
  | {
      readonly kind: 'blocked';
      readonly reason: BlockedReason;
      readonly originCheck: Extract<OriginCheck, 'skipped'>;
      readonly entry: ResolvedEntry | undefined;
    }
  | {
      readonly kind: 'origin_mismatch';
      readonly reason: 'origin_mismatch';
      readonly originCheck: Extract<OriginCheck, 'fail'>;
      readonly origin: OriginCheckResult;
      readonly entry: ResolvedEntry;
    }
  | {
      readonly kind: 'proceed';
      readonly originCheck: Extract<OriginCheck, 'pass'>;
      readonly origin: OriginCheckResult;
      readonly entry: ResolvedEntry;
      /** Step 5: the fill must be held for an operator before the credential is fetched. */
      readonly confirmRequired: boolean;
      readonly evaluateEnabled: boolean;
    };

/** True when the session may run `evaluate` (the audit's `evaluate_enabled`). */
export function evaluateEnabledFor(session: VaultFillSession, allowEvaluate: boolean): boolean {
  return allowEvaluate && !session.disableEvaluate;
}

/**
 * Gates 1–5 of a fill, in this exact order (the first failing gate names the reason, so outcomes are deterministic):
 *
 * 1. session `vault_enabled`                          → blocked / `vault_disabled`
 * 2. handle resolves (binding or allow-all item)      → blocked / `not_authorized`
 * 2b. caller principal AND slug authorized (D-14)     → blocked / `not_authorized` (same text —
 *     an unknown handle and an unauthorized caller are indistinguishable, no enumeration oracle)
 * 3. `require_no_evaluate` while evaluate is permitted → blocked / `evaluate_required_off`
 * 4. origin re-check of the live page URL              → `origin_mismatch`
 * 5. `dashboard_confirm`                               → `proceed` with `confirmRequired`
 */
export function decideFill(input: FillDecisionInput): FillDecision {
  const { session, entry } = input;
  if (!session.vaultEnabled) {
    return { kind: 'blocked', reason: 'vault_disabled', originCheck: 'skipped', entry };
  }
  if (entry === undefined) {
    return { kind: 'blocked', reason: 'not_authorized', originCheck: 'skipped', entry };
  }
  const subject: CallerSubject = { principal: input.principal, slug: session.slug };
  if (input.checkSubject !== false && !isCallerAuthorized(entry.rule, subject)) {
    return { kind: 'blocked', reason: 'not_authorized', originCheck: 'skipped', entry };
  }
  const evaluateEnabled = evaluateEnabledFor(session, input.allowEvaluate);
  if (entry.requireNoEvaluate && evaluateEnabled) {
    return { kind: 'blocked', reason: 'evaluate_required_off', originCheck: 'skipped', entry };
  }
  const origin = checkOrigin(input.pageUrl, entry.origins);
  if (origin.outcome !== 'pass') {
    return {
      kind: 'origin_mismatch',
      reason: 'origin_mismatch',
      originCheck: 'fail',
      origin,
      entry,
    };
  }
  return {
    kind: 'proceed',
    originCheck: 'pass',
    origin,
    entry,
    confirmRequired: entry.dashboardConfirm,
    evaluateEnabled,
  };
}
