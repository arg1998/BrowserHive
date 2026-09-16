/** @module interface/static/static.test — SPA fallback (dots included), hashed-asset caching, templated index with nonce, trace viewer mount. */

import { describe, expect, it } from 'bun:test';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';
import type { StaticAsset, StaticAssets, TraceViewerAssets } from '../../ports/static-assets.ts';
import { isSpaPath, serveSpa, templateIndex } from './spa.ts';
import { serveTraceViewer } from './trace-viewer.ts';

function asset(path: string, body: string, immutable: boolean): StaticAsset {
  return {
    path,
    contentType: 'text/javascript; charset=utf-8',
    bytes: new TextEncoder().encode(body),
    etag: '"e1"',
    immutable,
  };
}

const INDEX =
  '<!doctype html><html><head><script>boot()</script></head><body><script type="module" src="/assets/app-1.js"></script></body></html>';

const assets: StaticAssets = {
  available: true,
  indexHtml: async () => INDEX,
  get: async (path) =>
    path === 'assets/app-1.js'
      ? asset(path, 'app()', true)
      : path === 'favicon.svg'
        ? asset(path, '<svg/>', false)
        : null,
};

describe('SPA serving', () => {
  it('classifies SPA paths', () => {
    expect(isSpaPath('/sessions/shop-00000001')).toBe(true);
    expect(isSpaPath('/websites/example.com')).toBe(true);
    expect(isSpaPath('/api/v1/sessions')).toBe(false);
    expect(isSpaPath('/trace-viewer/index.html')).toBe(false);
  });

  it('serves hashed assets immutable with 304 on ETag match', async () => {
    const response = await serveSpa(
      { assets, version: '1' },
      new Request('http://x/assets/app-1.js'),
      'n',
    );
    expect(response?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const again = await serveSpa(
      { assets, version: '1' },
      new Request('http://x/assets/app-1.js', { headers: { 'if-none-match': '"e1"' } }),
      'n',
    );
    expect(again?.status).toBe(304);
    const missing = await serveSpa(
      { assets, version: '1' },
      new Request('http://x/assets/gone.js'),
      'n',
    );
    expect(missing?.status).toBe(404);
  });

  it('falls back to a templated index.html (no-cache, nonce, version) for routes with dots', async () => {
    const response = await serveSpa(
      { assets, version: '9.9.9' },
      new Request('http://x/websites/example.com'),
      'abc123',
    );
    expect(response?.headers.get('cache-control')).toBe('no-cache');
    expect(response?.headers.get('content-security-policy')).toContain("'nonce-abc123'");
    // Regression: Vite inlines fonts as data URIs; without font-src they fall back to default-src.
    expect(response?.headers.get('content-security-policy')).toContain("font-src 'self' data:");
    const html = (await response?.text()) ?? '';
    expect(html.match(/nonce="abc123"/g)?.length).toBe(2);
    expect(html).toContain('<meta name="browserhive-version" content="9.9.9" />');
  });

  it('templateIndex keeps existing nonces', () => {
    expect(templateIndex('<script nonce="x"></script>', 'y', '1')).toContain('nonce="x"');
  });

  it('is mounted at / when admin=true and never shadows the API', async () => {
    const kit = await createHttpKit({ spa: assets, seed: false });
    const page = await kit.request('GET', '/sessions');
    expect(page.headers.get('content-type')).toContain('text/html');
    const api = await kit.request('GET', '/api/v1/nope');
    expect(api.headers.get('content-type')).toBe('application/problem+json');
  });
});

describe('trace viewer', () => {
  const viewer: TraceViewerAssets = {
    available: true,
    get: async (path) =>
      path === 'index.html' ? { ...asset(path, '<html/>', false), contentType: 'text/html' } : null,
  };

  it('answers /ping, serves index for / and 404s traversal', async () => {
    expect(
      await (await serveTraceViewer(viewer, new Request('http://x/trace-viewer/ping'))).text(),
    ).toBe('ok');
    const index = await serveTraceViewer(viewer, new Request('http://x/trace-viewer/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain('sandbox');
    expect(
      (await serveTraceViewer(viewer, new Request('http://x/trace-viewer/%2e%2e/secret'))).status,
    ).toBe(404);
  });

  it('requires an operator session and uses SAMEORIGIN framing', async () => {
    const kit = await createHttpKit({ seed: false });
    expect((await kit.request('GET', '/trace-viewer/ping')).status).toBe(401);
    const cookie = await kit.login();
    const ok = await kit.request('GET', '/trace-viewer/ping', { cookie });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});
