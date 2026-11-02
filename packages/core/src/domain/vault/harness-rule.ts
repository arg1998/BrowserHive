/** @module domain/vault/harness-rule — the narrowing harness lists of vault bindings and group policies (D-48): normalisation and the combined binding + group check. Self-reported identity: this only ever removes access, it is not a security boundary. */

import { type HarnessSubject, isHarnessAllowed } from '@browserhive/contracts/harness';

/** The harness lists that apply to one entry: its binding's own (manual bindings) and its group policy's. */
export interface EntryHarnessRules {
  /** The binding's list; `null` = every harness (and always `null` for `allow_all` items). */
  readonly binding: readonly string[] | null;
  /** The list of the policy of the entry's group, whatever its access mode; `null` = every harness. */
  readonly group: readonly string[] | null;
}

/** Which rule refused a harness. */
export type HarnessRuleSource = 'binding' | 'group';

/** Outcome of {@link checkHarnessRules}. */
export type HarnessVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rule: HarnessRuleSource };

/** No restriction anywhere. */
export const NO_HARNESS_RULES: EntryHarnessRules = { binding: null, group: null };

/**
 * A list as stored: entries trimmed, blanks dropped, duplicates removed in order. `null` (every
 * harness) stays `null` and `[]` (none) stays `[]`, so the two meanings never collapse.
 */
export function normalizeHarnessList(
  list: readonly string[] | null | undefined,
): readonly string[] | null {
  if (list === null || list === undefined) return null;
  return [...new Set(list.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/**
 * Gate 2c (spec 02 §3.13): every list that applies must let the session's launch identity through;
 * the binding's list is checked first, so the reason names the narrowest rule that refused.
 */
export function checkHarnessRules(
  rules: EntryHarnessRules,
  subject: HarnessSubject,
): HarnessVerdict {
  if (!isHarnessAllowed(rules.binding, subject)) return { allowed: false, rule: 'binding' };
  if (!isHarnessAllowed(rules.group, subject)) return { allowed: false, rule: 'group' };
  return { allowed: true };
}
