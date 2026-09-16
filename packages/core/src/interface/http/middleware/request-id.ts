/** @module interface/http/middleware/request-id — middleware 1: request id, `traceparent`, client facts, request context and the `http.request` span (spec 03 §2, spec 10 §5–6). */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { MiddlewareHandler } from 'hono';
import { runWithRequestContext } from '../../../kernel/context.ts';
import type { IdGenerator } from '../../../ports/id-generator.ts';
import { type HttpContext, type HttpEnv, serverOf } from '../env.ts';
import { createClientResolver } from './client-ip.ts';
import {
  acceptRequestId,
  formatTraceparent,
  parseTraceparent,
  randomHex,
  traceIdsFor,
} from './trace-ids.ts';

/** Dependencies of {@link requestId}. */
export interface RequestIdDeps {
  readonly ids: IdGenerator;
  readonly trustedProxies: readonly string[];
  /** Socket address of the peer; defaults to Bun's `server.requestIP(req)` when served by Bun. */
  readonly peerAddress?: (c: HttpContext) => string | undefined;
}

/**
 * Seeds every request: accepts or mints the request id (a ULID), adopts an inbound `traceparent`,
 * resolves the client IP through trusted proxies, opens the `http.request` span and runs the rest
 * of the stack inside the request context. Echoes `X-Request-Id` and `traceparent`.
 */
export function requestId(deps: RequestIdDeps): MiddlewareHandler<HttpEnv> {
  const clients = createClientResolver(deps.trustedProxies);
  const tracer = trace.getTracer('browserhive');
  return async (c, next) => {
    const id = acceptRequestId(c.req.header('x-request-id')) ?? deps.ids.eventId().slice(2);
    const inbound = parseTraceparent(c.req.header('traceparent'));
    const client = clients.resolve(
      (deps.peerAddress ?? defaultPeer)(c),
      c.req.header('x-forwarded-for'),
      c.req.header('x-forwarded-proto'),
    );
    c.set('requestId', id);
    c.set('clientIp', client.ip);
    c.set('remoteLoopback', client.loopback);
    c.set('secure', client.secure);
    c.set('nonce', randomHex(16));
    c.set('principal', null);
    c.set('operationId', undefined);
    const method = c.req.method;
    await tracer.startActiveSpan(
      'http.request',
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } },
      async (span) => {
        const ids = traceIdsFor(span, inbound);
        c.set('traceId', ids.traceId);
        c.set('spanId', ids.spanId);
        try {
          await runWithRequestContext(
            { traceId: ids.traceId, spanId: ids.spanId, requestId: id, transport: 'http' },
            () => next(),
          );
        } finally {
          const status = c.res.status;
          const principal = c.get('principal');
          span.setAttribute('http.route', c.get('operationId') ?? c.req.routePath);
          span.setAttribute('http.response.status_code', status);
          if (principal !== null) span.setAttribute('browserhive.principal', principal.subject);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          c.header('x-request-id', id);
          c.header('traceparent', formatTraceparent(ids));
        }
      },
    );
  };
}

function defaultPeer(c: HttpContext): string | undefined {
  return serverOf(c)?.requestIP(c.req.raw)?.address;
}
