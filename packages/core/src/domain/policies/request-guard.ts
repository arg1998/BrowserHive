/** @module domain/policies/request-guard — pure method-, URL- and resource-type-aware request rules: compile, match, atomic holder (spec 13 §9.3, D-54). */

import { err, ok, type Result } from '../../kernel/result.ts';
import { blocklistComparisonForms, matchBlocklistPattern } from './blocklist.ts';

/**
 * The request guard decides, per routed request, whether a rule about *what may be sent* applies.
 * The blocklist (spec 11 §5) keeps agents off pages: it aborts document loads by URL and reads no
 * method. A guard can say "never `POST` to `/logout`" or "never send a beacon to `/api/delete`",
 * which is how sites sign out or change account state (issue #59).
 *
 * Matching (all three must hold; the **first** matching rule decides, later rules are not read):
 * - **URL** — the spec 11 §5 glob grammar, the same matcher as the blocklist
 *   ({@link matchBlocklistPattern}): `*` and `?` only, case-insensitive, against
 *   `scheme://host[/path?query]` and `host[/path?query]`, with the implicit `/*` suffix. A URL
 *   without a network scheme (`about:`, `data:`, `blob:`) or that does not parse matches nothing.
 * - **Method** — `methods` absent matches every method (including `HEAD` and `OPTIONS`);
 *   present, the request's upper-cased method must be listed.
 * - **Resource type** — Playwright's name of the request's type. `resourceTypes` absent means
 *   {@link DEFAULT_GUARD_RESOURCE_TYPES}; a type outside {@link GUARD_RESOURCE_TYPES} (`image`,
 *   `script`, `stylesheet`, …) never matches, and `other` is Playwright's literal `other`.
 *
 * Rule actions are **effective** actions. A site pack's `write_policy` action (spec 13 §9.2) is
 * resolved by the rule source (PR T3a) to `allow`, `warn` or `confirm` before a rule reaches this
 * matcher, so a matching `allow` rule is a decision too: it lets the request pass and stops the
 * search, which is what "the first matching guard decides" means for a site whose write policy is
 * `allow`.
 *
 * There are no operator-configured rules: the rules come from site packs (PR T3a); until then
 * only tests supply them.
 */

/** Methods a rule can name (spec 13 §9.2 `Method`). */
export const GUARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** One of {@link GUARD_METHODS}. */
export type GuardMethod = (typeof GUARD_METHODS)[number];

/**
 * Resource types a rule can name (spec 13 §9.2 `ResourceType`, Playwright's names). Beacons
 * (`navigator.sendBeacon`) arrive as `ping`, measured on Chromium (review I-3).
 */
export const GUARD_RESOURCE_TYPES = [
  'document',
  'xhr',
  'fetch',
  'ping',
  'eventsource',
  'other',
] as const;

/** One of {@link GUARD_RESOURCE_TYPES}. */
export type GuardResourceType = (typeof GUARD_RESOURCE_TYPES)[number];

/**
 * The types a rule without `resourceTypes` covers: the ones a page can send a state change with.
 * `eventsource` and `other` must be named, so a broad rule does not abort a site's live updates.
 */
export const DEFAULT_GUARD_RESOURCE_TYPES: readonly GuardResourceType[] = Object.freeze([
  'document',
  'xhr',
  'fetch',
  'ping',
]);

/** What a matching rule does. `write_policy` never reaches the matcher (see the module doc). */
export type RequestGuardAction = 'block' | 'confirm' | 'warn' | 'allow';

/** Upper bound of a rule's URL glob (spec 13 §9.2 `UrlGlob`). */
export const MAX_GUARD_URL_LENGTH = 300;

/** A rule as a rule source supplies it. */
export interface RequestGuardRuleInput {
  /** Stable id, reported in hits (`<pack id>#<guard id>` once packs supply rules). */
  readonly id: string;
  /** A spec 11 §5 glob. */
  readonly url: string;
  /** Absent: every method. */
  readonly methods?: readonly GuardMethod[];
  /** Absent: {@link DEFAULT_GUARD_RESOURCE_TYPES}. */
  readonly resourceTypes?: readonly GuardResourceType[];
  readonly action: RequestGuardAction;
}

/** A compiled rule: lowercased URL glob, method and type sets resolved. */
export interface RequestGuardRule {
  readonly id: string;
  readonly url: string;
  /** `null`: every method. */
  readonly methods: ReadonlySet<string> | null;
  readonly resourceTypes: ReadonlySet<string>;
  readonly action: RequestGuardAction;
}

/** A compiled, ordered rule list. */
export interface RequestGuardRules {
  readonly rules: readonly RequestGuardRule[];
}

