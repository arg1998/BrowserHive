/** @module domain/vault/bindings — binding model: handle grammar, origin normalisation, caller authorization (D-14). */

import { VAULT_HANDLE_RE } from '@browserhive/contracts/http';
import { matchesGlob } from '../../kernel/glob.ts';
import type { VaultBindingRecord } from '../../ports/persistence/records.ts';

/** Maximum handle length admitted by {@link VAULT_HANDLE_RE}. */
export const HANDLE_MAX_LENGTH = 128;
/** Group label used when an item is ungrouped (the Bitwarden-style `'No Folder'`). */
export const UNGROUPED_LABEL = 'No Folder';

/** The subject a fill or listing is authorized against: the server-assigned principal + the session slug. */
export interface CallerSubject {
  readonly principal: string;
  readonly slug: string;
}

/** The authorization rule a binding or group policy expresses. */
export interface AuthorizationRule {
  readonly allowAllSessions: boolean;
  /** Exact slugs or globs (`agent-*`). */
  readonly slugGlobs: readonly string[];
  /** Exact principal ids; empty = any principal. */
  readonly principals: readonly string[];
}

/** Lowercases and folds one label into the handle alphabet (`[a-z0-9._-]`). */
export function handleSegment(label: string): string {
  const folded = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return folded.length > 0 ? folded : 'item';
}

/**
 * Default handle for a group's item: `<group>.<item>` folded into the handle grammar
 * (`Work/GitHub` → `work.github`; an ungrouped `LinkedIn` → `no-folder.linkedin`). Deterministic so
 * allow-all groups and manual bindings agree on the same string; always matches `VAULT_HANDLE_RE`.
 */
export function deriveHandle(groupName: string | null | undefined, itemName: string): string {
  const group =
    groupName === null || groupName === undefined || groupName.trim().length === 0
      ? UNGROUPED_LABEL
      : groupName;
  const joined = `${handleSegment(group)}.${handleSegment(itemName)}`;
  return joined.slice(0, HANDLE_MAX_LENGTH).replace(/[^a-z0-9]+$/, '');
}

/** True when `handle` satisfies the wire grammar. */
export function isValidHandle(handle: string): boolean {
  return VAULT_HANDLE_RE.test(handle);
}

/**
 * Normalises one origin pattern: host part lowercased, path part (from the first `/`) kept
 * verbatim because pathnames are case-sensitive. Empty input → `''`.
 */
export function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const slash = trimmed.indexOf('/');
  if (slash < 0) return trimmed.toLowerCase();
  return `${trimmed.slice(0, slash).toLowerCase()}${trimmed.slice(slash)}`;
}

/** Trims, normalises, drops empties and dedupes an origin list. */
export function normalizeOrigins(origins: readonly string[]): readonly string[] {
  return dedupe(origins.map(normalizeOrigin));
}

/** Dedupes non-empty strings, keeping first-seen order. */
export function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** Whether `slug` satisfies the rule's session part (`allow_all_sessions` or a glob match). */
export function isSlugAuthorized(rule: AuthorizationRule, slug: string): boolean {
  return rule.allowAllSessions || rule.slugGlobs.some((pattern) => matchesGlob(slug, pattern));
}

/** Whether `principal` satisfies the rule's principal part (empty list = any principal). */
export function isPrincipalAuthorized(rule: AuthorizationRule, principal: string): boolean {
  return rule.principals.length === 0 || rule.principals.includes(principal);
}

/** D-14: the principal AND the slug must both be authorized. */
export function isCallerAuthorized(rule: AuthorizationRule, caller: CallerSubject): boolean {
  return isPrincipalAuthorized(rule, caller.principal) && isSlugAuthorized(rule, caller.slug);
}

/** The rule a binding expresses. */
export function bindingRule(binding: VaultBindingRecord): AuthorizationRule {
  return {
    allowAllSessions: binding.allowAllSessions,
    slugGlobs: binding.authorizedSessionSlugs,
    principals: binding.authorizedPrincipals,
  };
}

/** Editable fields of a binding (camelCase twin of `PutVaultBindingRequest`). */
export interface VaultBindingInput {
  readonly title?: string;
  readonly itemName?: string;
  readonly itemId?: string;
  readonly groupId?: string | null;
  readonly allowedOrigins?: readonly string[];
  readonly authorizedPrincipals?: readonly string[];
  readonly authorizedSessionSlugs?: readonly string[];
  readonly allowAllSessions?: boolean;
  readonly redactUsername?: boolean;
  readonly requireNoEvaluate?: boolean;
  readonly dashboardConfirm?: boolean;
}

/**
 * Builds the binding to store for `handle` from `input` layered over `prior` (upsert
 * semantics: unspecified fields keep their prior value or the empty/`false` default on create;
 * `createdAt` is preserved, `updatedAt` stamped). Returns `null` when a brand-new binding has no
 * `itemName`; `version` is left to the repository.
 */
export function mergeBinding(
  handle: string,
  input: VaultBindingInput,
  prior: VaultBindingRecord | null,
  now: number,
): VaultBindingRecord | null {
  const itemName = (input.itemName ?? prior?.itemName ?? '').trim();
  if (itemName.length === 0) return null;
  return {
    handle,
    tenantId: prior?.tenantId ?? null,
    title: input.title ?? prior?.title ?? handle,
    itemName,
    itemId: input.itemId ?? prior?.itemId ?? '',
    groupId: input.groupId !== undefined ? input.groupId : (prior?.groupId ?? null),
    allowedOrigins: normalizeOrigins(input.allowedOrigins ?? prior?.allowedOrigins ?? []),
    authorizedPrincipals: dedupe(input.authorizedPrincipals ?? prior?.authorizedPrincipals ?? []),
    authorizedSessionSlugs: dedupe(
      input.authorizedSessionSlugs ?? prior?.authorizedSessionSlugs ?? [],
    ),
    allowAllSessions: input.allowAllSessions ?? prior?.allowAllSessions ?? false,
    redactUsername: input.redactUsername ?? prior?.redactUsername ?? false,
    requireNoEvaluate: input.requireNoEvaluate ?? prior?.requireNoEvaluate ?? false,
    dashboardConfirm: input.dashboardConfirm ?? prior?.dashboardConfirm ?? false,
    version: prior?.version ?? 1,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
}
