/** @module domain/site-packs/auto-update — whether auto-update may apply a registry candidate by itself (spec 13 §9.7 "Apply rules", deferred D74 / T3b review S-I3): only a `tightening` or `neutral` candidate that adds no domain, and, because a stolen online key could otherwise flood a pack with "tightening" blocks (a denial of the agents' work that applies itself), only while one version adds at most {@link AUTO_MAX_ADDED_BLOCKING} blocking or confirming guards and no broad element guard. Anything else waits for an operator. */

import type { PackElementGuard, PackGuard, SitePackV1 } from '@browserhive/contracts/site-packs';

/** Blocking (`block`, `confirm`) network or element guards one auto-applied version may add. */
export const AUTO_MAX_ADDED_BLOCKING = 3;

/** Why auto-update leaves a candidate for an operator, or `null` when it may apply it. */
export type AutoApplyHold =
  | 'classification'
  | 'domains'
  | 'too_many_blocking_guards'
  | 'broad_element_guard'
  | 'host_wide_guard';

const BLOCKING: ReadonlySet<string> = new Set(['block', 'confirm']);

/** A selector list that is a bare type, universal or very short selector (matches most pages' controls). */
function broadSelector(selector: string): boolean {
  return selector
    .split(',')
    .map((s) => s.trim())
    .some((s) => s === '*' || /^[a-z]+$/i.test(s) || s.length < 4);
}

function isBroadElementGuard(guard: PackElementGuard): boolean {
  if (!BLOCKING.has(guard.action)) return false;
  if ('selector' in guard.target) return broadSelector(guard.target.selector);
  return false;
}

/** A glob whose path part is only a wildcard (`host/*`, `*.host/*`): it covers a whole host. */
function hostWide(guard: PackGuard): boolean {
  const glob = guard.match.url;
  const slash = glob.indexOf('/');
  const path = slash === -1 ? '' : glob.slice(slash);
  return path === '' || /^\/\**$/.test(path);
}

/**
 * The reason auto-update must not apply `to` over `from`, or `null`. `classification` is the
 * candidate's stored class (`tightening`, `neutral` may apply), `newDomains` the domains it adds.
 */
export function autoApplyHold(
  from: SitePackV1,
  to: SitePackV1,
  classification: string,
  newDomains: readonly string[],
): AutoApplyHold | null {
  if (classification !== 'tightening' && classification !== 'neutral') return 'classification';
  if (newDomains.length > 0 || to.domains.length !== from.domains.length) return 'domains';
  // A guard is "added" when it is new or newly blocking (an action made `block` or `confirm`).
  const before = new Map(from.guards.map((g) => [g.id, g.action]));
  const beforeElements = new Map(from.element_guards.map((g) => [g.id, g.action]));
  const newlyBlocking = (old: string | undefined, action: string) =>
    BLOCKING.has(action) && (old === undefined || !BLOCKING.has(old));
  const addedGuards = to.guards.filter((g) => newlyBlocking(before.get(g.id), g.action));
  const addedElements = to.element_guards.filter((g) =>
    newlyBlocking(beforeElements.get(g.id), g.action),
  );
  if (addedGuards.some(hostWide)) return 'host_wide_guard';
  if (addedElements.some(isBroadElementGuard)) return 'broad_element_guard';
  if (addedGuards.length + addedElements.length > AUTO_MAX_ADDED_BLOCKING) {
    return 'too_many_blocking_guards';
  }
  return null;
}
