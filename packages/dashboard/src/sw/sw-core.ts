/** @module sw/sw-core — the service worker's pure logic (04 §18.5): request routing, the navigation fallback decision and the cache-name rules. No DOM or worker global, so tests call it directly. */
import { isNonSpaPath } from '@browserhive/contracts/paths';

/** Every cache the worker owns starts with this; it never touches any other cache. */
export const CACHE_PREFIX = 'bh-offline-';

/** The precached offline page; a direct visit reaches it as a navigation (route `navigate`). */
export const OFFLINE_PATH = '/offline.html';

/** The cache of one worker version: `bh-offline-${version}`. */
export function cacheNameFor(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** True for a cache this worker family owns (any version). */
export function isOwnCache(name: string): boolean {
  return name.startsWith(CACHE_PREFIX);
}

/** True for an owned cache of another version, which `activate` deletes. */
export function isStaleCache(name: string, current: string): boolean {
  return isOwnCache(name) && name !== current;
}

/** What `fetch` does with a request: leave it alone, serve a precached asset, or guard a navigation. */
export type Route = 'pass' | 'asset' | 'navigate';

/** The members of a `Request` the routing reads. */
export interface RoutableRequest {
  readonly method: string;
  readonly url: string;
  readonly mode: string;
}

/** What the routing compares against. */
export interface RouteContext {
  /** The worker's origin (`self.location.origin`). */
  readonly origin: string;
  /** The hashed precache paths (`SW_PRECACHE` without `/offline.html`). */
  readonly assets: ReadonlySet<string>;
}

/** The hashed files of the precache: everything but the offline page itself. */
export function precacheAssets(precache: readonly string[]): ReadonlySet<string> {
  return new Set(precache.filter((path) => path !== OFFLINE_PATH));
}

/** Routes one request (04 §18.5.4, first match wins). */
export function routeRequest(request: RoutableRequest, context: RouteContext): Route {
  if (request.method !== 'GET') return 'pass';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'pass';
  }
  if (url.origin !== context.origin) return 'pass';
  if (isNonSpaPath(url.pathname)) return 'pass';
  if (context.assets.has(url.pathname)) return 'asset';
  if (request.mode === 'navigate') return 'navigate';
  return 'pass';
}

/** How the network answered a guarded navigation, reduced to what {@link decideNavigation} reads. */
export type NavigationOutcome =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'timeout' }
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly marked: boolean;
      /** The `content-type` header, or `null`. */
      readonly contentType: string | null;
    };

/**
 * What the worker answers a navigation with:
 * - `network`: the network's response, untouched;
 * - `offline`: the cached offline page;
 * - `retire`: the network's response, untouched, and the worker removes itself.
 */
export type NavigationDecision = 'network' | 'offline' | 'retire';

function isHtml(contentType: string | null): boolean {
  if (contentType === null) return false;
  return contentType.split(';')[0]?.trim().toLowerCase() === 'text/html';
}

/** The navigation fallback (04 §18.5.4, pure). */
export function decideNavigation(outcome: NavigationOutcome): NavigationDecision {
  if (outcome.kind !== 'response') return 'offline';
  if (outcome.marked) return 'network';
  if (outcome.status >= 500 && outcome.status <= 599) return 'offline';
  if (outcome.status >= 200 && outcome.status <= 299 && isHtml(outcome.contentType)) {
    return 'retire';
  }
  return 'network';
}

/** The members of a `Response` the precache check reads. */
export interface PrecacheCandidate {
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly type: string;
  readonly headers: { has(name: string): boolean };
}

/** `install` stores a response only when it is `ok`, not redirected, `basic` and marked (04 §18.5.2). */
export function isPrecacheable(response: PrecacheCandidate, markerHeader: string): boolean {
  return (
    response.ok &&
    !response.redirected &&
    response.type === 'basic' &&
    response.headers.has(markerHeader)
  );
}
