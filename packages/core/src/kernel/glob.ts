/** @module kernel/glob — anchored `*`/`?` glob matcher for slugs, origins, blocklist patterns and site-pack globs, in linear time per `*` (no regular expressions, so no backtracking blow-up). */

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
 * SECURITY — no ReDoS (review PR #83 H1). Patterns are compiled into the parts between the stars
 * and matched without regular expressions: the first part is anchored at the start, the last at
 * the end, and each middle part is taken at its leftmost position after the previous one (leftmost
 * is always right for `*`-separated parts, so nothing is ever retried). The cost is one forward
 * scan per part: O(value × pattern) at worst, whatever the number of stars. Patterns over
 * {@link MAX_PATTERN_LENGTH} fail closed.
 */

/** Defensive upper bound on pattern length. Longer patterns fail closed (see {@link matchesGlob}). */
export const MAX_PATTERN_LENGTH = 1000;

/** One element of a pattern: a literal character, a one-character wildcard, or a star. */
export type GlobToken =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'one' }
  | { readonly kind: 'star' };

/** A run between stars: its text and, when it holds `?`, which positions match any character. */
interface Part {
  readonly text: string;
  /** `null` for a part of literal characters only (matched with `indexOf`/`startsWith`). */
  readonly any: readonly boolean[] | null;
}

/** A compiled pattern. */
export interface CompiledGlob {
  /** The parts between stars, in order (one part and no star: the whole value). */
  readonly parts: readonly Part[];
  /** True when the pattern holds at least one `*`. */
  readonly star: boolean;
}

/** The tokens of a `*`/`?` pattern. */
export function globTokens(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (const char of pattern) {
    if (char === '*') tokens.push({ kind: 'star' });
    else if (char === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'char', char });
  }
  return tokens;
}

/** Compiles tokens (a pattern's, possibly extended with literal characters) into parts. */
export function compileGlobTokens(tokens: readonly GlobToken[]): CompiledGlob {
  const parts: Part[] = [];
  let text = '';
  let any: boolean[] = [];
  let wild = false;
  let star = false;
  const flush = (): void => {
    parts.push({ text, any: wild ? any : null });
    text = '';
    any = [];
    wild = false;
  };
  for (const token of tokens) {
    if (token.kind === 'star') {
      star = true;
      flush();
    } else if (token.kind === 'one') {
      text += '?';
      any.push(true);
      wild = true;
    } else {
      text += token.char;
      for (let i = 0; i < token.char.length; i += 1) any.push(false);
    }
  }
  flush();
  return { parts, star };
}

/** Compiles a `*`/`?` pattern. */
export function compileGlob(pattern: string): CompiledGlob {
  return compileGlobTokens(globTokens(pattern));
}

/** True when `part` matches `value` at `at` (the caller checked the length). */
function partAt(part: Part, value: string, at: number): boolean {
  const any = part.any;
  if (any === null) return value.startsWith(part.text, at);
  for (let i = 0; i < part.text.length; i += 1) {
    if (any[i] !== true && value.charCodeAt(at + i) !== part.text.charCodeAt(i)) return false;
  }
  return true;
}

/** The leftmost position in `[from, last]` where `part` matches, or -1. */
function find(part: Part, value: string, from: number, last: number): number {
  if (part.any === null) {
    const at = value.indexOf(part.text, from);
    return at < 0 || at > last ? -1 : at;
  }
  for (let at = from; at <= last; at += 1) if (partAt(part, value, at)) return at;
  return -1;
}

/** True iff `value` matches the compiled pattern (see the module doc for the cost). Never throws. */
export function matchesCompiledGlob(glob: CompiledGlob, value: string): boolean {
  const { parts } = glob;
  const first = parts[0];
  if (first === undefined) return value.length === 0;
  if (!glob.star) return value.length === first.text.length && partAt(first, value, 0);
  const lastPart = parts[parts.length - 1] ?? first;
  const tail = value.length - lastPart.text.length;
  if (first.text.length > value.length || !partAt(first, value, 0)) return false;
  let pos = first.text.length;
  if (tail < pos || !partAt(lastPart, value, tail)) return false;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    const at = find(part, value, pos, tail - part.text.length);
    if (at < 0) return false;
    pos = at + part.text.length;
  }
  return true;
}

/**
 * True iff `value` matches `pattern` under the anchored glob semantics.
 *
 * Never throws. Fails closed (`false`) when `pattern` exceeds {@link MAX_PATTERN_LENGTH}.
 */
export function matchesGlob(value: string, pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  // Fast path: a pattern with no wildcards is a plain equality check.
  if (!hasGlobWildcard(pattern)) return value === pattern;
  return matchesCompiledGlob(compileGlob(pattern), value);
}

/** True when `pattern` contains a wildcard (`*` or `?`). */
export function hasGlobWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}
