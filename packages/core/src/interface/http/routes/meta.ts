/** @module interface/http/routes/meta — `/health`, `/openapi.json`, `/docs` and the WS upgrade descriptor (spec 03 §4.1, §4.7, §6.1). */

import { HealthResponse } from '@browserhive/contracts/http';
import { Scalar } from '@scalar/hono-api-reference';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, raw, reply } from '../define-route.ts';
import type { HttpEnv } from '../env.ts';
import { healthOf } from '../health.ts';

/** CSP of the docs page: the reference UI script comes from jsDelivr. */
export const DOCS_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:";

/** Inputs of the meta routes. */
export interface MetaRouteDeps {
  /** The OpenAPI 3.1 document (built lazily from the route table). */
  readonly document: () => object;
  /** `/docs` is public when the admin surface is on, 404 otherwise. */
  readonly admin: boolean;
}

/** Meta routes. */
export function metaRoutes(deps: MetaRouteDeps) {
  const docs = Scalar<HttpEnv>({ url: '/api/v1/openapi.json', pageTitle: 'BrowserHive API' });
  return [
    defineRoute({
      operationId: 'getHealth',
      tags: ['health'],
      summary: 'Liveness/readiness; 200 only when ready (also served at `/health`).',
      request: {},
      responses: { 200: HealthResponse, 503: HealthResponse },
      rateLimit: 'service',
      async handler({ services, ctx }) {
        const health = healthOf(services.health, services.system.facts(), ctx.now);
        return health.status === 200 ? reply(200, health.body) : reply(503, health.body);
      },
    }),
    defineRoute({
      operationId: 'getOpenApi',
      tags: ['meta'],
      summary: 'This OpenAPI 3.1 document.',
      request: {},
      responses: {},
      raw: [{ status: 200, contentType: 'application/json', description: 'OpenAPI 3.1.' }],
      async handler() {
        return raw(
          new Response(JSON.stringify(deps.document()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    }),
    defineRoute({
      operationId: 'getDocs',
      tags: ['meta'],
      summary: 'API reference UI (admin surface only).',
      request: {},
      responses: {},
      raw: [{ status: 200, contentType: 'text/html', description: 'Reference UI.' }],
      async handler({ hono }) {
        if (!deps.admin) throw new AppError('NOT_FOUND', {});
        const result = await docs(hono, async () => undefined);
        const response = result instanceof Response ? result : hono.res;
        const headers = new Headers(response.headers);
        headers.set('content-security-policy', DOCS_CSP);
        return raw(new Response(response.body, { status: response.status, headers }));
      },
    }),
    defineRoute({
      operationId: 'wsUpgrade',
      tags: ['realtime'],
      summary:
        'Realtime WebSocket (`Sec-WebSocket-Protocol: browserhive.v1`). Auth failures upgrade then close 4401; see the WS protocol.',
      request: {},
      responses: {},
      raw: [{ status: 101, contentType: 'none', description: 'Switching protocols.' }],
      selfMounted: true,
      async handler() {
        throw new AppError('NOT_FOUND', {});
      },
    }),
  ];
}
