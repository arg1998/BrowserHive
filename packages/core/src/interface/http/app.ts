/** @module interface/http/app — `createHttpApp(deps)`: middleware stack, `/api/v1`, `/mcp`, `/health`, WS upgrade, trace viewer and the SPA on one Hono app (spec 03 §1–2, §8; D-02). */

import { API_PREFIX } from '@browserhive/contracts/http';
import { WS_PATH } from '@browserhive/contracts/ws';
import { Hono } from 'hono';
import type { Authenticator } from '../../app/auth/authenticate.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { StaticAssets, TraceViewerAssets } from '../../ports/static-assets.ts';
import { serveSpa } from '../static/spa.ts';
import { statusPageHtml } from '../static/status-page.ts';
import { serveTraceViewer, TRACE_VIEWER_PREFIX } from '../static/trace-viewer.ts';
import { upgradeHandler } from '../ws/upgrade.ts';
import { type AnyRoute, pathPattern } from './define-route.ts';
import { mountRoutes } from './dispatch.ts';
import { disableIdleTimeout, type HttpAppConfig, type HttpContext, type HttpEnv } from './env.ts';
import { healthOf } from './health.ts';
import { accessLog } from './middleware/access-log.ts';
import { authenticateRoute, authViewOf } from './middleware/auth.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { hostGuard } from './middleware/host-guard.ts';
import { originGuard } from './middleware/origin-guard.ts';
import { LOGIN_CONCURRENCY, Semaphore, TokenBuckets } from './middleware/rate-limit.ts';
import { requestId } from './middleware/request-id.ts';
import { secureHeaders } from './middleware/secure-headers.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { apiRoutes } from './routes/index.ts';
import type { HttpServices, McpRequestHandler } from './services.ts';

/** Everything the composition root supplies to the HTTP surface. */
export interface HttpAppDeps {
  readonly config: HttpAppConfig;
  readonly services: HttpServices;
  /** `adminProviderChain` authenticator (cookie, bearer, grant). */
  readonly adminAuthenticator: Authenticator;
  /** `mcpProviderChain` authenticator (bearer, local). */
  readonly mcpAuthenticator: Authenticator;
  /** `handleMcpRequest` from `interface/mcp/transports/http.ts`; absent → `/mcp` 404. */
  readonly mcp?: McpRequestHandler;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly version: string;
  readonly spa: StaticAssets;
  readonly traceViewer: TraceViewerAssets;
  /** Peer address resolver; defaults to Bun's `server.requestIP`. */
  readonly peerAddress?: (c: HttpContext) => string | undefined;
}

/** The built HTTP surface. */
export interface HttpApp {
  readonly app: Hono<HttpEnv>;
  /** `Bun.serve({ fetch })`: passes the server as Hono's env (peer IP, WS upgrade). */
  readonly fetch: (request: Request, server?: unknown) => Response | Promise<Response>;
  readonly routes: readonly AnyRoute[];
  /** The OpenAPI 3.1 document. */
  openApiDocument(): object;
  /** Periodic housekeeping (rate-limit buckets); schedule every 60 s. */
  sweep(): void;
}

/** Builds the Hono app. The WS `websocket` handler comes from `createRealtimeHub`. */
export function createHttpApp(deps: HttpAppDeps): HttpApp {
  const { config, services } = deps;
  const app = new Hono<HttpEnv>();
  let document: object | undefined;
  const routes = apiRoutes({
    admin: config.admin,
    logger: deps.logger,
    document: () => {
      document ??= buildOpenApiDocument(routes, deps.version);
      return document;
    },
  });
  const buckets = new TokenBuckets(() => deps.clock.now());
  const known = routes.map((r) => ({
    method: r.method,
    pattern: pathPattern(`${API_PREFIX}${r.path}`),
  }));

  app.use(
    '*',
    requestId({
      ids: deps.ids,
      trustedProxies: config.trustedProxies ?? [],
      ...(deps.peerAddress !== undefined && { peerAddress: deps.peerAddress }),
    }),
  );
  app.use('*', accessLog({ clock: deps.clock, logger: deps.logger }));
  app.use('*', secureHeaders());
  app.use(
    '*',
    hostGuard({
      host: config.host,
      ...(config.allowedHosts !== undefined && { allowedHosts: config.allowedHosts }),
    }),
  );
  app.use(`${API_PREFIX}/*`, originGuard());
  app.onError(errorHandler(deps.logger));

  const health = (c: HttpContext) => {
    const result = healthOf(services.health, services.system.facts(), deps.clock.now());
    return c.json(result.body, result.status);
  };
  app.on(['GET', 'HEAD'], '/health', health);

  app.all('/mcp', async (c) => {
    if (deps.mcp === undefined) throw new AppError('NOT_FOUND', {});
    const view = authViewOf(c, 'http');
    const principal =
      config.authMode === 'token'
        ? await deps.mcpAuthenticator.require(view)
        : await deps.mcpAuthenticator.authenticate(view);
    if (principal === null) throw new AppError('UNAUTHORIZED', {});
    c.set('principal', principal);
    disableIdleTimeout(c);
    return deps.mcp(c.req.raw, principal);
  });

  app.get(`${API_PREFIX}${WS_PATH}`, upgradeHandler(deps.adminAuthenticator));
  mountRoutes(app, API_PREFIX, routes, {
    services,
    authenticator: deps.adminAuthenticator,
    clock: deps.clock,
    logger: deps.logger,
    buckets,
    loginSemaphore: new Semaphore(LOGIN_CONCURRENCY),
  });

  app.on(['GET', 'HEAD'], `${TRACE_VIEWER_PREFIX}/*`, async (c) => {
    if (!config.admin) throw new AppError('NOT_FOUND', {});
    const principal = await authenticateRoute(deps.adminAuthenticator, authViewOf(c, 'http'), {
      operationId: 'traceViewer',
      scope: 'sessions:read',
      auth: ['password-session', 'bearer'],
    });
    c.set('principal', principal);
    if (principal.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED', {});
    return serveTraceViewer(deps.traceViewer, c.req.raw);
  });

  app.on(['GET', 'HEAD'], '*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!config.admin) {
      if (path !== '/') return next();
      const html = statusPageHtml({
        version: deps.version,
        transport: services.system.facts().transport,
        mcpUrl: `http://${config.host}:${config.port}/mcp`,
      });
      return c.html(html);
    }
    const response = await serveSpa(
      { assets: deps.spa, version: deps.version },
      c.req.raw,
      c.get('nonce'),
    );
    return response ?? next();
  });
  app.notFound(notFoundHandler(() => known));

  return {
    app,
    routes,
    fetch: (request, server) => app.fetch(request, server),
    openApiDocument: () => {
      document ??= buildOpenApiDocument(routes, deps.version);
      return document;
    },
    sweep: () => buckets.sweep(),
  };
}
