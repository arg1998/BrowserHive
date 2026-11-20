/** @module domain/templates/redaction — the cookie-value redaction of sealed template sessions (spec 13 §5.4, D-51): every value of a cookie in the template's browser (and every storage value of its sites) of at least 12 characters becomes `[sealed]` wherever it occurs in agent-facing text, unless it is one of the session's own identity values or matches a strict grammar of public forms (§5.4 "What counts as a secret": deny by default, review #88 H1); only the matching text is replaced. */

/** What a redacted value is replaced with. */
export const SEALED_MARK = '[sealed]';

/** Shorter values are too likely to occur by chance in page text to be redacted (spec 13 §5.4). */
export const MIN_SEALED_VALUE_LENGTH = 12;

/**
 * A number: up to 10 integer digits (counters, seconds timestamps) or a 13-digit millisecond
 * timestamp from 2001 to 2033, with at most 6 fraction digits. 11–15-digit ids redact.
 */
const PUBLIC_NUMBER = /^[+-]?(?:\d{1,10}|1\d{12})(?:\.\d{1,6})?$/;

/** An ISO 8601 date or date-time. */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A path or fragment segment of a public URL: a word, a number of ≤ 4 digits, or a short unit. */
const URL_SEGMENT = /^(?:[a-z]{1,20}|[A-Z][a-z]{1,19}|\d{1,4}|[a-z]{1,3}\d{1,3})$/;

/** Digits a public URL may carry outside its host. */
const URL_MAX_DIGITS = 8;

let zones: ReadonlySet<string> | null = null;

/** The IANA time-zone names this runtime knows (`Intl.supportedValuesOf`). */
function timeZones(): ReadonlySet<string> {
  if (zones === null) {
    let names: string[] = [];
    try {
      names = Intl.supportedValuesOf('timeZone');
    } catch {
      // A runtime without the list: no value is a time zone, so every one redacts.
    }
    zones = new Set(names);
  }
  return zones;
}

/** A real IANA time-zone name (an alias such as `Asia/Calcutta` too, when the runtime accepts it). */
function isTimeZone(value: string): boolean {
  if (timeZones().has(value)) return true;
  if (!/^[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z0-9_+-]+){1,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * An Accept-Language list: each entry a valid BCP-47 tag of language, optional script and optional
 * region (`en`, `en-US`, `zh-Hant-TW`), with an optional `q=` weight.
 */
function isLanguageList(value: string): boolean {
  return value.split(',').every((entry) => {
    const [tag, weight, ...rest] = entry.trim().split(';');
    if (tag === undefined || tag.length === 0 || tag.length > 12 || rest.length > 0) return false;
    if (weight !== undefined && !/^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(weight.trim())) {
      return false;
    }
    // language[-Script][-REGION] only: variants and extensions would let a letters token through.
    if (!/^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i.test(tag)) return false;
    try {
      return Intl.getCanonicalLocales(tag).length === 1;
    } catch {
      return false;
    }
  });
}

/**
 * An http(s) URL with no user info and no query, whose every path and fragment segment is a
 * {@link URL_SEGMENT} and which carries at most {@link URL_MAX_DIGITS} digits outside its host.
 * A letters-only token as a path segment (`/reset/kqzvhxwpjtmrbnfd`) still passes: the known gap.
 */
function isPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.search !== '') return false;
  if (!value.toLowerCase().startsWith(`${url.protocol}//${url.host}`)) return false;
  const segments = `${url.pathname}/${url.hash.replace(/^#/, '')}`
    .split(/[/\-_.]+/)
    .filter((s) => s.length > 0);
  if (!segments.every((s) => URL_SEGMENT.test(s))) return false;
  const digits = (s: string): number => (s.match(/\d/g) ?? []).length;
  return digits(value) - digits(url.host) <= URL_MAX_DIGITS;
}

/**
 * True when `value` is a known public form, never a secret: one of `identity` (the session's own
 * time zone, locale and languages, exactly), a {@link PUBLIC_NUMBER}, an ISO date, a real IANA
 * time zone, an Accept-Language list, or a public URL ({@link isPublicUrl}). Everything else of
 * {@link MIN_SEALED_VALUE_LENGTH} or more characters is redacted (deny by default).
 */
export function isPublicValue(value: string, identity: readonly string[] = []): boolean {
  if (identity.includes(value)) return true;
  return (
    PUBLIC_NUMBER.test(value) ||
    ISO_DATE.test(value) ||
    isTimeZone(value) ||
    isLanguageList(value) ||
    isPublicUrl(value)
  );
}

/**
 * True when a cookie or storage value could be a secret and is redacted: at least
 * {@link MIN_SEALED_VALUE_LENGTH} characters and not a public form ({@link isPublicValue}).
 */
export function couldBeSecret(value: string, identity: readonly string[] = []): boolean {
  return value.length >= MIN_SEALED_VALUE_LENGTH && !isPublicValue(value, identity);
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
 * secret ({@link couldBeSecret}, with the session's `identity` values public) in every form of {@link sealedForms}, de-duplicated, longest first
 * so a value that contains another is replaced whole.
 */
export function sealedValues(
  values: Iterable<string>,
  identity: readonly string[] = [],
): readonly string[] {
  const kept = new Set<string>();
  for (const value of values) {
    if (!couldBeSecret(value, identity)) continue;
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
