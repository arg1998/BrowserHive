/** @module composition/phases/listeners-http — the http front door: realtime hub, `Bun.serve` on host/port (port 0 supported), MCP Streamable HTTP handler and the Hono app on one port (D-02). */

import type { ServerConfig } from '@browserhive/contracts/config';
import { RealtimeConnection } from '@browserhive/contracts/http';
import {
  AppError,
  createBunProcessRunner,
  LOG_MODULES,
  serializeError,
} from '@browserhive/core/runtime';
import type {
  HttpApp,
  McpHttpHandler,
  OperatorRequestBroker,
  Realtime,
} from '@browserhive/core/server';
import {
  configView,
  createArtifactFiles,
  createBunDesktop,
  createBunStaticAssets,
  createHttpApp,
  createMcpHttpHandler,
  createRealtimeHub,
  createTraceViewerAssets,
  playwrightBridgeFactory,
  sessionDirLayout,
} from '@browserhive/core/server';
import {
  blocklistPort,
  logLevelController,
  notificationsPort,
  preferencesPort,
} from '../adapters/http-ports.ts';
import { createTimers } from '../adapters/timers.ts';
import { type BootContext, part } from '../context.ts';
import { resolveDashboardDir } from '../dashboard-dir.ts';
import { errnoOf } from '../lock-file.ts';
import type { PhaseHandle } from '../unwind.ts';

/** Housekeeping interval of the HTTP rate-limit buckets. */
export const HTTP_SWEEP_INTERVAL_MS = 60_000;

/** The `Bun.serve` seam (tests inject a throwing or fake server). */
export type ServeFn = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request, server: unknown) => Response | Promise<Response>;
  readonly websocket: Realtime['websocket'];
}) => { readonly port: number | undefined; stop(closeActiveConnections?: boolean): unknown };

/** Production `Bun.serve`. */
export const bunServe: ServeFn = (options) =>
  Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch: (request, server) => options.fetch(request, server),
    websocket: options.websocket,
  });

/** Maps a listen failure onto `PORT_IN_USE` (exit 3) or `BIND_FAILED` (exit 1). */
export function bindError(err: unknown, host: string, port: number): AppError {
  const errno = errnoOf(err) ?? 'UNKNOWN';
  if (errno === 'EADDRINUSE') {
    return new AppError(
      'PORT_IN_USE',
      { host, port, errno },
      {
        cause: err,
        publicMessage: `Cannot listen on ${host}:${port}: the port is already in use (${errno}).`,
      },
    );
  }
  return new AppError(
    'BIND_FAILED',
    { host, port, errno },
    { cause: err, publicMessage: `Cannot listen on ${host}:${port} (${errno}).` },
  );
}

/** URL authority for a host (IPv6 literals in brackets). */
export function urlFor(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return `http://${bare.includes(':') ? `[${bare}]` : bare}:${port}`;
}

/**
 * Cancels the open attention requests of a principal whose last MCP session closed (spec 02 §1.2);
 * an agent that reconnects on another session keeps its requests.
 */
export async function cancelAttentionOf(
  broker: Pick<OperatorRequestBroker, 'listOpen' | 'cancel'>,
  subject: string,
): Promise<number> {
  let cancelled = 0;
  for (const request of broker.listOpen('attention')) {
    if (request.owner === subject && (await broker.cancel(request.requestId))) cancelled += 1;
  }
  return cancelled;
}

