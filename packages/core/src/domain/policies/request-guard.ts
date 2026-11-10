/** @module domain/policies/request-guard — pure method-, URL- and resource-type-aware request rules: compile, match, atomic holder (spec 13 §9.3, D-54). */

import { globToRegExp, hasGlobWildcard } from '../../kernel/glob.ts';
import { err, ok, type Result } from '../../kernel/result.ts';
import { blocklistComparisonForms } from './blocklist.ts';

/**
 * The request guard decides, per routed request, whether a rule about *what may be sent* applies.
 * The blocklist (spec 11 §5) keeps agents off pages: it aborts document loads by URL and reads no
 * method. A guard can say "never `POST` to `/logout`" or "never send a beacon to `/api/delete`",
 * which is how sites sign out or change account state (issue #59).
 *
 * Matching (all three must hold; the **first** matching rule decides, later rules are not read):
 * - **URL** — the spec 11 §5 glob grammar: `*` and `?` only (`?` is one character, never a
 *   literal question mark), case-insensitive, against `scheme://host[/path?query]` and
 *   `host[/path?query]` (the blocklist's comparison forms). A pattern that does not end in `*` is
 *   also tried as `<pattern>/*` (the blocklist's implicit suffix: paths beneath) **and, for guards
 *   only, as `<pattern>` followed by a literal `?` and anything** (the same path with any query
 *   string). So `site.test/logout` matches `/logout`, `/logout/now` and `/logout?next=/`, but not
 *   `/logout-help`. Logout and write endpoints routinely carry `continue=`, `next=`, CSRF tokens
 *   or ids in the query, and a guard that a query string defeats is no guard; the blocklist keeps
 *   its stricter grammar unchanged. Percent-encodings of unreserved characters (RFC 3986 §2.3:
 *   letters, digits, `-._~`) are decoded on both sides before matching, so `/log%6Fut` is
 *   `/logout`, as the server reads it. A URL without a network scheme (`about:`, `data:`, `blob:`)
 *   or that does not parse matches nothing. Rule hosts must be ASCII (punycode for IDNs): the
 *   comparison forms are punycode, so a Unicode host would never match.
 * - **Method** — `methods` absent matches every method that reaches the route; present, the
 *   request's upper-cased method must be listed. A CORS preflight never reaches it: with routing
 *   on, Playwright answers `OPTIONS` preflights itself (spec 13 §3.8); only an `OPTIONS` request a
 *   page sends itself does.
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

/** A compiled rule: lowercased URL glob, its matchers, method and type sets resolved. */
export interface RequestGuardRule {
  readonly id: string;
  /** The normalized glob, for display and hits. */
  readonly url: string;
  /** Compiled once per rule set: the glob, then the `/*` and `?` variants (see the module doc). */
  readonly matchers: readonly UrlMatcher[];
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

/** One compiled form of a rule's URL glob: plain equality when it has no wildcard. */
export type UrlMatcher =
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'regexp'; readonly re: RegExp };

/** The rule list that never matches. */
export const EMPTY_REQUEST_GUARD_RULES: RequestGuardRules = Object.freeze({ rules: [] });

/** A guard id (spec 13 §9.2 `Id`), optionally qualified by its pack: `linkedin.com#logout`. */
const ID_RE = /^(?:[a-z0-9][a-z0-9.-]{0,252}#)?[a-z][a-z0-9-]{0,39}$/;
const METHOD_SET: ReadonlySet<string> = new Set(GUARD_METHODS);
const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set(GUARD_RESOURCE_TYPES);
const DEFAULT_TYPES: ReadonlySet<string> = new Set(DEFAULT_GUARD_RESOURCE_TYPES);
const ACTION_SET: ReadonlySet<string> = new Set<RequestGuardAction>([
  'block',
  'confirm',
  'warn',
  'allow',
]);
/** Printable ASCII only: a Unicode host never equals the punycode comparison form. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const UNRESERVED_ESCAPE = /%([0-9a-f]{2})/gi;
const UNRESERVED = /^[a-z0-9\-._~]$/i;

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
    const url = decodeUnreserved(input.url.trim().toLowerCase());
    if (url.length === 0) return refuse('url is empty');
    if (url.length > MAX_GUARD_URL_LENGTH) return refuse('url is too long');
    if (!PRINTABLE_ASCII.test(url)) {
      return refuse('url must be printable ASCII (punycode hosts, percent-encoded paths)');
    }
    // The blocklist refuses the same two: a rule matching every URL blocks a whole browser.
    if (url === '*' || url === '*/*') return refuse('url matches every URL');
    const methods = setOf(input.methods, METHOD_SET);
    if (methods === 'invalid') return refuse('methods must be a non-empty list of known methods');
    const types = setOf(input.resourceTypes, RESOURCE_TYPE_SET);
    if (types === 'invalid') {
      return refuse('resource types must be a non-empty list of known types');
    }
    // A rule source with unchecked data (a pack's unresolved `write_policy`) must not get a rule
    // whose action the guard cannot act on.
    if (!ACTION_SET.has(input.action))
      return refuse('action must be block, confirm, warn or allow');
    ids.add(input.id);
    rules.push({
      id: input.id,
      url,
      matchers: matchersFor(url),
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

/** The glob, then (when it does not end in `*`) its `/*` and literal-`?` variants. */
function matchersFor(pattern: string): readonly UrlMatcher[] {
  const compile = (glob: string): UrlMatcher =>
    hasGlobWildcard(glob)
      ? { kind: 'regexp', re: globToRegExp(glob) }
      : { kind: 'equals', value: glob };
  if (pattern.endsWith('*')) return [compile(pattern)];
  const base = globToRegExp(pattern).source.slice(1, -1); // drop the anchors
  return [
    compile(pattern),
    compile(`${pattern}/*`),
    { kind: 'regexp', re: new RegExp(`^${base}\\?.*$`) },
  ];
}

/** Decodes `%XX` escapes of unreserved characters (RFC 3986 §2.3), lowercased. */
function decodeUnreserved(value: string): string {
  if (!value.includes('%')) return value;
  return value.replace(UNRESERVED_ESCAPE, (encoded, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char.toLowerCase() : encoded;
  });
}

function matches(matcher: UrlMatcher, form: string): boolean {
  return matcher.kind === 'equals' ? matcher.value === form : matcher.re.test(form);
}

/**
 * The first rule that matches `request`, or `null`. Never throws for expected input; the URL is
 * reduced once and shared by every rule, and each rule's matchers were compiled with the set.
 */
export function matchRequestGuard(
  rules: RequestGuardRules,
  request: GuardedRequest,
): RequestGuardMatch | null {
  if (rules.rules.length === 0) return null;
  const raw = blocklistComparisonForms(request.url);
  if (raw === null) return null;
  const forms = [decodeUnreserved(raw[0]), decodeUnreserved(raw[1])];
  const method = request.method.toUpperCase();
  for (const rule of rules.rules) {
    if (rule.methods !== null && !rule.methods.has(method)) continue;
    if (!rule.resourceTypes.has(request.resourceType)) continue;
    for (const form of forms) {
      for (const matcher of rule.matchers) {
        if (matches(matcher, form)) return { rule, matched: form };
      }
    }
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
