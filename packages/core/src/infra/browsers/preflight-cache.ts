/** @module infra/browsers/preflight-cache — the site's own CORS preflight answers, replayed for the same question while their `Access-Control-Max-Age` lasts, in routed contexts whose HTTP cache (and with it Chromium's preflight cache) is off (D-66, deferred D41). */

/**
 * Why BrowserHive keeps its own preflight cache. A context with a route runs with Chromium's cache
 * disabled (`Network.setCacheDisabled`, so a cached response can never skip the route), and
 * Chromium then bypasses its preflight cache too: measured on Patchright 1.63, a routed context
 * sends a fresh `OPTIONS` before every preflighted request even when the site answered
 * `Access-Control-Max-Age: 600` (an unrouted context sends one). This cache replays the site's
 * answer to the same question for as long as Chromium would have kept it.
 *
 * It only ever replays what the site itself answered; Chromium still runs its CORS check on the
 * replayed answer against the request that waits for it, so a replay can never allow what the
 * site's answer did not. It is stricter than Chromium's cache in what counts as the same question
 * (an exact match of the URL, the requesting origin, the top frame's origin and every
 * `Access-Control-Request-*` header), so it can send a preflight Chromium would have skipped, never
 * skip one Chromium would have sent for a different question. It cannot see a request's
 * credentials mode (a preflight never carries credentials and the site answers it without knowing
 * the mode), which Chromium's cache also keys on: Chromium re-checks the replayed answer against
 * the waiting request's mode, so the outcome is the same, only one round trip fewer.
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

/**
 * The per-context cache. Only answers a browser could accept are kept: a `2xx` status and an
 * `Access-Control-Allow-Origin` of `*` or the requesting origin (a refusal is never kept, so a site
 * that fixes its answer is asked again at once, as Chromium would).
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
   * Keeps the site's answer to `key` when a browser could accept it.
   *
   * @param origin The question's `Origin` header.
   * @param headers The answer's response headers.
   * @returns Whether it was kept.
   */
  store(
    key: string,
    origin: string,
    status: number,
    headers: Readonly<Record<string, string>>,
  ): boolean {
    if (status < 200 || status > 299) return false;
    const allowOrigin = headerOf(headers, 'access-control-allow-origin')?.trim();
    if (allowOrigin === undefined || (allowOrigin !== '*' && allowOrigin !== origin)) return false;
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
