/** @module infra/browsers/preflight-cache — the site's own CORS preflight answers, replayed for the same question while their `Access-Control-Max-Age` lasts, in routed contexts whose HTTP cache (and with it Chromium's preflight cache) is off (D-66, deferred D41). */

/**
 * Why BrowserHive keeps its own preflight cache. A context with a route runs with Chromium's cache
 * disabled (`Network.setCacheDisabled`, so a cached response can never skip the route), and
 * Chromium then bypasses its preflight cache too: measured on Patchright 1.63, a routed context
 * sends a fresh `OPTIONS` before every preflighted request even when the site answered
 * `Access-Control-Max-Age: 600` (an unrouted context sends one). This cache replays the site's
 * answer to the same question for as long as Chromium would have kept it.
 *
 * It only ever replays what the site itself answered, and only an answer that passes Chromium's
 * preflight checks for the question asked (status, allowed origin, method and headers), so a site
 * that refuses is asked again every time, as Chromium does. Chromium still runs its CORS check on a
 * replayed answer against the request that waits for it, so a replay can never allow what the
 * site's answer did not (`cors-preflights.test.ts` pins this). What counts as the same question
 * differs from Chromium's cache: here an exact match of the URL, the requesting origin, the top
 * frame's origin and every `Access-Control-Request-*` header (stricter, so more preflights), but
 * without the request's credentials mode, which a preflight does not carry and Chromium keys on
 * (so, for example, a credentialed request after an uncredentialed one to the same URL gets the
 * kept answer, which Chromium re-checks, where Chromium would ask again). A site can therefore see
 * a different number of preflights than Chrome would send, never a different outcome.
 */

/** Chromium's default lifetime of a preflight answer without (or with an unreadable) `Access-Control-Max-Age`, in seconds. */
export const DEFAULT_PREFLIGHT_MAX_AGE_S = 5;

/** Chromium's ceiling on `Access-Control-Max-Age` (2 hours), in seconds. */
export const MAX_PREFLIGHT_MAX_AGE_S = 7_200;

/** Answers kept per context; the oldest is dropped first. */
export const PREFLIGHT_CACHE_ENTRIES = 256;

/** One response header as CDP's `Fetch.fulfillRequest` takes it. */
export interface PreflightHeader {
  readonly name: string;
  readonly value: string;
}

/** A cached answer: what to replay. */
export interface PreflightAnswer {
  readonly status: number;
  /** The site's `Access-Control-*` response headers, as it sent them. */
  readonly headers: readonly PreflightHeader[];
}

/** What identifies a preflight question (all exact, case-insensitive header names). */
export interface PreflightQuestion {
  readonly url: string;
  /** The origin of the page's top frame (Chromium partitions its cache by top-level site). */
  readonly topOrigin: string;
  /** The preflight's request headers. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The cache key of `question`: URL, top origin, `Origin` and every `Access-Control-Request-*` header. */
export function preflightKey(question: PreflightQuestion): string {
  const asked: string[] = [];
  let origin = '';
  for (const [name, value] of Object.entries(question.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'origin') origin = value;
    else if (lower.startsWith('access-control-request-')) asked.push(`${lower}:${value}`);
  }
  asked.sort();
  return JSON.stringify([question.url, question.topOrigin, origin, asked]);
}

/**
 * How long Chromium keeps `value` (an `Access-Control-Max-Age`), in seconds: absent or not a
 * whole number → {@link DEFAULT_PREFLIGHT_MAX_AGE_S}; capped at {@link MAX_PREFLIGHT_MAX_AGE_S};
 * `0` (or less) → not kept.
 */
export function preflightMaxAge(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PREFLIGHT_MAX_AGE_S;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_PREFLIGHT_MAX_AGE_S;
  const seconds = Number(trimmed);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_PREFLIGHT_MAX_AGE_S);
}

/** A response header by name, case-insensitively. */
function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The question a preflight asked: its `Origin`, `Access-Control-Request-Method` and `-Headers`. */
export interface PreflightAsked {
  readonly origin: string;
  readonly method: string;
  /** Comma-separated header names, as Chromium sent them (`''` when none). */
  readonly headers: string;
}

const SAFELISTED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST']);

/** A comma-separated header value as trimmed, non-empty items. */
function listOf(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Whether an answer passes Chromium's preflight checks for `asked`, as far as a preflight shows
 * them (Fetch standard "CORS-preflight fetch", steps 7.3–7.7): a `2xx` status; an
 * `Access-Control-Allow-Origin` of `*` or the asking origin; the asked method safelisted, listed
 * (case-sensitively) or `*`; every asked header listed (case-insensitively) or covered by `*`,
 * except `authorization`, which `*` never covers. A `*` holds only for requests without
 * credentials; Chromium re-checks the waiting request's mode on a replay.
 */
export function answerAllows(
  asked: PreflightAsked,
  status: number,
  headers: Readonly<Record<string, string>>,
): boolean {
  if (status < 200 || status > 299) return false;
  const allowOrigin = headerOf(headers, 'access-control-allow-origin')?.trim();
  if (allowOrigin === undefined || (allowOrigin !== '*' && allowOrigin !== asked.origin)) {
    return false;
  }
  const methods = listOf(headerOf(headers, 'access-control-allow-methods'));
  if (
    asked.method !== '' &&
    !SAFELISTED_METHODS.has(asked.method) &&
    !methods.includes(asked.method) &&
    !methods.includes('*')
  ) {
    return false;
  }
  const allowed = new Set(
    listOf(headerOf(headers, 'access-control-allow-headers')).map((h) => h.toLowerCase()),
  );
  for (const name of listOf(asked.headers).map((h) => h.toLowerCase())) {
    if (allowed.has(name)) continue;
    if (allowed.has('*') && name !== 'authorization') continue;
    return false;
  }
  return true;
}

/**
 * The per-context cache. Only answers that pass {@link answerAllows} are kept: a refusal (of the
 * origin, the method or a header) is never kept, so a site that fixes its answer is asked again at
 * once, as Chromium would.
 */
export class PreflightCache {
  private readonly entries = new Map<string, { answer: PreflightAnswer; until: number }>();
  private readonly now: () => number;
  private readonly limit: number;

  constructor(deps: { readonly now: () => number; readonly limit?: number }) {
    this.now = deps.now;
    this.limit = deps.limit ?? PREFLIGHT_CACHE_ENTRIES;
  }

  /** How many answers are kept (expired ones included until they are next read). */
  get size(): number {
    return this.entries.size;
  }

  /** The live answer to `key`, or `null` (an expired one is dropped). */
  get(key: string): PreflightAnswer | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.now() >= entry.until) {
      this.entries.delete(key);
      return null;
    }
    return entry.answer;
  }

  /**
   * Keeps the site's answer to `key` when it passes {@link answerAllows} for `asked`.
   *
   * @param headers The answer's response headers.
   * @returns Whether it was kept.
   */
  store(
    key: string,
    asked: PreflightAsked,
    status: number,
    headers: Readonly<Record<string, string>>,
  ): boolean {
    if (!answerAllows(asked, status, headers)) return false;
    const seconds = preflightMaxAge(headerOf(headers, 'access-control-max-age'));
    if (seconds === 0) return false;
    const kept: PreflightHeader[] = [];
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase().startsWith('access-control-')) kept.push({ name, value });
    }
    this.entries.delete(key);
    this.entries.set(key, {
      answer: { status, headers: kept },
      until: this.now() + seconds * 1000,
    });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return true;
  }
}
