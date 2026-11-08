/** @module sw/sw-core.test — routing, the navigation fallback and the cache-name rules of the service worker (04 §18.5.4, 09 §3.5) */
import { describe, expect, it } from 'bun:test';
import { NON_SPA_PREFIXES } from '@browserhive/contracts/paths';
import {
  cacheNameFor,
  decideNavigation,
  isOwnCache,
  isPrecacheable,
  isStaleCache,
  type NavigationOutcome,
  OFFLINE_PATH,
  precacheAssets,
  type RoutableRequest,
  routeRequest,
} from './sw-core.ts';

const ORIGIN = 'http://127.0.0.1:9876';
const PRECACHE = [
  OFFLINE_PATH,
  '/assets/offline-Ab12.js',
  '/assets/offline-offline-Cd34.css',
  '/assets/offline-geist-latin-wght-normal-Ef56.woff2',
];
const context = { origin: ORIGIN, assets: precacheAssets(PRECACHE) };

function req(path: string, mode = 'navigate', method = 'GET', origin = ORIGIN): RoutableRequest {
  return { url: `${origin}${path}`, mode, method };
}

describe('routeRequest', () => {
  it('row 1: any method but GET passes, even a navigation or a precached file', () => {
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(routeRequest(req('/sessions', 'navigate', method), context)).toBe('pass');
      expect(routeRequest(req('/assets/offline-Ab12.js', 'no-cors', method), context)).toBe('pass');
    }
  });

  it('row 2: another origin passes', () => {
    expect(
      routeRequest(req('/sessions', 'navigate', 'GET', 'http://localhost:9876'), context),
    ).toBe('pass');
    expect(
      routeRequest(req('/assets/offline-Ab12.js', 'cors', 'GET', 'https://cdn.example'), context),
    ).toBe('pass');
  });

  it('row 3: a reserved prefix and everything under it passes, navigation or not', () => {
    for (const prefix of NON_SPA_PREFIXES) {
      expect(routeRequest(req(prefix), context)).toBe('pass');
      expect(routeRequest(req(`${prefix}/x`), context)).toBe('pass');
      expect(routeRequest(req(`${prefix}/x`, 'cors'), context)).toBe('pass');
    }
  });

  it('row 3 boundaries: /apix, /healthz and /mcpserver are not reserved', () => {
    expect(routeRequest(req('/apix'), context)).toBe('navigate');
    expect(routeRequest(req('/healthz'), context)).toBe('navigate');
    expect(routeRequest(req('/mcpserver'), context)).toBe('navigate');
    expect(routeRequest(req('/trace-viewerx'), context)).toBe('navigate');
  });

  it('row 4: a hashed precache file is an asset, whatever the mode', () => {
    for (const path of PRECACHE.slice(1)) {
      expect(routeRequest(req(path, 'no-cors'), context)).toBe('asset');
      expect(routeRequest(req(path, 'cors'), context)).toBe('asset');
      expect(routeRequest(req(path, 'navigate'), context)).toBe('asset');
    }
  });

  it('row 5: a navigation, including a direct visit to /offline.html, is guarded', () => {
    expect(routeRequest(req('/'), context)).toBe('navigate');
    expect(routeRequest(req('/sessions?status=open'), context)).toBe('navigate');
    expect(routeRequest(req('/websites/example.com'), context)).toBe('navigate');
    expect(routeRequest(req(OFFLINE_PATH), context)).toBe('navigate');
  });

  it('row 6: app assets, /sw.js, the manifest, icons and other modes pass', () => {
    expect(routeRequest(req('/sw.js', 'same-origin'), context)).toBe('pass');
    expect(routeRequest(req('/manifest.webmanifest', 'cors'), context)).toBe('pass');
    expect(routeRequest(req('/icons/app-192.png', 'no-cors'), context)).toBe('pass');
    expect(routeRequest(req('/assets/index-XYZ.js', 'cors'), context)).toBe('pass');
    expect(routeRequest(req('/offline.html', 'cors'), context)).toBe('pass');
    expect(routeRequest(req('/sessions', 'same-origin'), context)).toBe('pass');
  });

  it('an unparsable URL passes', () => {
    expect(routeRequest({ url: 'not a url', mode: 'navigate', method: 'GET' }, context)).toBe(
      'pass',
    );
  });
});

