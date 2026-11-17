/** @module domain/site-packs/tool-guards — the tool layer's view of a pack (spec 13 §9.3): effective actions under the write policy, the `GET` document guards `navigate`/`new_tab` check, and the element guards of a page. Pure matching over pack data; the page is queried elsewhere. */

import type {
  PackElementGuard,
  PackGuard,
  PackGuardAction,
  PackGuardKind,
  SitePackV1,
} from '@browserhive/contracts/site-packs';
import {
  compileRequestGuardRules,
  matchRequestGuard,
  type RequestGuardAction,
  type RequestGuardRules,
} from '../policies/request-guard.ts';
import { BUILTIN_PACK_ID } from './challenges.ts';
import { matchesPackGlob } from './pack-glob.ts';

/** A site's write policy (`template_sites.write_policy`, else the pack's `write_policy.default`). */
export type WritePolicy = SitePackV1['write_policy']['default'];

/** The write policy in force: the template site's override, else the pack's default (§9.3). */
export function effectiveWritePolicy(pack: SitePackV1, override: WritePolicy | null): WritePolicy {
  return override ?? pack.write_policy.default;
}

/** A guard's action with `write_policy` resolved (`allow` lets the action through, unrecorded). */
export function effectiveAction(action: PackGuardAction, policy: WritePolicy): RequestGuardAction {
  return action === 'write_policy' ? policy : action;
}

/** A compiled-in guard (`DEFAULT_GUARDS`, owned by the network enforcement; reported as `browserhive#<id>`). */
export type BuiltinGuard = Pick<PackGuard, 'id' | 'kind' | 'match' | 'action'>;

/** The guard that decided a navigation. */
export interface DocumentGuardHit {
  readonly packId: string;
  readonly guardId: string;
  readonly kind: PackGuardKind;
  /** `<pack id>#<guard id>` (the `URL_BLOCKED` pattern). */
  readonly ruleId: string;
  readonly action: RequestGuardAction;
}

interface CompiledDocumentGuards {
  readonly rules: RequestGuardRules;
  readonly byRule: ReadonlyMap<string, { packId: string; guardId: string; kind: PackGuardKind }>;
}

const compiledCache = new Map<string, CompiledDocumentGuards | null>();
const CACHE_MAX = 512;

function compileDocumentGuards(
  pack: SitePackV1 | null,
  policy: WritePolicy,
  defaults: readonly BuiltinGuard[],
): CompiledDocumentGuards | null {
  const entries: { packId: string; guard: BuiltinGuard }[] = [
    ...(pack?.guards ?? []).map((guard) => ({ packId: pack?.id ?? '', guard })),
    ...defaults.map((guard) => ({ packId: BUILTIN_PACK_ID, guard })),
  ];
  const byRule = new Map<string, { packId: string; guardId: string; kind: PackGuardKind }>();
  const result = compileRequestGuardRules(
    entries.map(({ packId, guard }) => {
      const id = `${packId}#${guard.id}`;
      byRule.set(id, { packId, guardId: guard.id, kind: guard.kind });
      return {
        id,
        url: guard.match.url,
        ...(guard.match.methods !== undefined && { methods: guard.match.methods }),
        ...(guard.match.resource_types !== undefined && {
          resourceTypes: guard.match.resource_types,
        }),
        action: effectiveAction(guard.action, policy),
      };
    }),
  );
  return result.ok ? { rules: result.value, byRule } : null;
}

/**
 * The guard a `GET` document load of `url` hits (spec 13 §9.3 the tool layer): the guards of the
 * pack owning the URL (`pack`, `null` when none), then the compiled-in defaults; the first match
 * decides, an `allow` included. `cacheKey` names the pack content (its SHA-256). A rule set the
 * guard grammar refuses (data `refinePack` let through by mistake) matches nothing here; the
 * network guard is the boundary.
 */
export function matchDocumentGuard(input: {
  readonly pack: SitePackV1 | null;
  readonly cacheKey: string;
  readonly policy: WritePolicy;
  readonly defaults: readonly BuiltinGuard[];
  readonly url: string;
}): DocumentGuardHit | null {
  if ((input.pack?.guards.length ?? 0) === 0 && input.defaults.length === 0) return null;
  const key = `${input.cacheKey}\u0000${input.policy}\u0000${input.defaults.length}`;
  let compiled = compiledCache.get(key);
  if (compiled === undefined) {
    compiled = compileDocumentGuards(input.pack, input.policy, input.defaults);
    if (compiledCache.size >= CACHE_MAX) compiledCache.clear();
    compiledCache.set(key, compiled);
  }
  if (compiled === null) return null;
  const hit = matchRequestGuard(compiled.rules, {
    url: input.url,
    method: 'GET',
    resourceType: 'document',
  });
  if (hit === null) return null;
  const meta = compiled.byRule.get(hit.rule.id);
  if (meta === undefined) return null;
  return { ...meta, ruleId: hit.rule.id, action: hit.rule.action };
}

/** The element guards of `pack` whose `page` glob matches `pageUrl`, in pack order. */
export function elementGuardsFor(pack: SitePackV1, pageUrl: string): readonly PackElementGuard[] {
  return pack.element_guards.filter((guard) => matchesPackGlob(guard.page, pageUrl));
}
