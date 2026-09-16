/** @module interface/static/trace-viewer — the Playwright trace viewer under `/trace-viewer/*`, behind admin auth with a sandboxed CSP (spec 03 §8). */

import type { TraceViewerAssets } from '../../ports/static-assets.ts';
import { TRACE_VIEWER_CSP } from '../http/middleware/secure-headers.ts';
import { assetResponse } from './assets-response.ts';

/** Mount prefix. */
export const TRACE_VIEWER_PREFIX = '/trace-viewer';

/**
 * Serves one viewer request (auth already checked). `/ping` answers `ok` (the viewer's live-reload
 * poll); `/` is `index.html`; traversal and unknown files 404. The viewer loads `trace.zip` from
 * the `?trace=` URL, which carries a grant because its service worker cannot send the cookie.
 */
export async function serveTraceViewer(
  assets: TraceViewerAssets,
  request: Request,
): Promise<Response> {
  const headers = { 'content-security-policy': TRACE_VIEWER_CSP };
  const full = decodeURIComponent(new URL(request.url).pathname);
  if (full !== TRACE_VIEWER_PREFIX && !full.startsWith(`${TRACE_VIEWER_PREFIX}/`)) {
    return new Response('Not found', { status: 404, headers });
  }
  const path = full.slice(TRACE_VIEWER_PREFIX.length);
  if (path === '/ping') {
    return new Response('ok', {
      status: 200,
      headers: { ...headers, 'content-type': 'text/plain' },
    });
  }
  if (!assets.available) {
    return new Response('Trace viewer bundle not installed', { status: 404, headers });
  }
  const relative = path === '' || path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  if (relative.split('/').includes('..'))
    return new Response('Not found', { status: 404, headers });
  const asset = await assets.get(relative);
  if (asset === null) return new Response('Not found', { status: 404, headers });
  return assetResponse(asset, request, headers);
}