describe('decideNavigation', () => {
  const STATUSES = [200, 0, 302, 404, 500, 502, 503, 504, 530];
  const TYPES = ['text/html; charset=utf-8', 'application/json', null];

  function outcome(status: number, marked: boolean, contentType: string | null): NavigationOutcome {
    return { kind: 'response', status, marked, contentType };
  }

  it('a marked response is returned untouched, whatever its status and type', () => {
    for (const status of STATUSES) {
      for (const type of TYPES)
        expect(decideNavigation(outcome(status, true, type))).toBe('network');
    }
  });

  it('an unmarked 5xx is a proxy whose upstream is down: the offline page', () => {
    for (const status of [500, 502, 503, 504, 530, 522]) {
      for (const type of TYPES)
        expect(decideNavigation(outcome(status, false, type))).toBe('offline');
    }
  });

  it('an unmarked 2xx HTML page retires the worker', () => {
    expect(decideNavigation(outcome(200, false, 'text/html'))).toBe('retire');
    expect(decideNavigation(outcome(200, false, 'text/html; charset=utf-8'))).toBe('retire');
    expect(decideNavigation(outcome(203, false, 'TEXT/HTML'))).toBe('retire');
  });

  it('any other unmarked response (opaque redirect, 302, 404, non-HTML 2xx) is untouched', () => {
    expect(decideNavigation(outcome(0, false, null))).toBe('network');
    expect(decideNavigation(outcome(302, false, 'text/html'))).toBe('network');
    expect(decideNavigation(outcome(404, false, 'text/html'))).toBe('network');
    expect(decideNavigation(outcome(404, false, 'application/json'))).toBe('network');
    expect(decideNavigation(outcome(200, false, 'application/json'))).toBe('network');
    expect(decideNavigation(outcome(200, false, 'text/htmlx'))).toBe('network');
    expect(decideNavigation(outcome(200, false, null))).toBe('network');
  });

  it('a rejection or a timeout shows the offline page', () => {
    expect(decideNavigation({ kind: 'rejected' })).toBe('offline');
    expect(decideNavigation({ kind: 'timeout' })).toBe('offline');
  });
});

describe('cache names and precache rules', () => {
  it('names caches bh-offline-<version> and owns only those', () => {
    expect(cacheNameFor('0123456789ab')).toBe('bh-offline-0123456789ab');
    expect(isOwnCache('bh-offline-0123456789ab')).toBe(true);
    expect(isOwnCache('trace-viewer')).toBe(false);
    expect(isOwnCache('bh-other')).toBe(false);
    expect(isStaleCache('bh-offline-old', 'bh-offline-new')).toBe(true);
    expect(isStaleCache('bh-offline-new', 'bh-offline-new')).toBe(false);
    expect(isStaleCache('workbox-precache', 'bh-offline-new')).toBe(false);
  });

  it('the hashed assets are the precache without the offline page', () => {
    expect([...precacheAssets(PRECACHE)]).toEqual(PRECACHE.slice(1));
  });

  it('stores only ok, non-redirected, basic, marked responses', () => {
    const headers = (marked: boolean) => ({ has: (name: string) => marked && name === 'x-m' });
    const good = { ok: true, redirected: false, type: 'basic', headers: headers(true) };
    expect(isPrecacheable(good, 'x-m')).toBe(true);
    expect(isPrecacheable({ ...good, ok: false }, 'x-m')).toBe(false);
    expect(isPrecacheable({ ...good, redirected: true }, 'x-m')).toBe(false);
    expect(isPrecacheable({ ...good, type: 'opaque' }, 'x-m')).toBe(false);
    expect(isPrecacheable({ ...good, type: 'cors' }, 'x-m')).toBe(false);
    expect(isPrecacheable({ ...good, headers: headers(false) }, 'x-m')).toBe(false);
  });
});
