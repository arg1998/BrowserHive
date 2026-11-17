/** @module domain/site-packs/classify-rules — spec 13 §9.7 for `guards`, `element_guards` and `challenges`: an entry added or made stricter tightens, and is **restrictive** when its match covers the pack's probe path, its sign-in URL or a whole host (a challenge also when a member would match every page); an entry removed, laxer, or with its match, target or `request_guard` changed loosens. */

import type {
  PackChallenge,
  PackElementGuard,
  PackGuard,
  SitePackV1,
} from '@browserhive/contracts/site-packs';
import { compileRequestGuardRules, matchRequestGuard } from '../policies/request-guard.ts';
import type { ChangeClass, ClassifyInput } from './classify-types.ts';
import { scopedUrl, scopeOfGlob } from './glob-scope.ts';
import { matchesPackGlob } from './pack-glob.ts';

/** Guard actions from laxest to strictest; `write_policy` stands apart (any move to or from it loosens). */
const GUARD_ORDER = ['warn', 'confirm', 'block'] as const;

/** Landmarks present on every page (spec 13 §9.7 "would match every page"). */
const EVERY_PAGE_LANDMARKS: ReadonlySet<string> = new Set(['body', 'html', ':root', 'head', '*']);

/** A `text` or `title_contains` this short matches nearly every page. */
const MIN_SPECIFIC_TEXT = 4;

/** One change of a guard or element guard: `rest` is `''` for the whole entry, else the field path. */
export function classifyGuardChange(
  list: 'guards' | 'element_guards',
  id: string,
  rest: string,
  { from, to }: ClassifyInput,
): ChangeClass {
  const entries = (pack: SitePackV1): readonly (PackGuard | PackElementGuard)[] =>
    list === 'guards' ? pack.guards : pack.element_guards;
  const before = findById(entries(from), id);
  const after = findById(entries(to), id);
  if (rest === '') {
    if (before !== undefined || after === undefined) return 'loosening';
    return canStop(after.action) && coversCritical(list, after, to) ? 'restrictive' : 'tightening';
  }
  if (rest === 'action' && before !== undefined && after !== undefined) {
    if (before.action === 'write_policy' || after.action === 'write_policy') return 'loosening';
    const a = GUARD_ORDER.indexOf(before.action);
    const b = GUARD_ORDER.indexOf(after.action);
    if (b === a) return 'neutral';
    if (b < a) return 'loosening';
    return canStop(after.action) && coversCritical(list, after, to) ? 'restrictive' : 'tightening';
  }
  // `match`, `page`, `target`, `request_guard`, `kind`: changed is loosening (default deny).
  return 'loosening';
}

/** One change of a challenge. */
export function classifyChallengeChange(
  id: string,
  rest: string,
  { from, to }: ClassifyInput,
): ChangeClass {
  const before = findById(from.challenges, id);
  const after = findById(to.challenges, id);
  if (rest === '') {
    if (before !== undefined || after === undefined) return 'loosening';
    return challengeCoversCritical(after, to) ? 'restrictive' : 'tightening';
  }
  if (rest === 'action' && before !== undefined && after !== undefined) {
    if (before.action === after.action) return 'neutral';
    if (after.action === 'attention') return 'loosening';
    return challengeCoversCritical(after, to) ? 'restrictive' : 'tightening';
  }
  // `match` changed, `kind` changed: loosening.
  return 'loosening';
}

function findById<T extends { readonly id: string }>(
  list: readonly T[],
  id: string,
): T | undefined {
  return list.find((x) => x.id === id);
}

/**
 * A `warn` guard only reports; it cannot stop anything, so it is never restrictive
 * (decision recorded in the T3b WP-K report).
 */
function canStop(action: PackGuard['action']): boolean {
  return action !== 'warn';
}

/** The pages a pack itself depends on: its probe and its sign-in page. */
function criticalUrls(pack: SitePackV1): { probe: string; signIn: string | null } {
  return {
    probe: scopedUrl(pack.signed_in.probe),
    signIn: pack.sign_in === undefined ? null : scopedUrl(pack.sign_in.url),
  };
}

function wholeHost(glob: string, pack: SitePackV1): boolean {
  const scoped = scopeOfGlob(glob, pack.domains);
  return scoped.ok && scoped.value.wholeHost;
}

/** True when the guard's match covers the probe path, the sign-in URL or a whole host. */
function coversCritical(
  list: 'guards' | 'element_guards',
  guard: PackGuard | PackElementGuard,
  pack: SitePackV1,
): boolean {
  const { probe, signIn } = criticalUrls(pack);
  if ('page' in guard) {
    if (list !== 'element_guards') return false;
    return (
      wholeHost(guard.page, pack) ||
      matchesPackGlob(guard.page, probe) ||
      (signIn !== null && matchesPackGlob(guard.page, signIn))
    );
  }
  if (wholeHost(guard.match.url, pack)) return true;
  const compiled = compileRequestGuardRules([
    {
      id: guard.id,
      url: guard.match.url,
      ...(guard.match.methods !== undefined && { methods: guard.match.methods }),
      // As the request guard reads it (guard-rules.ts): account guards cover every type.
      ...(guard.match.resource_types !== undefined
        ? { resourceTypes: guard.match.resource_types }
        : guard.kind !== 'write' && { resourceTypes: 'all' as const }),
      action: 'block',
    },
  ]);
  if (!compiled.ok) return false;
  const hits = (url: string, method: string) =>
    matchRequestGuard(compiled.value, { url, method, resourceType: 'document' }) !== null;
  // The probe loads its page with GET; a sign-in loads the page and posts its form.
  return hits(probe, 'GET') || (signIn !== null && (hits(signIn, 'GET') || hits(signIn, 'POST')));
}

/** True when a challenge would fire on the probe or sign-in page, or on every page. */
function challengeCoversCritical(challenge: PackChallenge, pack: SitePackV1): boolean {
  const { probe, signIn } = criticalUrls(pack);
  const m = challenge.match;
  if (m.url !== undefined) {
    if (matchesPackGlob(m.url, probe) || (signIn !== null && matchesPackGlob(m.url, signIn))) {
      return true;
    }
  }
  if (m.landmark !== undefined && EVERY_PAGE_LANDMARKS.has(m.landmark.trim().toLowerCase())) {
    return true;
  }
  const short = (text: string | undefined) =>
    text !== undefined && text.trim().length < MIN_SPECIFIC_TEXT;
  return short(m.text) || short(m.title_contains);
}
