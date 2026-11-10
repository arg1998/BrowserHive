/** @module domain/templates/redaction — the cookie-value redaction of sealed template sessions (spec 13 §5.4, D-51): every value of a cookie in the template's browser, of at least 12 characters, becomes `[sealed]` in agent-facing text. */

/** What a redacted value is replaced with. */
export const SEALED_MARK = '[sealed]';

/** Shorter values are too likely to occur by chance in page text to be redacted (spec 13 §5.4). */
export const MIN_SEALED_VALUE_LENGTH = 12;

/** `value` as it appears inside a JSON string (quotes, backslashes and control characters escaped). */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** `value` as an HTML page shows it in its source (`page.content()`). */
function htmlEscaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every form a value can take in a result: as is, JSON-escaped (the text block of a JSON result;
 * twice for a YAML `snapshot` inside JSON), URL-encoded (a cookie value in a URL) and HTML-escaped.
 */
export function sealedForms(value: string): readonly string[] {
  const once = jsonEscaped(value);
  let encoded = value;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    // A lone surrogate cannot be URL-encoded; the other forms still apply.
  }
  return [
    value,
    once,
    jsonEscaped(once),
    encoded,
    htmlEscaped(value),
    jsonEscaped(htmlEscaped(value)),
  ];
}

/**
 * The strings worth redacting for `values` (cookie values of the jar): each value of at least
 * {@link MIN_SEALED_VALUE_LENGTH} characters in every form of {@link sealedForms}, de-duplicated,
 * longest first so a value that contains another is replaced whole.
 */
export function sealedValues(values: Iterable<string>): readonly string[] {
  const kept = new Set<string>();
  for (const value of values) {
    if (value.length < MIN_SEALED_VALUE_LENGTH) continue;
    for (const form of sealedForms(value)) kept.add(form);
  }
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
