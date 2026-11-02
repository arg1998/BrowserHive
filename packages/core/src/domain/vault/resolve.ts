/** @module domain/vault/resolve — handle → fillable entry resolution (manual binding first, then allow-all groups). */

import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../ports/persistence/records.ts';
import type { VaultBindingRepository } from '../../ports/persistence/vault-policy.ts';
import type { VaultBackend, VaultEntrySummary, VaultGroup } from '../../ports/vault-backend.ts';
import { bindingRule, deriveHandle } from './bindings.ts';
import { originsFromUris } from './origin.ts';
import type { PolicySet } from './policies.ts';
import { policyRule } from './policies.ts';
import type { ResolvedEntry } from './types.ts';

/** What entry resolution reads. */
export interface ResolveDeps {
  readonly bindings: VaultBindingRepository;
  readonly backend: VaultBackend;
  readonly now: () => number;
}

/** One backend enumeration (groups + entries) shared by resolution and listing. */
export interface BackendInventory {
  readonly groupNames: ReadonlyMap<string | null, string>;
  readonly entries: readonly VaultEntrySummary[];
}

/** Enumerates the backend once. Throws what the backend throws (`VAULT_LOCKED`, …). */
export async function enumerateBackend(
  backend: VaultBackend,
  signal?: AbortSignal,
): Promise<BackendInventory> {
  const [groups, entries] = await Promise.all([
    backend.listGroups(signal),
    backend.listEntries({}, signal),
  ]);
  return { groupNames: groupNameMap(groups), entries };
}

/** `group id → name` including the ungrouped bucket. */
export function groupNameMap(groups: readonly VaultGroup[]): ReadonlyMap<string | null, string> {
  const names = new Map<string | null, string>();
  for (const g of groups) names.set(g.id, g.name);
  return names;
}

/** Every allow-all item as a resolved entry (no per-item flags; the group policy is the sole gate). */
export function allowAllEntries(
  inventory: BackendInventory,
  policies: PolicySet,
  now: number,
): readonly ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const item of inventory.entries) {
    const policy = policies.get(item.groupId, now);
    if (policy.accessMode !== 'allow_all') continue;
    out.push({
      handle: deriveHandle(inventory.groupNames.get(item.groupId) ?? '', item.name),
      itemName: item.name,
      itemId: item.id,
      groupId: item.groupId,
      origins: originsFromUris(item.uris),
      rule: policyRule(policy),
      harnessRules: { binding: null, group: policy.harnesses },
      redactUsername: policy.redactUsername,
      requireNoEvaluate: policy.requireNoEvaluate,
      dashboardConfirm: policy.dashboardConfirm,
      source: 'allow_all',
    });
  }
  return out;
}

/**
 * A manual binding as a fill target under its group's policy: the binding's own rule and flags, and
 * the harness lists of both (D-48). Shared by the broker and the dashboard tester, so they agree.
 */
export function manualEntry(
  binding: VaultBindingRecord,
  policy: VaultGroupPolicyRecord,
): ResolvedEntry {
  return {
    handle: binding.handle,
    itemName: binding.itemName,
    itemId: binding.itemId,
    groupId: binding.groupId,
    origins: binding.allowedOrigins,
    rule: bindingRule(binding),
    harnessRules: { binding: binding.harnesses, group: policy.harnesses },
    redactUsername: binding.redactUsername,
    requireNoEvaluate: binding.requireNoEvaluate,
    dashboardConfirm: binding.dashboardConfirm,
    source: 'manual',
  };
}

/**
 * Resolves a handle to a fillable entry, or `undefined` when nothing an agent may target answers
 * to it:
 *
 * 1. **Manual first.** A stored binding with this handle wins — UNLESS its group's policy is
 *    `reject_all` (the denylist overrides the stray binding).
 * 2. **Allow-all groups.** Enumerate the backend only when some policy is `allow_all` and match
 *    `deriveHandle(groupName, item.name)`. Exactly one match with ≥ 1 usable origin resolves;
 *    zero, more than one (ambiguous), or no-URL → `undefined`.
 */
export async function resolveEntry(
  deps: ResolveDeps,
  policies: PolicySet,
  handle: string,
  signal?: AbortSignal,
): Promise<ResolvedEntry | undefined> {
  const now = deps.now();
  const binding = await deps.bindings.get(handle);
  if (binding !== null) {
    const policy = policies.get(binding.groupId, now);
    if (policy.accessMode === 'reject_all') return undefined;
    return manualEntry(binding, policy);
  }
  if (!policies.hasAllowAll()) return undefined;
  const inventory = await enumerateBackend(deps.backend, signal);
  const matches = allowAllEntries(inventory, policies, now).filter((e) => e.handle === handle);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined || only.origins.length === 0) return undefined;
  return only;
}
