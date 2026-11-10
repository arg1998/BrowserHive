/** @module features/templates/detail/access-draft — the Access tab's local draft (who may use the template, harnesses, cap, unseal flags and whom they apply to), its PATCH body, and whether a change can close live sessions */
import type { TemplatePolicy } from '@browserhive/contracts/http';
import { UNSEAL_FLAGS, type UnsealFlag } from '../unseal.ts';

export { UNSEAL_FLAGS, UNSEAL_TEXT, type UnsealFlag } from '../unseal.ts';

/** The editable access policy. */
export interface AccessDraft {
  readonly principals: readonly string[];
  /** `null` = every harness (D-48). */
  readonly harnesses: readonly string[] | null;
  readonly maxConcurrent: number;
  readonly unseal: { readonly [K in UnsealFlag]: boolean };
  readonly unsealPrincipals: readonly string[];
}

/** The draft of a stored policy. */
export function draftOf(policy: TemplatePolicy): AccessDraft {
  return {
    principals: policy.authorized_principals,
    harnesses: policy.harnesses ?? null,
    maxConcurrent: policy.max_concurrent,
    unseal: {
      cookie_values: policy.unseal.cookie_values,
      evaluate: policy.unseal.evaluate,
      cookie_writes: policy.unseal.cookie_writes,
      state_export: policy.unseal.state_export,
    },
    unsealPrincipals: policy.unseal.principals ?? [],
  };
}

const same = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]));

/** `true` when the draft differs from the stored policy. */
export function isDirty(draft: AccessDraft, policy: TemplatePolicy): boolean {
  const stored = draftOf(policy);
  return (
    !same(draft.principals, stored.principals) ||
    !same(draft.harnesses, stored.harnesses) ||
    draft.maxConcurrent !== stored.maxConcurrent ||
    UNSEAL_FLAGS.some((f) => draft.unseal[f] !== stored.unseal[f]) ||
    !same(draft.unsealPrincipals, stored.unsealPrincipals)
  );
}

/**
 * `true` when the change can take access away from someone: a principal list that becomes
 * restrictive or loses entries, or a harness rule that becomes restrictive or loses entries.
 */
export function narrowsAccess(draft: AccessDraft, policy: TemplatePolicy): boolean {
  const stored = draftOf(policy);
  const principals =
    (stored.principals.length === 0 && draft.principals.length > 0) ||
    (draft.principals.length > 0 && stored.principals.some((p) => !draft.principals.includes(p)));
  const harnesses =
    draft.harnesses !== null &&
    (stored.harnesses === null || stored.harnesses.some((h) => !draft.harnesses?.includes(h)));
  return principals || harnesses;
}

/**
 * The PATCH body (`policy` only, complete, so the fields this tab does not edit keep their values).
 * `harnesses: null` clears the rule (D-48).
 */
export function patchOf(
  draft: AccessDraft,
  policy: TemplatePolicy,
): Readonly<Record<string, unknown>> {
  return {
    policy: {
      health_interval_ms: policy.health_interval_ms,
      prelaunch_check: policy.prelaunch_check,
      authorized_principals: [...draft.principals],
      harnesses: draft.harnesses === null ? null : [...draft.harnesses],
      max_concurrent: draft.maxConcurrent,
      unseal: {
        ...draft.unseal,
        ...(draft.unsealPrincipals.length > 0 && { principals: [...draft.unsealPrincipals] }),
      },
    },
  };
}
