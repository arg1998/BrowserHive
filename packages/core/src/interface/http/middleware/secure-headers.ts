/** @module interface/http/middleware/secure-headers — middleware 3: CSP and hardening headers (spec 03 §2). */

import type { MiddlewareHandler } from 'hono';
import type { HttpEnv } from '../env.ts';

/** CSP of the trace viewer: third-party code, sandboxed (spec 03 §2). */
export const TRACE_VIEWER_CSP =
  "sandbox allow-scripts allow-same-origin; default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:";

/** CSP of API responses (nothing to load, never framed). */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The dashboard CSP with a per-response script nonce (spec 03 §2). */
export function dashboardCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // Vite inlines small font files as data URIs.
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Sets `X-Content-Type-Options`, `X-Frame-Options` (`SAMEORIGIN` under `/trace-viewer`),
 * `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, a default CSP when the
 * handler set none, and HSTS only for TLS behind a trusted proxy.
 */
export function secureHeaders(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    const traceViewer = path === '/trace-viewer' || path.startsWith('/trace-viewer/');
    const headers = c.res.headers;
    headers.set('x-content-type-options', 'nosniff');
    headers.set('x-frame-options', traceViewer ? 'SAMEORIGIN' : 'DENY');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    headers.set('cross-origin-opener-policy', 'same-origin');
    if (!headers.has('content-security-policy')) {
      headers.set(
        'content-security-policy',
        traceViewer ? TRACE_VIEWER_CSP : dashboardCsp(c.get('nonce')),
      );
    }
    if (c.get('secure')) headers.set('strict-transport-security', 'max-age=31536000');
  };
}
