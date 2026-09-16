/** @module lib/format/urls — URL truncation and domain extraction for `UrlCell` and websites views */

/**
 * Middle-ellipsis truncation for machine values (`data:` URLs, query strings, paths). Keeps both the
 * origin (`head`) and the tail visible so a value stays identifiable.
 */
export function middleTruncate(s: string, head = 30, tail = 22): string {
  if (!s || s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Hostname of a URL, or the raw value when it is not parsable. */
export function urlDomain(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** Strip credentials from a URL for display (`https://user:pw@host` → `https://host`). */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Is this an `http(s)` URL that can be opened in a new tab safely? */
export function isOpenableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
