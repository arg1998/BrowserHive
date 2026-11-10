/** @module domain/templates/redaction — the cookie-value redaction of sealed template sessions (spec 13 §5.4, D-51): every value of a cookie in the template's browser, of at least 12 characters, becomes `[sealed]` in agent-facing text. */

/** What a redacted value is replaced with. */
export const SEALED_MARK = '[sealed]';

/** Shorter values are too likely to occur by chance in page text to be redacted (spec 13 §5.4). */
export const MIN_SEALED_VALUE_LENGTH = 12;

/**
 * The values worth redacting from `values` (cookie values of the jar): at least
 * {@link MIN_SEALED_VALUE_LENGTH} characters, de-duplicated, longest first so a value that contains
 * another is replaced whole.
 */
export function sealedValues(values: Iterable<string>): readonly string[] {
  const kept = new Set<string>();
  for (const value of values) if (value.length >= MIN_SEALED_VALUE_LENGTH) kept.add(value);
  return [...kept].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Replaces every occurrence of each of `values` (from {@link sealedValues}) in `text` with `[sealed]`. */
export function redactSealed(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SEALED_MARK);
  }
  return out;
}
