/** @module kernel/glob — anchored `*`/`?` glob matcher for slugs, origins and blocklist patterns. */

/**
 * A tiny, deliberately under-powered matcher: the *only* metacharacters are `*` and `?`, and every
 * other byte — including `.`, `/`, `-`, and every regex-special character — is a literal. This is
 * not a general glob (no `[...]` classes, no `{a,b}` braces, no `**` path semantics); it is a
 * whole-string wildcard test and nothing more. Callers that need case-insensitivity lowercase both
 * sides themselves; the match here is case-*sensitive*.
 *
 * Semantics:
 * - **Anchored / whole-string.** `agent-*` matches `agent-1` but not `other-agent-1`.
 * - **`*`** matches any run of zero-or-more characters. A bare `*` matches everything.
 * - **`?`** matches exactly one character (never zero).
 * - **Everything else is literal.** `a.b` matches only `a.b`, never `axb`.
 * - **No-wildcard patterns are plain equality.**
 * - **Empty pattern** matches only the empty value.
 *
 * SECURITY — ReDoS safety. The RegExp is built by first escaping *all* regex metacharacters, then
 * replacing the now-escaped `\*` → `.*` and `\?` → `.`. User input can inject no quantifier, group
 * or backreference; the result is a flat sequence with no nested quantifiers, so it cannot
 * backtrack catastrophically. Patterns over {@link MAX_PATTERN_LENGTH} fail closed.
 */

/** Defensive upper bound on pattern length. Longer patterns fail closed (see {@link matchesGlob}). */
export const MAX_PATTERN_LENGTH = 1000;

/** Matches a single regex metacharacter, escaped in the replacement to a literal `\<char>`. */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Compiles `pattern` to an anchored RegExp under the module's glob semantics.
 *
 * @remarks Exported for tests; callers use {@link matchesGlob}. Carries no flags (case-sensitive).
 */
export function globToRegExp(pattern: string): RegExp {
  // Step 1: escape every regex metacharacter, so the user's input can inject nothing.
  const escaped = pattern.replace(REGEX_META, '\\$&');
  // Step 2: turn the escaped wildcard forms into their regex atoms.
  const body = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${body}$`);
}

/**
 * True iff `value` matches `pattern` under the anchored glob semantics.
 *
 * Never throws. Fails closed (`false`) when `pattern` exceeds {@link MAX_PATTERN_LENGTH}.
 */
export function matchesGlob(value: string, pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  // Fast path: a pattern with no wildcards is a plain equality check.
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return value === pattern;
  }
  return globToRegExp(pattern).test(value);
}

/** True when `pattern` contains a wildcard (`*` or `?`). */
export function hasGlobWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}
