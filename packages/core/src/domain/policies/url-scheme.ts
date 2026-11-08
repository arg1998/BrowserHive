/** @module domain/policies/url-scheme — which URL schemes an agent may open and which a page may commit (spec 13 T0d, D-57). */

import { err, ok, type Result } from '../../kernel/result.ts';

/**
 * Agent-requested URLs (`navigate`, `new_tab`) are limited to web schemes.
 *
 * A `Page.navigate` from CDP is browser-initiated, so Chromium honours schemes a web page could
 * never open: `file:` reads any file BrowserHive's user can read, `chrome:` pages expose history,
 * passwords and settings, `view-source:file:` does the same as `file:`, external protocol schemes
 * launch applications on the host, and `javascript:` runs agent-written script in the page even
 * when `evaluate` is disabled. So the scheme is checked before the browser is touched, and the
 * browser is given the normalized `href`, so no second parser can disagree with this one.
 *
 * Allowed: `http:`, `https:`, exactly `about:blank`, and `data:` while `allowData` is set (every
 * session is exclusive today; virtual sessions of spec 13 T1a will refuse it). Everything else is
 * refused, including input that does not parse as an absolute URL (`example.com`) and input
 * without a real scheme (`localhost:3000` parses as the scheme `localhost:`). WHATWG `URL` strips
 * tabs, newlines and surrounding whitespace, so `java\tscript:` is `javascript:`.
 */
const AGENT_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * What a main frame may commit without the page being closed (the backstop for navigations no
 * tool requested). Wider than {@link AGENT_SCHEMES}: sites legitimately open `blob:` and `data:`
 * documents, `about:srcdoc` is an iframe document, and `chrome-error:` is Chromium's error page.
 */
const COMMITTED_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'blob:',
  'chrome-error:',
]);

/** The `about:` documents a main frame may show. */
const COMMITTED_ABOUT: ReadonlySet<string> = new Set(['blank', 'srcdoc']);

/** Options of the scheme checks. */
export interface SchemeOptions {
  /** `data:` is allowed (exclusive sessions). */
  readonly allowData: boolean;
}

/** An allowed agent URL. */
export interface AllowedUrl {
  /** The normalized URL the browser is given. */
  readonly href: string;
}

/** A refused agent URL. */
export interface RefusedUrl {
  /** The lowercased scheme without its colon (`javascript`), or `''` when the input does not parse. */
  readonly scheme: string;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** `URL.protocol` (`javascript:`) as the refusal names it (`javascript`). */
function bare(protocol: string): string {
  return protocol.toLowerCase().replace(/:$/, '');
}

/**
 * Decides whether an agent may open `raw`, and the normalized `href` to open when it may.
 *
 * @returns `ok({ href })`, or `err({ scheme })` naming the refused scheme (`''` when unparseable)
 */
export function checkAgentUrl(raw: string, options: SchemeOptions): Result<AllowedUrl, RefusedUrl> {
  const url = parse(raw);
  if (url === null) return err({ scheme: '' });
  const protocol = url.protocol.toLowerCase();
  if (AGENT_SCHEMES.has(protocol)) return ok({ href: url.href });
  if (protocol === 'about:' && url.href === 'about:blank') return ok({ href: url.href });
  if (protocol === 'data:' && options.allowData) return ok({ href: url.href });
  return err({ scheme: bare(protocol) });
}

/**
 * The scheme of a URL a main frame committed when that URL is not allowed to stay open, or `null`
 * when it may (`http:`, `https:`, `about:blank`, `about:srcdoc`, `blob:`, `chrome-error:`, and
 * `data:` while `allowData` is set). A committed URL that does not parse is refused as `''`.
 */
export function refusedCommittedScheme(url: string, options: SchemeOptions): string | null {
  const parsed = parse(url);
  if (parsed === null) return '';
  const protocol = parsed.protocol.toLowerCase();
  if (COMMITTED_SCHEMES.has(protocol)) return null;
  if (protocol === 'data:' && options.allowData) return null;
  if (protocol === 'about:' && COMMITTED_ABOUT.has(parsed.pathname.toLowerCase())) return null;
  return bare(protocol);
}
