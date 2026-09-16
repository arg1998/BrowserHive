/** @module domain/vault/policies — group access policies (`manual` | `allow_all` | `reject_all`), keyed by group id or the ungrouped sentinel. */

import { UNGROUPED_GROUP_KEY } from '@browserhive/contracts/http';
import type { VaultAccessMode } from '../../ports/persistence/enums.ts';
import type { VaultGroupPolicyRecord } from '../../ports/persistence/records.ts';
import { type AuthorizationRule, dedupe } from './bindings.ts';

/** `vault_group_policies.group_key` for a group id (`null` → `__ungrouped__`). */
export function groupKeyOf(groupId: string | null): string {
  return groupId ?? UNGROUPED_GROUP_KEY;
}

/** Inverse of {@link groupKeyOf}. */
export function groupIdOf(groupKey: string): string | null {
  return groupKey === UNGROUPED_GROUP_KEY ? null : groupKey;
}

/** A synthesized `manual` policy for a group with no stored record. */
export function defaultPolicy(groupId: string | null, now: number): VaultGroupPolicyRecord {
  return {
    groupKey: groupKeyOf(groupId),
    groupId,
    tenantId: null,
    accessMode: 'manual',
    allowAllSessions: false,
    sessionSlugGlobs: [],
    authorizedPrincipals: [],
    dashboardConfirm: false,
    requireNoEvaluate: false,
    redactUsername: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Read-only view over a policy list that always answers with a concrete policy. */
export class PolicySet {
  private readonly byKey: ReadonlyMap<string, VaultGroupPolicyRecord>;

  constructor(policies: readonly VaultGroupPolicyRecord[]) {
    this.byKey = new Map(policies.map((p) => [p.groupKey, p]));
  }

  /** The stored policy for `groupId`, or the synthesized `manual` default. */
  get(groupId: string | null, now: number): VaultGroupPolicyRecord {
    return this.byKey.get(groupKeyOf(groupId)) ?? defaultPolicy(groupId, now);
  }

  /** True when any stored policy is `allow_all` (the only case that needs backend enumeration). */
  hasAllowAll(): boolean {
    for (const p of this.byKey.values()) if (p.accessMode === 'allow_all') return true;
    return false;
  }

  /** Every stored policy, sorted by group key. */
  list(): readonly VaultGroupPolicyRecord[] {
    return [...this.byKey.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
  }
}

/** The rule a group policy expresses (used in `allow_all` mode). */
export function policyRule(policy: VaultGroupPolicyRecord): AuthorizationRule {
  return {
    allowAllSessions: policy.allowAllSessions,
    slugGlobs: policy.sessionSlugGlobs,
    principals: policy.authorizedPrincipals,
  };
}

/** Editable fields of a group policy (camelCase twin of `PutGroupPolicyRequest`). */
export interface VaultGroupPolicyInput {
  readonly accessMode?: VaultAccessMode;
  readonly allowAllSessions?: boolean;
  readonly sessionSlugGlobs?: readonly string[];
  readonly authorizedPrincipals?: readonly string[];
  readonly dashboardConfirm?: boolean;
  readonly requireNoEvaluate?: boolean;
  readonly redactUsername?: boolean;
}

/**
 * Builds the policy to store for `groupId` from `input` over `prior` (upsert semantics:
 * unspecified fields keep their prior value or the `manual`/`false`/`[]` default on create).
 */
export function mergePolicy(
  groupId: string | null,
  input: VaultGroupPolicyInput,
  prior: VaultGroupPolicyRecord | null,
  now: number,
): VaultGroupPolicyRecord {
  return {
    groupKey: groupKeyOf(groupId),
    groupId,
    tenantId: prior?.tenantId ?? null,
    accessMode: input.accessMode ?? prior?.accessMode ?? 'manual',
    allowAllSessions: input.allowAllSessions ?? prior?.allowAllSessions ?? false,
    sessionSlugGlobs: dedupe(input.sessionSlugGlobs ?? prior?.sessionSlugGlobs ?? []),
    authorizedPrincipals: dedupe(input.authorizedPrincipals ?? prior?.authorizedPrincipals ?? []),
    dashboardConfirm: input.dashboardConfirm ?? prior?.dashboardConfirm ?? false,
    requireNoEvaluate: input.requireNoEvaluate ?? prior?.requireNoEvaluate ?? false,
    redactUsername: input.redactUsername ?? prior?.redactUsername ?? false,
    version: prior?.version ?? 1,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
}