/** Why a rule list was refused: the offending rule's index and id, and the reason. */
export interface RequestGuardRuleError {
  readonly index: number;
  readonly id: string;
  readonly reason: string;
}

/** The request facts a rule is matched against. */
export interface GuardedRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}

/** The rule that decided, and the comparison form its URL glob matched. */
export interface RequestGuardMatch {
  readonly rule: RequestGuardRule;
  readonly matched: string;
}

/** The rule list that never matches. */
export const EMPTY_REQUEST_GUARD_RULES: RequestGuardRules = Object.freeze({ rules: [] });

/** A guard id (spec 13 §9.2 `Id`), optionally qualified by its pack: `linkedin.com#logout`. */
const ID_RE = /^(?:[a-z0-9][a-z0-9.-]{0,252}#)?[a-z][a-z0-9-]{0,39}$/;
const METHOD_SET: ReadonlySet<string> = new Set(GUARD_METHODS);
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(GUARD_RESOURCE_TYPES);
const DEFAULT_TYPES: ReadonlySet<string> = new Set(DEFAULT_GUARD_RESOURCE_TYPES);

/**
 * Compile an ordered rule list. Refuses the whole list on the first unusable rule: a guard is a
 * safety rule, so a list that silently lost one would read as protection it does not give. A
 * rule source (PR T3a) validates its data first; this is the last check, not the schema.
 */
export function compileRequestGuardRules(
  inputs: readonly RequestGuardRuleInput[],
): Result<RequestGuardRules, RequestGuardRuleError> {
  const rules: RequestGuardRule[] = [];
  const ids = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const refuse = (reason: string) => err({ index, id: input.id, reason });
    if (!ID_RE.test(input.id)) return refuse('id must be a lowercase slug');
    if (ids.has(input.id)) return refuse('duplicate id');
    const url = input.url.trim().toLowerCase();
    if (url.length === 0) return refuse('url is empty');
    if (url.length > MAX_GUARD_URL_LENGTH) return refuse('url is too long');
    // The blocklist refuses the same two: a rule matching every URL blocks a whole browser.
    if (url === '*' || url === '*/*') return refuse('url matches every URL');
    const methods = setOf(input.methods, METHOD_SET);
    if (methods === 'invalid') return refuse('methods must be a non-empty list of known methods');
    const types = setOf(input.resourceTypes, RESOURCE_TYPE_SET);
    if (types === 'invalid') {
      return refuse('resource types must be a non-empty list of known types');
    }
    ids.add(input.id);
    rules.push({
      id: input.id,
      url,
      methods,
      resourceTypes: types ?? DEFAULT_TYPES,
      action: input.action,
    });
  }
  return ok({ rules });
}

/** `null` for an absent list, the set for a valid one, `'invalid'` for an empty or unknown entry. */
function setOf(
  values: readonly string[] | undefined,
  known: ReadonlySet<string>,
): ReadonlySet<string> | null | 'invalid' {
  if (values === undefined) return null;
  if (values.length === 0 || values.some((v) => !known.has(v))) return 'invalid';
  return new Set(values);
}

/**
 * The first rule that matches `request`, or `null`. Never throws for expected input; the URL is
 * reduced once and shared by every rule.
 */
export function matchRequestGuard(
  rules: RequestGuardRules,
  request: GuardedRequest,
): RequestGuardMatch | null {
  if (rules.rules.length === 0) return null;
  const forms = blocklistComparisonForms(request.url);
  if (forms === null) return null;
  const method = request.method.toUpperCase();
  for (const rule of rules.rules) {
    if (rule.methods !== null && !rule.methods.has(method)) continue;
    if (!rule.resourceTypes.has(request.resourceType)) continue;
    const matched = matchBlocklistPattern(rule.url, forms);
    if (matched !== null) return { rule, matched };
  }
  return null;
}

/**
 * Where the guard reads the rules for a request. A site-pack source (PR T3a) returns the rules of
 * the pack owning the URL's registrable domain followed by `DEFAULT_GUARDS`; it is called on
 * every request, so a reload takes effect on the next one (the D-22 pattern).
 */
export interface RequestGuardRuleSource {
  rulesFor(url: string): RequestGuardRules;
}

/**
 * One rule list for every URL, with atomic replacement (the blocklist holder's pattern, D-22):
 * readers see either the old list or the new one.
 */
export class RequestGuardRuleSet implements RequestGuardRuleSource {
  private rules: RequestGuardRules;

  constructor(initial: RequestGuardRules = EMPTY_REQUEST_GUARD_RULES) {
    this.rules = initial;
  }

  /** The list in force, whatever the URL. */
  rulesFor(_url: string): RequestGuardRules {
    return this.rules;
  }

  /** Swap the whole list in one assignment. */
  replace(rules: RequestGuardRules): void {
    this.rules = rules;
  }
}
