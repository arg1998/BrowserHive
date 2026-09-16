/** @module interface/static/assets-response — one asset → `Response` with ETag, encodings and cache policy. */

import type { StaticAsset } from '../../ports/static-assets.ts';

/** Immutable caching for content-hashed files (spec 03 §8). */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** Revalidate-always caching for everything else. */
export const REVALIDATE_CACHE = 'no-cache';

/** Serves `asset` honouring `If-None-Match` and `Accept-Encoding` (br, then gzip). */
export function assetResponse(
  asset: StaticAsset,
  request: Request,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', asset.contentType);
  headers.set('etag', asset.etag);
  headers.set('cache-control', asset.immutable ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
  headers.set('vary', 'accept-encoding');
  if (request.headers.get('if-none-match') === asset.etag) {
    return new Response(null, { status: 304, headers });
  }
  const accept = request.headers.get('accept-encoding') ?? '';
  let body = asset.bytes;
  if (asset.encodings?.br !== undefined && /\bbr\b/.test(accept)) {
    body = asset.encodings.br;
    headers.set('content-encoding', 'br');
  } else if (asset.encodings?.gzip !== undefined && /\bgzip\b/.test(accept)) {
    body = asset.encodings.gzip;
    headers.set('content-encoding', 'gzip');
  }
  const method = request.method.toUpperCase();
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}
