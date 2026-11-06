/** @module interface/static/installable-app.test — the daemon side of the installable dashboard (D-49): the version marker on every response, the admin=false status page for browser navigations, and the app files served from the bundle. */

import { describe, expect, it } from 'bun:test';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';
import type { StaticAsset, StaticAssets } from '../../ports/static-assets.ts';
import { VERSION_HEADER } from '../http/middleware/secure-headers.ts';
import { isBrowserNavigation, statusPageHtml } from './status-page.ts';

const VERSION = '0.1.0';

function asset(path: string, contentType: string, body: string, immutable = false): StaticAsset {
  return {
    path,
    contentType,
    bytes: new TextEncoder().encode(body),
    etag: `"${path.length}"`,
    immutable,
  };
}

const INDEX = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';

/** A bundle that contains the installable-app files (the MIME types `createDirectoryAssets` maps). */
const FILES: Readonly<Record<string, StaticAsset>> = {
  'assets/app-1.js': asset('assets/app-1.js', 'text/javascript; charset=utf-8', 'app()', true),
  'sw.js': asset('sw.js', 'text/javascript; charset=utf-8', 'self.addEventListener("fetch",f)'),
  'manifest.webmanifest': asset(
    'manifest.webmanifest',
    'application/manifest+json; charset=utf-8',
    '{"id":"/","name":"BrowserHive"}',
  ),
};

const bundle: StaticAssets = {
  available: true,
  indexHtml: async () => INDEX,
  get: async (path) => FILES[path] ?? null,
};

/** The request headers a Chromium navigation carries. */
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('X-BrowserHive-Version on every response (03 §2)', () => {
  it('marks the SPA, assets, /health, API JSON, thrown AppErrors, 404s, the host guard and MCP', async () => {
    const kit = await createHttpKit({ spa: bundle, seed: false });
    const cookie = await kit.login();
    const responses = {
      spa: await kit.request('GET', '/sessions', { headers: NAVIGATE }),
      asset: await kit.request('GET', '/assets/app-1.js'),
      missingAsset: await kit.request('GET', '/assets/gone.js'),
      health: await kit.request('GET', '/health'),
      apiJson: await kit.request('GET', '/api/v1/auth/me', { cookie }),
      appError: await kit.request('GET', '/api/v1/sessions'),
      notFound: await kit.request('GET', '/api/v1/nope'),
      methodNotAllowed: await kit.request('DELETE', '/api/v1/auth/me', { cookie }),
      hostGuard: await kit.request('GET', '/health', { headers: { host: 'other.example' } }),
      mcp: await kit.request('POST', '/mcp'),
    };
    expect(responses.spa.headers.get('content-type')).toContain('text/html');
    expect(responses.apiJson.status).toBe(200);
    expect(responses.appError.status).toBe(401);
    expect(responses.notFound.status).toBe(404);
    expect(responses.hostGuard.status).toBe(421);
    for (const [kind, response] of Object.entries(responses)) {
      expect({ kind, marker: response.headers.get(VERSION_HEADER) }).toEqual({
        kind,
        marker: VERSION,
      });
    }
  });

  it('marks the status page and the JSON 404 when admin=false', async () => {
    const kit = await createHttpKit({ admin: false, seed: false });
    const root = await kit.request('GET', '/');
    expect(root.headers.get(VERSION_HEADER)).toBe(VERSION);
    const json = await kit.request('GET', '/sessions');
    expect(json.headers.get(VERSION_HEADER)).toBe(VERSION);
  });
});

describe('admin=false: browser navigations get the status page (03 §8)', () => {
  it('/ is unchanged: the status page with 200', async () => {
    const kit = await createHttpKit({ admin: false, seed: false });
    const root = await kit.request('GET', '/', { headers: NAVIGATE });
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(plainText(await root.text())).toContain(
      'The dashboard is turned off. Restart BrowserHive with --admin to use it.',
    );
  });

  it.each([
    ['Sec-Fetch-Mode: navigate', { 'sec-fetch-mode': 'navigate' }],
    ['Sec-Fetch-Dest: document', { 'sec-fetch-dest': 'document' }],
    ['Accept: text/html alone', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }],
  ])('a navigation detected by %s gets the status page with 404', async (_label, headers) => {
    const kit = await createHttpKit({ admin: false, seed: false });
    const page = await kit.request('GET', '/sessions', { headers });
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(plainText(await page.text())).toContain('The dashboard is turned off.');
    const head = await kit.request('HEAD', '/attention', { headers });
    expect(head.status).toBe(404);
    expect(head.headers.get('content-type')).toContain('text/html');
  });

  it('a script fetch, /sw.js and reserved paths keep the JSON 404', async () => {
    const kit = await createHttpKit({ admin: false, seed: false });
    const fetchLike = await kit.request('GET', '/sessions', {
      headers: { 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', accept: 'text/html' },
    });
    expect(fetchLike.status).toBe(404);
    expect(fetchLike.headers.get('content-type')).toBe('application/problem+json');
    const worker = await kit.request('GET', '/sw.js', {
      headers: { 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'serviceworker' },
    });
    expect(worker.status).toBe(404);
    expect(worker.headers.get('content-type')).toBe('application/problem+json');
    const plainWorker = await kit.request('GET', '/sw.js');
    expect(plainWorker.headers.get('content-type')).toBe('application/problem+json');
    const api = await kit.request('GET', '/api/v1/nope', { headers: NAVIGATE });
    expect(api.headers.get('content-type')).toBe('application/problem+json');
  });

  it('isBrowserNavigation: GET/HEAD only; Sec-Fetch-* wins over Accept; q=0 is not a listing', () => {
    const nav = (method: string, headers: Record<string, string>) =>
      isBrowserNavigation(new Request('http://x/sessions', { method, headers }));
    expect(nav('GET', NAVIGATE)).toBe(true);
    expect(nav('HEAD', { 'sec-fetch-mode': 'NAVIGATE' })).toBe(true);
    expect(nav('POST', NAVIGATE)).toBe(false);
    expect(nav('GET', { 'sec-fetch-mode': 'cors', accept: 'text/html' })).toBe(false);
    expect(nav('GET', { 'sec-fetch-dest': 'iframe', accept: 'text/html' })).toBe(false);
    expect(nav('GET', { accept: 'Text/HTML; charset=utf-8' })).toBe(true);
    expect(nav('GET', { accept: 'application/json, text/html;q=0' })).toBe(false);
    expect(nav('GET', { accept: '*/*' })).toBe(false);
    expect(nav('GET', {})).toBe(false);
  });

  it('the status page: viewport, light and dark styles, no script, the facts', () => {
    const html = statusPageHtml({
      version: '1.2.3',
      transport: 'http',
      mcpUrl: 'http://127.0.0.1:9876/mcp',
    });
    expect(html).toContain('<meta name="viewport"');
    expect(html).toMatch(/<style>[^<]*prefers-color-scheme:\s*dark/);
    expect(html).not.toContain('<script');
    const text = plainText(html);
    expect(text).toContain('BrowserHive 1.2.3');
    expect(text).toContain('http://127.0.0.1:9876/mcp');
    expect(text).toContain('Transporthttp');
  });
});

describe('admin=true: the installable-app files come from the bundle (03 §8)', () => {
  it.each([
    ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  ])('%s is served with its MIME type and no-cache, not as index.html', async (path, type) => {
    const kit = await createHttpKit({ spa: bundle, seed: false });
    const response = await kit.request('GET', path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get(VERSION_HEADER)).toBe(VERSION);
    expect(await response.text()).not.toContain('<div id="root">');
  });
});