/** Opens the http listener. */
export async function openHttpListener(
  ctx: BootContext,
  serve: ServeFn = bunServe,
): Promise<PhaseHandle> {
  const config: Readonly<ServerConfig> = ctx.config;
  const { logger, ring } = part(ctx.observability, 'observability');
  const storage = part(ctx.storage, 'storage');
  const domain = part(ctx.domain, 'domain');
  const observers = part(ctx.observers, 'observers');
  const attention = domain.attention;
  if (attention === null) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'composition' },
      { message: 'http without attention' },
    );
  }
  const log = logger.child({ module: 'http' });
  const timers = createTimers((err) =>
    log.warn('timer callback failed', { err: serializeError(err) }),
  );
  const { sessions, pageActions } = domain;

  const realtime = createRealtimeHub({
    clock: ctx.clock,
    ids: domain.ids,
    logger,
    auth: domain.auth,
    attention,
    serverVersion: ctx.input.appVersion,
    epoch: domain.ids.opaque(12),
    degradations: domain.degradations,
    bus: domain.bus,
    sessions,
    pageOf: (session) => sessions.page(session),
    bridges: playwrightBridgeFactory((session) => sessions.page(session)),
    logs: ring,
    schedule: timers.schedule,
    every: timers.every,
    inputAudit: {
      actions: storage.uow.repos.operatorActions,
      eventId: () => domain.ids.eventId(),
    },
    quality: config.screencastQuality,
    onOperatorPointer: (session, x, y) => {
      try {
        pageActions.observeExternalMove(session.id, sessions.page(session), x, y);
      } catch {
        // No active page; the next humanized move re-seeds the cursor.
      }
    },
    onViewportChanged: (session) => {
      try {
        pageActions.invalidateCursor(session.id, sessions.page(session));
      } catch {
        // The session has no page any more; nothing to invalidate.
      }
    },
  });

  // Bind first so port 0 resolves to the real port before the app and MCP handler are built.
  let app: HttpApp | undefined;
  let server: ReturnType<ServeFn>;
  try {
    server = serve({
      hostname: config.host,
      port: config.port,
      fetch: (request, bunServer) =>
        app === undefined
          ? new Response('starting', { status: 503 })
          : app.fetch(request, bunServer),
      websocket: realtime.websocket,
    });
  } catch (err) {
    ctx.health.check('listeners', 'failed');
    throw bindError(err, config.host, config.port);
  }
  const port = server.port ?? config.port;
  const url = urlFor(config.host, port);

  let mcp: McpHttpHandler | undefined;
  try {
    mcp = createMcpHttpHandler({
      runtime: domain.runtime,
      dispatcher: domain.dispatcher,
      ids: domain.ids,
      clock: ctx.clock,
      logger,
      connections: storage.uow.repos.mcpConnections,
      host: config.host,
      allowedHosts: config.allowedHosts,
      onSessionClosed: (closed) => {
        if (closed.remainingForSubject > 0) return;
        void cancelAttentionOf(domain.broker, closed.subject).catch((err: unknown) =>
          log.warn('attention cancel failed', { err: serializeError(err) }),
        );
      },
    });
    const handler = mcp;
    const traceViewer = createTraceViewerAssets();
    app = createHttpApp({
      config: {
        host: config.host,
        port,
        admin: config.admin,
        authMode: config.auth,
        trustedProxies: config.trustedProxies,
        allowedHosts: config.allowedHosts,
        allowInsecureBind: config.allowInsecureBind,
      },
      services: {
        sessions,
        repos: storage.uow.repos,
        analytics: storage.analytics,
        attention,
        vault: domain.vault,
        auth: domain.auth,
        blocklist: blocklistPort(domain.blocklist, config.blocklist ?? null),
        notifications: notificationsPort(domain.notifications, storage.uow.repos.notifications),
        preferences: preferencesPort(domain.preferences, () => ctx.clock.now()),
        logs: ring,
        logLevel: logLevelController(logger, LOG_MODULES),
        system: {
          facts: () => ({
            version: ctx.input.appVersion,
            transport: 'http',
            startedAt: ctx.startedAt,
            traceEnabled: config.trace,
          }),
          configView: () => configView(ctx.input.resolved.config, ctx.input.resolved.provenance),
        },
        systemStatus: observers.status,
        health: ctx.health,
        files: createArtifactFiles(),
        desktop: createBunDesktop({
          runner: createBunProcessRunner(),
          platform: ctx.input.host.platform,
          env: ctx.input.host.env,
        }),
        sessionDirs: sessionDirLayout(config.dataDir),
        live: realtime.liveView,
        realtime: {
          connections: () => realtime.hub.connections().map((c) => RealtimeConnection.parse(c)),
          activeScreencasts: () => realtime.hub.activeScreencasts(),
          hasViewers: (sessionId) => realtime.hub.hasViewers(sessionId),
        },
        idempotency: storage.uow.repos.idempotency,
        events: domain.bus,
        ids: domain.ids,
        traceViewerAvailable: traceViewer.available,
      },
      adminAuthenticator: domain.adminAuthenticator,
      mcpAuthenticator: domain.mcpAuthenticator,
      mcp: (request, principal) => handler.handleMcpRequest(request, principal),
      clock: ctx.clock,
      ids: domain.ids,
      logger,
      version: ctx.input.appVersion,
      spa: createBunStaticAssets(config.admin ? resolveDashboardDir() : undefined),
      traceViewer,
    });
    realtime.start();
  } catch (err) {
    server.stop(true);
    await realtime.stop();
    ctx.health.check('listeners', 'failed');
    throw err;
  }
  const httpApp = app;
  const stopSweep = timers.every(() => httpApp.sweep(), HTTP_SWEEP_INTERVAL_MS);
  ctx.health.check('listeners', 'ok');
  const mcpHandler = mcp;
  ctx.listeners = {
    url,
    port,
    mcpConnections: () => mcpHandler.sessionCount,
    realtime: {
      connections: () => realtime.hub.connections().length,
      activeScreencasts: () => realtime.hub.activeScreencasts(),
    },
  };
  log.info('listening', { url });

  return {
    async stop(deadlineMs) {
      stopSweep();
      ctx.health.check('listeners', 'pending');
      await Promise.allSettled([mcpHandler.closeAll(), realtime.stop()]);
      const graceful = Promise.resolve(server.stop(false));
      const timedOut = await Promise.race([
        graceful.then(() => false),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), Math.max(0, deadlineMs - 100));
          t.unref?.();
        }),
      ]);
      if (timedOut) server.stop(true);
    },
  };
}
