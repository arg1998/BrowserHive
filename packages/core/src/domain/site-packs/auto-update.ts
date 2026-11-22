/** @module domain/site-packs/auto-update — whether auto-update may apply a registry candidate by itself (spec 13 §9.7 "Apply rules", D-85, D-87; owner policy "stealth and security first class"): only changes that cannot stop or block agents' work on a site. A stolen online key must not be able to halt a followed site for agents by publishing a "tightening" version: so beyond the classifier's verdict (only `tightening` or `neutral`, no domain change), a version waits for an operator when it adds or changes a challenge or an element guard, adds a host-wide blocking guard or more than {@link AUTO_MAX_ADDED_BLOCKING} newly blocking guards, turns `sign_in.human_only` on, lowers `concurrency.max_sessions`, adds a pace rule, adds or removes a strategy, or slows a launch gap, pace limit or numeric strategy parameter by more than {@link AUTO_MAX_SLOWDOWN}×. */

import type { PackGuard, SitePackV1 } from '@browserhive/contracts/site-packs';

/** Blocking (`block`, `confirm`) network guards one auto-applied version may make newly blocking. */
export const AUTO_MAX_ADDED_BLOCKING = 3;
/** How much slower one auto-applied version may make launches, pacing or a strategy parameter. */
export const AUTO_MAX_SLOWDOWN = 2;
/** A launch gap up to this many seconds is never a slowdown (from 0 to a few seconds). */
const GAP_FREE_S = 30;

/** Why auto-update leaves a candidate for an operator, or `null` when it may apply it. */
export type AutoApplyHold =
  | 'classification'
  | 'domains'
  | 'too_many_blocking_guards'
  | 'host_wide_guard'
  | 'challenges'
  | 'element_guards'
  | 'human_only'
  | 'concurrency'
  | 'pacing'
  | 'strategies';

const BLOCKING: ReadonlySet<string> = new Set(['block', 'confirm']);

/** A glob whose path part is only a wildcard (`host/*`, `*.host/*`): it covers a whole host. */
function hostWide(guard: PackGuard): boolean {
  const glob = guard.match.url;
  const slash = glob.indexOf('/');
  const path = slash === -1 ? '' : glob.slice(slash);
  return path === '' || /^\/\**$/.test(path);
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Any entry of `to` absent from or different in `from`, or one removed (by id). */
function changedById<T extends { readonly id: string }>(
  from: readonly T[],
  to: readonly T[],
): boolean {
  if (from.length !== to.length) return true;
  const before = new Map(from.map((x) => [x.id, json(x)]));
  return to.some((x) => before.get(x.id) !== json(x));
}

function pacingHold(from: SitePackV1, to: SitePackV1): boolean {
  const gapBefore = from.pacing?.min_launch_gap_s ?? 0;
  const gapAfter = to.pacing?.min_launch_gap_s ?? 0;
  if (gapAfter > Math.max(gapBefore * AUTO_MAX_SLOWDOWN, GAP_FREE_S)) return true;
  const before = new Map((from.pacing?.rules ?? []).map((r) => [r.id, r]));
  for (const rule of to.pacing?.rules ?? []) {
    const old = before.get(rule.id);
    if (old === undefined || old.per !== rule.per || old.guard !== rule.guard) return true;
    if (rule.limit * AUTO_MAX_SLOWDOWN < old.limit) return true;
  }
  return false;
}

function strategiesHold(from: SitePackV1, to: SitePackV1): boolean {
  const before = new Map((from.strategies ?? []).map((s) => [s.id, s.params]));
  const after = new Map((to.strategies ?? []).map((s) => [s.id, s.params]));
  if (before.size !== after.size) return true;
  for (const [id, params] of after) {
    const old = before.get(id);
    if (old === undefined) return true;
    for (const key of new Set([...Object.keys(old), ...Object.keys(params)])) {
      const a = old[key];
      const b = params[key];
      if (a === b) continue;
      if (typeof a !== 'number' || typeof b !== 'number') return true;
      // Either direction past the bound (a gap made longer, a budget made smaller) waits.
      const lo = Math.min(Math.abs(a), Math.abs(b));
      const hi = Math.max(Math.abs(a), Math.abs(b));
      if (hi > lo * AUTO_MAX_SLOWDOWN) return true;
    }
  }
  return false;
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
  if (newDomains.length > 0 || json([...from.domains].sort()) !== json([...to.domains].sort())) {
    return 'domains';
  }
  if (changedById(from.challenges ?? [], to.challenges ?? [])) return 'challenges';
  if (changedById(from.element_guards ?? [], to.element_guards ?? [])) return 'element_guards';
  if (from.sign_in?.human_only !== true && to.sign_in?.human_only === true) return 'human_only';
  const maxBefore = from.concurrency?.max_sessions ?? Number.POSITIVE_INFINITY;
  const maxAfter = to.concurrency?.max_sessions ?? Number.POSITIVE_INFINITY;
  if (maxAfter < maxBefore) return 'concurrency';
  if (pacingHold(from, to)) return 'pacing';
  if (strategiesHold(from, to)) return 'strategies';
  // A guard is "added" when it is new or newly blocking (an action made `block` or `confirm`).
  const before = new Map((from.guards ?? []).map((g) => [g.id, g.action]));
  const added = (to.guards ?? []).filter(
    (g) => BLOCKING.has(g.action) && !BLOCKING.has(before.get(g.id) ?? ''),
  );
  if (added.some(hostWide)) return 'host_wide_guard';
  if (added.length > AUTO_MAX_ADDED_BLOCKING) return 'too_many_blocking_guards';
  return null;
}
