/** @module interface/http/middleware/access-log — middleware 2: one structured line per completed request (spec 03 §2). */

import type { MiddlewareHandler } from 'hono';
import type { Clock } from '../../../ports/clock.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { HttpEnv } from '../env.ts';

/**
 * Level of one access line. `debug` for traffic that would otherwise drown the `info` tail:
 * health checks, static dashboard files (assets, `index.html`, the trace viewer) and successful
 * reads by a signed-in dashboard operator (the UI's own polling). Everything else stays `info`:
 * API mutations, agent/bearer and MCP traffic, and every response with status ≥ 400.
 *
 * @returns The log level to use.
 */
export function accessLogLevel(input: {
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly authMethod: string | undefined;
}): 'debug' | 'info' {
  const { path, method, status, authMethod } = input;
  if (path === '/health' || path === '/api/v1/health') return 'debug';
  if (status >= 400) return 'info';
  if (!path.startsWith('/api/') && path !== '/api' && !path.startsWith('/mcp')) return 'debug';
  const safe = method === 'GET' || method === 'HEAD';
  return safe && authMethod === 'password-session' ? 'debug' : 'info';
}

/** Logs `request completed` with route, status, duration, principal and bytes at {@link accessLogLevel}. */
export function accessLog(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
}): MiddlewareHandler<HttpEnv> {
  const log = deps.logger.child({ module: 'http.access' });
  return async (c, next) => {
    const started = deps.clock.now();
    try {
      await next();
    } finally {
      const path = new URL(c.req.url).pathname;
      const principal = c.get('principal');
      const bytes = c.res.headers.get('content-length');
      const fields = {
        route_pattern: c.get('operationId') ?? c.req.routePath,
        method: c.req.method,
        status: c.res.status,
        duration_ms: deps.clock.now() - started,
        principal: principal?.subject ?? null,
        bytes: bytes === null ? null : Number(bytes),
        request_id: c.get('requestId'),
      };
      const level = accessLogLevel({
        path,
        method: c.req.method,
        status: c.res.status,
        authMethod: principal?.auth.method,
      });
      if (level === 'debug') log.debug('request completed', fields);
      else log.info('request completed', fields);
    }
  };
}
