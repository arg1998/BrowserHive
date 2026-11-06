/** @module sw/sw — the dashboard's service worker (04 §18.5): wires `sw-core` to the `install`,
 * `activate` and `fetch` events. Built by `scripts/offline-sw-plugin.ts` into a classic IIFE
 * (`/sw.js`) whose constants are injected with `define`; it starts itself only in that build, so
 * tests import {@link startWorker} and drive it through a fake global scope.
 */
import { deleteCaches, retire, type WorkerFetchEvent, type WorkerScope } from './scope.ts';
import {
  cacheNameFor,
  decideNavigation,
  isPrecacheable,
  isStaleCache,
  type NavigationOutcome,
  OFFLINE_PATH,
  precacheAssets,
  routeRequest,
} from './sw-core.ts';

/** The build-time constants (04 §18.5.1). */
export interface WorkerConstants {
  /** `SW_VERSION`: 12 hex characters of the precache hash. */
  readonly version: string;
  /** `SW_PRECACHE`: `/offline.html` and the hashed files of the offline build. */
  readonly precache: readonly string[];
  /** `NAVIGATION_TIMEOUT_MS`: 10 000. */
  readonly navigationTimeoutMs: number;
  /** `MARKER_HEADER`: `x-browserhive-version`. */
  readonly markerHeader: string;
}

type NetworkResult =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'rejected' | 'timeout' };

/** Registers the worker's event listeners on `scope`. */
export function startWorker(scope: WorkerScope, constants: WorkerConstants): void {
  const cacheName = cacheNameFor(constants.version);
  const assets = precacheAssets(constants.precache);
  const absolute = (path: string): string => new URL(path, scope.location.origin).href;
  const cached = (request: Request | string): Promise<Response | undefined> =>
    scope.caches.match(request, { cacheName, ignoreVary: true });

  async function install(): Promise<void> {
    // Fetch and check everything first, so a failure leaves the cache as it was.
    const responses = await Promise.all(
      constants.precache.map(async (path) => {
        const url = absolute(path);
        const response = await scope.fetch(url, { cache: 'reload', credentials: 'same-origin' });
        if (!isPrecacheable(response, constants.markerHeader)) {
          throw new Error(`precache ${path}: ${response.status} ${response.type}`);
        }
        return { url, response };
      }),
    );
    const cache = await scope.caches.open(cacheName);
    await Promise.all(responses.map(({ url, response }) => cache.put(url, response)));
    await scope.skipWaiting();
  }

  async function activate(): Promise<void> {
    await deleteCaches(scope, (name) => isStaleCache(name, cacheName));
    await scope.clients.claim();
  }

  async function serveAsset(request: Request): Promise<Response> {
    return (await cached(request)) ?? scope.fetch(request);
  }

  async function offlinePage(): Promise<Response> {
    return (await cached(absolute(OFFLINE_PATH))) ?? Response.error();
  }

  /**
   * `fetch(request)` with no init (an init would turn mode `navigate` into `same-origin`), raced
   * against the timer, which is cleared as soon as the race settles. A late answer is dropped.
   */
  function raceNetwork(request: Request): Promise<NetworkResult> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = scope.setTimeout(() => {
        settled = true;
        resolve({ kind: 'timeout' });
      }, constants.navigationTimeoutMs);
      scope.fetch(request).then(
        (response) => {
          if (settled) {
            response.body?.cancel().catch(() => undefined);
            return;
          }
          settled = true;
          scope.clearTimeout(timer);
          resolve({ kind: 'response', response });
        },
        () => {
          if (settled) return;
          settled = true;
          scope.clearTimeout(timer);
          resolve({ kind: 'rejected' });
        },
      );
    });
  }

  async function navigate(event: WorkerFetchEvent): Promise<Response> {
    const result = await raceNetwork(event.request);
    if (result.kind !== 'response') return offlinePage();
    const { response } = result;
    const outcome: NavigationOutcome = {
      kind: 'response',
      status: response.status,
      marked: response.headers.has(constants.markerHeader),
      contentType: response.headers.get('content-type'),
    };
    switch (decideNavigation(outcome)) {
      case 'offline':
        return offlinePage();
      case 'retire':
        event.waitUntil(retire(scope));
        return response;
      default:
        return response;
    }
  }

  scope.addEventListener('install', (event) => event.waitUntil(install()));
  scope.addEventListener('activate', (event) => event.waitUntil(activate()));
  scope.addEventListener('fetch', (event) => {
    const route = routeRequest(event.request, { origin: scope.location.origin, assets });
    if (route === 'asset') event.respondWith(serveAsset(event.request));
    else if (route === 'navigate') event.respondWith(navigate(event));
  });
}

declare const SW_VERSION: string;
declare const SW_PRECACHE: readonly string[];
declare const NAVIGATION_TIMEOUT_MS: number;
declare const MARKER_HEADER: string;

// Only the plugin's build defines the constants; importing this module (tests) starts nothing.
if (typeof SW_VERSION === 'string') {
  // The real `ServiceWorkerGlobalScope` has every member of `WorkerScope`; its overloaded
  // `addEventListener` is just wider than the interface's.
  startWorker(self as unknown as WorkerScope, {
    version: SW_VERSION,
    precache: SW_PRECACHE,
    navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
    markerHeader: MARKER_HEADER,
  });
}
