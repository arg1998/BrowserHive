/** @module domain/site-packs/pack-glob — a pack's page, challenge and redirect URL globs (spec 13 §9.2 `UrlGlob`) matched with the guard grammar of §9.3: spec 11 §5 globs, case-insensitive, the implicit `/*` and query-string variants, unreserved escapes decoded; and whether two pack globs can match the same address (`packGlobsOverlap`). */

import { type GlobToken, globTokens, globTokensIntersect } from '../../kernel/glob.ts';
import { decodeUnreserved } from '../policies/guard-url.ts';
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

/** A pack glob's host part and the token lists its path matches with: the path itself and, without a final `*`, its `/*` and `?…` variants (the guard grammar). */
function partsOf(glob: string): { host: GlobToken[]; paths: GlobToken[][] } {
  const text = decodeUnreserved(glob.trim().toLowerCase());
  const slash = text.indexOf('/');
  const host = globTokens(slash < 0 ? text : text.slice(0, slash));
  const path = globTokens(slash < 0 ? '' : text.slice(slash));
  if (text.endsWith('*')) return { host, paths: [path] };
  const star: GlobToken = { kind: 'star' };
  return {
    host,
    paths: [
      path,
      [...path, { kind: 'char', char: '/' }, star],
      [...path, { kind: 'char', char: '?' }, star],
    ],
  };
}

/**
 * True when some address matches both pack globs under the guard grammar (`matchesPackGlob`): a
 * guard on `www.linkedin.com/checkpoint/*` overlaps the sign-in post target
 * `www.linkedin.com/checkpoint/lg/login-submit`, one on `www.linkedin.com/settings` does not.
 * Hosts and paths are compared apart, since a host never holds a `/` (so `*.linkedin.com/jobs*`
 * does not reach into another path's query); within the path it is exact over the glob languages
 * (any characters, the query included), so it errs toward "overlaps". Never throws.
 */
export function packGlobsOverlap(a: string, b: string): boolean {
  const left = partsOf(a);
  const right = partsOf(b);
  if (!globTokensIntersect(left.host, right.host)) return false;
  return left.paths.some((x) => right.paths.some((y) => globTokensIntersect(x, y)));
}
