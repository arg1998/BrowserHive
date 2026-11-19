/** @module domain/templates/redaction — the cookie-value redaction of sealed template sessions (spec 13 §5.4, D-51): every value of a cookie in the template's browser (and every storage value of its sites) that could be a secret — at least 12 characters and not plain text (§5.4 "What counts as a secret") — becomes `[sealed]` wherever it occurs in agent-facing text; only the matching text is replaced. */

/** What a redacted value is replaced with. */
export const SEALED_MARK = '[sealed]';

/** Shorter values are too likely to occur by chance in page text to be redacted (spec 13 §5.4). */
export const MIN_SEALED_VALUE_LENGTH = 12;

/**
 * The characters plain text is made of: letters, digits, whitespace and common punctuation of
 * words, URLs, paths, time zones and language lists. A value with any other character (quotes,
 * backslashes, angle brackets, braces, control characters) is never plain.
 */
const PLAIN_CHARACTERS = /^[\p{L}\p{N}\s\-_.,:;/#?&=+()!'@~%*]+$/u;

/** A run of letters and digits as a word, number or short unit shows it (see {@link isPlainRun}). */
const PLAIN_RUNS: readonly RegExp[] = [
  /^\p{Nd}{1,4}$/u, // a year, a small number, a version part
  /^\p{Lu}?\p{Ll}{1,19}$/u, // a word, lower case or capitalized
  /^\p{Lu}{1,5}$/u, // an acronym, a region code
  /^\p{Lu}?\p{Ll}+(?:\p{Lu}\p{Ll}{2,}){1,4}$/u, // camelCase or PascalCase words
  /^\p{Lo}{1,20}$/u, // a word of a script without case
  /^\p{L}{1,3}\p{Nd}{1,3}$/u, // v2, u0, h264, utf8
  /^\p{Nd}{1,3}\p{L}{1,3}$/u, // 5px, 2nd, 100vh
];

/** A whole number shorter than 16 digits (counters, timestamps, ids); a longer one may be a token. */
const PLAIN_NUMBER = /^[+-]?\p{Nd}{1,15}(?:\.\p{Nd}+)?$/u;

/** An ISO 8601 date or date-time. */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isPlainRun(run: string): boolean {
  return PLAIN_RUNS.some((re) => re.test(run));
}

/**
 * True when `value` is plain text, never a secret: a number, an ISO date, or words, URLs, paths,
 * time zones (`America/Toronto`), language tags and lists (`en-US,en;q=0.9`) — only
 * {@link PLAIN_CHARACTERS}, and every run of letters and digits a word, a number of at most four
 * digits or a short unit ({@link PLAIN_RUNS}). Tokens mix letters and digits, or run longer.
 */
export function isPlainValue(value: string): boolean {
  const trimmed = value.trim();
  if (PLAIN_NUMBER.test(trimmed) || ISO_DATE.test(trimmed)) return true;
  if (!PLAIN_CHARACTERS.test(value)) return false;
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter((run) => run.length > 0)
    .every(isPlainRun);
}

/**
 * True when a cookie or storage value could be a secret and is redacted: at least
 * {@link MIN_SEALED_VALUE_LENGTH} characters and not plain text ({@link isPlainValue}). Values
 * such as `0`, `true`, `en-US`, `America/Toronto` or `https://mail.example/mail/u/0/#inbox` are
 * not, so they never blank out a URL, a time zone or page text.
 */
export function couldBeSecret(value: string): boolean {
  return value.length >= MIN_SEALED_VALUE_LENGTH && !isPlainValue(value);
}
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
 * The strings worth redacting for `values` (cookie and storage values): each value that could be a
 * secret ({@link couldBeSecret}) in every form of {@link sealedForms}, de-duplicated, longest first
 * so a value that contains another is replaced whole.
 */
export function sealedValues(values: Iterable<string>): readonly string[] {
  const kept = new Set<string>();
  for (const value of values) {
    if (!couldBeSecret(value)) continue;
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
