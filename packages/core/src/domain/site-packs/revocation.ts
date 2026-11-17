/** @module domain/site-packs/revocation — what happens when an approved pack version is revoked (spec 13 §9.7, last paragraph): the fallback (the previous approved version, else none) is classified against the revoked version like any candidate; a tightening or neutral fallback applies at once, a loosening or restrictive one leaves the revoked version in force behind a pending decision marked `revoked`, and with no fallback the revoked version stays in force and is reported, never silently removed. A pinned pack follows the same rule. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { assertNever } from '../../kernel/errors/app-error.ts';
import type { SitePackSourceId } from '../../ports/persistence/site-packs.ts';
import {
  type ChangeClass,
  type ClassifiedChange,
  type ClassifyContext,
  classifyPackChange,
} from './classify.ts';

/** What the registry does with a revoked version. */
export type RevocationDecision =
  /** The fallback becomes the approved version now (an automatic decision). */
  | {
      readonly kind: 'apply_fallback';
      readonly classification: Extract<ChangeClass, 'tightening' | 'neutral'>;
      readonly changes: readonly ClassifiedChange[];
    }
  /** The revoked version stays in force; the fallback waits for an operator, marked `revoked`. */
  | {
      readonly kind: 'open_decision';
      readonly classification: Extract<ChangeClass, 'loosening' | 'restrictive'>;
      readonly changes: readonly ClassifiedChange[];
    }
  /** The revoked version stays in force and is reported. */
  | { readonly kind: 'keep_and_report'; readonly reason: 'no_fallback' | 'operator_content' };

/** The facts of one revocation. */
export interface RevocationInput {
  /** The approved version the publisher revoked. */
  readonly revoked: SitePackV1;
  /** Where the revoked version came from. */
  readonly source: SitePackSourceId;
  /** The previous approved version, or `null`. */
  readonly fallback: SitePackV1 | null;
  readonly ctx: ClassifyContext;
}

/**
 * Decides a revocation (spec 13 §9.7). Content an operator approved from a local file is operator
 * trust: a publisher's revocation never replaces it (`operator_content`), it is only reported.
 */
export function revocationDecision(input: RevocationInput): RevocationDecision {
  if (input.source === 'local') return { kind: 'keep_and_report', reason: 'operator_content' };
  if (input.fallback === null) return { kind: 'keep_and_report', reason: 'no_fallback' };
  const { classification, changes } = classifyPackChange(input.revoked, input.fallback, input.ctx);
  switch (classification) {
    case 'tightening':
    case 'neutral':
      return { kind: 'apply_fallback', classification, changes };
    case 'loosening':
    case 'restrictive':
      return { kind: 'open_decision', classification, changes };
    case 'new_pack':
      // `revoked` is never null here, so the classifier never answers `new_pack`.
      return { kind: 'keep_and_report', reason: 'no_fallback' };
    default:
      return assertNever(classification);
  }
}
