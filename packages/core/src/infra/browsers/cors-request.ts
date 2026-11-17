/** @module infra/browsers/cors-request — whether a routed request is a cross-origin one Chromium preflights (Fetch standard "CORS-preflight"), for the chain's fail-closed mode when real preflights cannot be enforced (D-66). */

/** What the test reads from a routed request. */
export interface CorsRequestFacts {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  /** The request's headers, lower-cased names (Playwright's `request.headers()`). */
  readonly headers: Readonly<Record<string, string>>;
}

const SAFELISTED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST']);

/** `Content-Type` essences a simple request may carry. */
const SIMPLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);

/** Safelisted request headers (value rules aside, except `content-type`). */
const SAFELISTED_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'range',
]);

/**
 * Headers a page cannot set (forbidden request headers) or that Chromium adds itself, so they
 * never make a request non-simple: `sec-*` and `proxy-*` too.
 */
const BROWSER_HEADERS: ReadonlySet<string> = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cache-control',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'pragma',
  'priority',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'upgrade-insecure-requests',
  'user-agent',
  'via',
]);

/**
 * Whether `request` is cross-origin (its `Origin` is not its URL's origin) and not simple (a
 * method other than `GET`/`HEAD`/`POST`, a non-safelisted header, or a `Content-Type` outside the
 * three simple ones), which is what Chromium preflights. Navigations never are. Conservative by
 * design: it is used only to refuse requests while preflights cannot be enforced, so a header a
 * browser setting adds (extra HTTP headers) counts as non-simple.
 */
export function needsPreflight(request: CorsRequestFacts): boolean {
  if (request.resourceType === 'document') return false;
  const origin = request.headers['origin'];
  if (origin === undefined) return false;
  let target: string;
  try {
    target = new URL(request.url).origin;
  } catch {
    return false;
  }
  if (origin === target) return false;
  if (!SAFELISTED_METHODS.has(request.method.toUpperCase())) return true;
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (BROWSER_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue;
    if (!SAFELISTED_HEADERS.has(name)) return true;
    if (name === 'content-type') {
      const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!SIMPLE_CONTENT_TYPES.has(essence)) return true;
    }
  }
  return false;
}
