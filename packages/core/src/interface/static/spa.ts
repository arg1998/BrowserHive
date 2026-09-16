/** @module interface/static/spa — the dashboard SPA: hashed assets, templated `index.html` with a CSP nonce, History-API fallback (spec 03 §8). */

import type { StaticAssets } from '../../ports/static-assets.ts';
import { dashboardCsp } from '../http/middleware/secure-headers.ts';
import { assetResponse } from './assets-response.ts';

/** Path prefixes that never fall back to `index.html`. */
export const NON_SPA_PREFIXES: readonly string[] = ['/api', '/mcp', '/health', '/trace-viewer'];

/** True when `path` belongs to the SPA (not an API/transport prefix). */
export function isSpaPath(path: string): boolean {
  return !NON_SPA_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Adds `nonce` to every `<script>` without one and the version meta tag. */
export function templateIndex(html: string, nonce: string, version: string): string {
  const withNonce = html.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  const meta = `<meta name="browserhive-version" content="${version}" />`;
  return withNonce.includes('</head>')
    ? withNonce.replace('</head>', `    ${meta}\n  </head>`)
    : `${meta}${withNonce}`;
}

/** Shown when the server runs with `admin=true` but no bundle is installed. */
export const MISSING_BUNDLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BrowserHive</title></head><body><h1>BrowserHive</h1><p>The dashboard bundle is not installed in this build. The API is available under <code>/api/v1</code> (see <a href="/api/v1/docs">/api/v1/docs</a>).</p></body></html>`;

/** Dependencies of {@link serveSpa}. */
export interface SpaDeps {
  readonly assets: StaticAssets;
  readonly version: string;
}

/**
 * Serves one GET/HEAD: an existing bundle file (hashed files immutable) or `index.html` for any
 * other SPA path, including paths with dots. `null` for non-SPA paths (the caller 404s).
 */
export async function serveSpa(
  deps: SpaDeps,
  request: Request,
  nonce: string,
): Promise<Response | null> {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (!isSpaPath(path)) return null;
  const relative = path.replace(/^\/+/, '');
  if (relative !== '' && relative !== 'index.html') {
    const asset = await deps.assets.get(relative);
    if (asset !== null) return assetResponse(asset, request);
    if (relative.startsWith('assets/')) return new Response('Not found', { status: 404 });
  }
  const html = await deps.assets.indexHtml();
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-security-policy': dashboardCsp(nonce),
  };
  const body = html === null ? MISSING_BUNDLE_HTML : templateIndex(html, nonce, deps.version);
  return new Response(request.method.toUpperCase() === 'HEAD' ? null : body, {
    status: 200,
    headers,
  });
}
