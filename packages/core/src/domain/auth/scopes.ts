/** @module domain/auth/scopes — the v1 scope vocabulary and the per-kind default scope sets (spec 03 §3.5). */

import { Scope } from '@browserhive/contracts/enums';
import type { PrincipalKind } from '../../ports/persistence/enums.ts';

/** Every v1 scope, in registry order. */
export const ALL_SCOPES: readonly Scope[] = Scope.options;

/** Operators hold every scope. */
export const OPERATOR_SCOPES: readonly Scope[] = ALL_SCOPES;

/** Agents (MCP clients) hold the tool scope only. */
export const AGENT_SCOPES: readonly Scope[] = ['mcp:tools'];

/** Service principals hold nothing until a token grants a subset (reserved kind). */
export const SERVICE_SCOPES: readonly Scope[] = [];

const SCOPE_SET: ReadonlySet<string> = new Set(ALL_SCOPES);

/** Type guard for a scope string. */
export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/** The full scope set a principal kind holds by default. */
export function scopesForKind(kind: PrincipalKind): readonly Scope[] {
  switch (kind) {
    case 'operator':
      return OPERATOR_SCOPES;
    case 'agent':
      return AGENT_SCOPES;
    case 'service':
      return SERVICE_SCOPES;
  }
}

/**
 * Filters unknown strings out of a stored scope list (`credentials.scopes_json` may predate a
 * rename) and de-duplicates while keeping registry order.
 */
export function parseScopes(values: readonly string[]): readonly Scope[] {
  const wanted = new Set(values.filter(isScope));
  return ALL_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * The scopes a stored credential list grants (spec 03 §3.5). Only a stored `[]` means "the owner
 * kind's full set" (a token issued without `scopes`, which keeps every scope later releases add). A
 * non-empty list keeps only the scopes this binary knows: entries it does not know (a scope added by
 * a newer release, read after a downgrade) grant nothing, so a list of unknown scopes grants **no**
 * scope and never widens to the full set.
 */
export function resolveStoredScopes(
  stored: readonly string[],
  kind: PrincipalKind,
): readonly Scope[] {
  return stored.length === 0 ? scopesForKind(kind) : parseScopes(stored);
}

/** True when every scope in `requested` is held by `holder`. */
export function isSubsetOf(requested: readonly Scope[], holder: readonly Scope[]): boolean {
  const held = new Set(holder);
  return requested.every((scope) => held.has(scope));
}
