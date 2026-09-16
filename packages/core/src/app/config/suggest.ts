/** @module app/config/suggest — "did you mean" matching: Damerau-Levenshtein ≤ 2, case-insensitive exact, kebab→camel and key aliases (spec 08 §4, §5.5) */
import { type ConfigKey, KEY_ALIASES, lookupKey, namesFor } from '@browserhive/contracts/config';

/** Maximum edit distance for a suggestion (spec 08 §4). */
export const SUGGESTION_DISTANCE = 2;

/**
 * Optimal-string-alignment Damerau-Levenshtein distance (insert, delete, substitute, adjacent
 * transposition), case-sensitive.
 *
 * @returns The edit distance between `a` and `b`.
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) (d[i] ?? [])[0] = i;
  for (let j = 0; j < cols; j += 1) (d[0] ?? [])[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] ?? [];
      const prev = d[i - 1] ?? [];
      let best = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] ?? [])[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
  }
  return (d[a.length] ?? [])[b.length] ?? 0;
}

/**
 * Candidates within {@link SUGGESTION_DISTANCE} of `input`, or matching it case-insensitively,
 * ordered by distance then name. Case-insensitive exact matches come first.
 *
 * @returns The matching candidates (possibly empty).
 */
export function suggest(input: string, candidates: readonly string[]): readonly string[] {
  const lower = input.toLowerCase();
  const scored: Array<{ readonly name: string; readonly score: number }> = [];
  for (const name of candidates) {
    if (name.toLowerCase() === lower) {
      scored.push({ name, score: -1 });
      continue;
    }
    const distance = damerauLevenshtein(input, name);
    if (distance <= SUGGESTION_DISTANCE) scored.push({ name, score: distance });
  }
  return scored
    .sort((x, y) => x.score - y.score || x.name.localeCompare(y.name))
    .map((entry) => entry.name);
}

/**
 * `max-sessions` → `maxSessions`, `MAX_SESSIONS` → `maxSessions`; unchanged when already camelCase.
 *
 * @returns The camelCase spelling.
 */
export function camelFromKebab(name: string): string {
  if (!/[-_]/.test(name)) return name;
  const parts = name
    .toLowerCase()
    .split(/[-_]+/)
    .filter((part) => part !== '');
  return parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** Where an unknown spelling was seen; decides which registry spelling is suggested. */
export type SpellingSource = 'env' | 'cli' | 'json';

/** Result of {@link suggestKey}. */
export interface KeySuggestion {
  /** Suggested spellings in the source's own form (`--maxSessions`, `BROWSERHIVE_MAX_SESSIONS`, `maxSessions`). */
  readonly suggestions: readonly string[];
  /** Set when the spelling is an unsupported alias with no replacement key. */
  readonly removed: boolean;
}

function spellingOf(key: ConfigKey, source: SpellingSource): string {
  const names = namesFor(key);
  return source === 'env' ? names.env : source === 'cli' ? names.cli : names.json;
}

/**
 * Suggestions for an unknown key spelling: key aliases (spec 08 §5.5), kebab/snake-case
 * conversions, then Damerau-Levenshtein over the registry spellings of `keys`.
 *
 * @returns Suggestions in the source's spelling and whether the name is an unsupported alias with no replacement.
 */
export function suggestKey(
  name: string,
  source: SpellingSource,
  keys: readonly ConfigKey[],
): KeySuggestion {
  const alias = KEY_ALIASES[name];
  if (alias !== undefined) {
    return alias === null
      ? { suggestions: [], removed: true }
      : { suggestions: [spellingOf(alias, source)], removed: false };
  }
  if (source !== 'env') {
    const bare = source === 'cli' ? name.replace(/^--/, '') : name;
    const converted = camelFromKebab(bare);
    if (converted !== bare) {
      const exact = keys.find((key) => key.toLowerCase() === converted.toLowerCase());
      if (exact !== undefined) return { suggestions: [spellingOf(exact, source)], removed: false };
    }
  }
  const candidates = keys.map((key) => spellingOf(key, source));
  return { suggestions: suggest(name, candidates), removed: false };
}

/**
 * Whether a spelling resolves to a registered key (canonical or reserved); used as the
 * tokenizer's `known` predicate so unknown flags never swallow the next token.
 *
 * @returns `true` for canonical keys and reserved keys.
 */
export function isRegisteredSpelling(source: SpellingSource, name: string): boolean {
  return lookupKey(source, name).kind !== 'unknown';
}
