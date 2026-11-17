/** @module domain/site-packs/pack-glob — a pack's page, challenge and redirect URL globs (spec 13 §9.2 `UrlGlob`) matched with the guard grammar of §9.3: spec 11 §5 globs, case-insensitive, the implicit `/*` and query-string variants, unreserved escapes decoded. */

import {
  compileRequestGuardRules,
  matchRequestGuard,
  type RequestGuardRules,
} from '../policies/request-guard.ts';

/** Compiled globs, keyed by their text (pack globs are few and bounded per pack). */
const cache = new Map<string, RequestGuardRules | null>();
/** Bound of {@link cache}; it is emptied when full (a reload brings a new set anyway). */
const CACHE_MAX = 4_096;

function compiled(glob: string): RequestGuardRules | null {
  const hit = cache.get(glob);
  if (hit !== undefined) return hit;
  // One rule over `GET document`: the request guard's URL semantics, nothing of its method/type.
  const result = compileRequestGuardRules([
    { id: 'glob', url: glob, methods: ['GET'], resourceTypes: ['document'], action: 'block' },
  ]);
  const rules = result.ok ? result.value : null;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(glob, rules);
  return rules;
}

/**
 * True when `url` matches the pack glob `glob` (`www.linkedin.com/checkpoint/*`). A glob the guard
 * grammar refuses (empty, non-ASCII, match-everything) matches nothing; `refinePack` refused such a
 * pack long before, so this only guards against a caller's own data. Never throws.
 */
export function matchesPackGlob(glob: string, url: string): boolean {
  const rules = compiled(glob);
  if (rules === null) return false;
  return matchRequestGuard(rules, { url, method: 'GET', resourceType: 'document' }) !== null;
}

/** True when `url` matches any of `globs`. */
export function matchesAnyPackGlob(globs: readonly string[], url: string): boolean {
  return globs.some((glob) => matchesPackGlob(glob, url));
}
