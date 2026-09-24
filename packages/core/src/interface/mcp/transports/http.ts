/** @module interface/mcp/transports/http — Streamable HTTP for `/mcp`: one web-standard SDK transport + server per MCP session, connection rows, DNS-rebinding protection (the dashboard's Host policy), resumable SSE (spec 02 §1.2–1.4). */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { serializeError } from '../../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../../ports/clock.ts';
import type { IdGenerator } from '../../../ports/id-generator.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { McpConnectionRepository } from '../../../ports/persistence/operations.ts';
import { hostnameOf, isHostAllowed } from '../../http/middleware/host-guard.ts';
import type { RuntimeFacts } from '../context.ts';
import type { ToolDispatcher } from '../dispatcher.ts';
import { ConnectionIdentity, connectionPatchOf, headerBag } from '../identity.ts';
import { authInfoFor } from '../principal.ts';
import { createMcpServer } from '../server.ts';
import { InMemoryEventStore } from './event-store.ts';

/** SSE keep-alive under the common 30 s idle cut of proxies. */
export const MCP_KEEP_ALIVE_MS = 25_000;
/** Header carrying the MCP session id. */
export const MCP_SESSION_HEADER = 'mcp-session-id';

/** Options of {@link createMcpHttpHandler}. */
/** What {@link McpHttpOptions.onSessionClosed} receives. */
export interface McpSessionClosed {
  readonly mcpSessionId: string;
  readonly connectionId: string;
  readonly subject: string;
  /** Live MCP sessions the same principal still holds (a reconnecting agent keeps its work). */
  readonly remainingForSubject: number;
}

export interface McpHttpOptions {
  readonly runtime: RuntimeFacts;
  readonly dispatcher: ToolDispatcher;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `null` skips connection rows (tests, no database). */
  readonly connections: McpConnectionRepository | null;
  /** Bound host (for the Host check). */
  readonly host: string;
  /** Extra `Host` names to accept (`--allowedHosts`: reverse proxies, custom DNS names). */
  readonly allowedHosts?: readonly string[];
  readonly keepAliveMs?: number;
  /**
   * Called once per closed MCP session with how many live sessions its principal still holds;
   * the composition root cancels that principal's pending attention when none remain (spec 02 §1.2).
   */
  readonly onSessionClosed?: (closed: McpSessionClosed) => void;
}

/** Request facts the HTTP layer resolved before `/mcp` (03 §2). */
export interface McpRequestContext {
  /** The client IP (the peer, or the right-most untrusted `X-Forwarded-For` hop behind `trustedProxies`). */
  readonly clientIp?: string | null;
}

/** The `/mcp` handler the HTTP layer mounts. */
export interface McpHttpHandler {
  /** Handles `POST/GET/DELETE /mcp` for an already-authenticated principal. */
  handleMcpRequest(
    request: Request,
    principal: RequestPrincipal,
    context?: McpRequestContext,
  ): Promise<Response>;
  /** The connection record id of an MCP session, or `null`. */
  connectionIdOf(mcpSessionId: string | undefined): string | null;
  /** Live MCP sessions. */
  readonly sessionCount: number;
  /** Closes every transport (shutdown). */
  closeAll(): Promise<void>;
}

interface Entry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly connectionId: string;
  readonly subject: string;
  closed: boolean;
}

const InitializeParams = z.looseObject({
  protocolVersion: z.string().optional(),
  clientInfo: z
    .looseObject({
      name: z.string().optional(),
      version: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hasInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

function initializeParams(body: unknown): z.infer<typeof InitializeParams> {
  const message = Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : body;
  const params: unknown = isInitializeRequest(message) ? message.params : undefined;
  const parsed = InitializeParams.safeParse(params);
  return parsed.success ? parsed.data : {};
}

/** Builds the `/mcp` handler (sessions keyed by `mcp-session-id`, owned by the initializing principal). */
export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const sessions = new Map<string, Entry>();
  const log = options.logger.child({ module: 'mcp.http' });
  const hostPolicy = {
    host: options.host,
    ...(options.allowedHosts !== undefined && { allowedHosts: options.allowedHosts }),
  };

  const record = (label: string, work: Promise<unknown> | undefined): void => {
    void work?.catch((err: unknown) =>
      log.warn('connection write failed', { label, err: serializeError(err) }),
    );
  };

  const close = (sessionId: string): void => {
    const entry = sessions.get(sessionId);
    if (entry === undefined || entry.closed) return;
    entry.closed = true;
    sessions.delete(sessionId);
    record(
      'close',
      options.connections?.update(entry.connectionId, { closedAt: options.clock.now() }),
    );
    log.debug('mcp session closed', { mcpSessionId: sessionId });
    const remaining = [...sessions.values()].filter((e) => e.subject === entry.subject).length;
    try {
      options.onSessionClosed?.({
        mcpSessionId: sessionId,
        connectionId: entry.connectionId,
        subject: entry.subject,
        remainingForSubject: remaining,
      });
    } catch (err) {
      log.warn('session close hook failed', { err: serializeError(err) });
    }
  };

  const initialize = async (
    request: Request,
    body: unknown,
    principal: RequestPrincipal,
    context: McpRequestContext,
  ): Promise<Response> => {
    const connectionId = `c-${options.ids.opaque(10)}`;
    const params = initializeParams(body);
    let entry: Entry | undefined;
    const identity = new ConnectionIdentity({
      connectionId,
      logger: options.logger,
      signals: {
        transport: 'http',
        request: { headers: headerBag(request.headers), url: request.url },
        initialize: {
          ...(params.clientInfo !== undefined && {
            clientInfo: {
              ...(params.clientInfo.name !== undefined && { name: params.clientInfo.name }),
              ...(params.clientInfo.version !== undefined && {
                version: params.clientInfo.version,
              }),
              ...(params.clientInfo.title !== undefined && { title: params.clientInfo.title }),
            },
          }),
          ...(params.protocolVersion !== undefined && {
            protocolVersion: params.protocolVersion,
          }),
          ...(params.capabilities !== undefined && { capabilities: params.capabilities }),
          ...(params._meta !== undefined && { meta: params._meta }),
        },
        ip: context.clientIp ?? null,
      },
      // The row exists once the SDK assigns the session id; until then there is nothing to update.
      persist: (patch) =>
        entry === undefined ? undefined : options.connections?.update(connectionId, patch),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `m-${options.ids.opaque(16)}`,
      enableJsonResponse: false,
      eventStore: new InMemoryEventStore(),
      // The SDK's own check matches `host:port` exactly, which rejects every request behind a port
      // mapping or an SSH tunnel. `handleMcpRequest` applies the dashboard's port-agnostic policy.
      enableDnsRebindingProtection: false,
      keepAliveMs: options.keepAliveMs ?? MCP_KEEP_ALIVE_MS,
      onsessioninitialized: (sessionId) => {
        entry = { transport, connectionId, subject: principal.subject, closed: false };
        sessions.set(sessionId, entry);
        const now = options.clock.now();
        const resolved = identity.current;
        const columns = connectionPatchOf(resolved);
        record(
          'insert',
          options.connections?.insert({
            connectionId,
            principalId: principal.subject,
            transport: 'http',
            mcpSessionId: sessionId,
            clientName: resolved.clientName,
            clientVersion: resolved.clientVersion,
            clientTitle: resolved.clientTitle,
            protocolVersion: resolved.protocolVersion,
            capabilities: resolved.capabilities,
            workspace: resolved.workspace,
            agentName: resolved.workspace,
            model: resolved.model,
            modelSource: resolved.modelSource,
            harness: resolved.harness,
            harnessSource: resolved.harnessSource,
            conflicts: columns.conflicts ?? [],
            meta: resolved.meta,
            ip: resolved.ip,
            userAgent: resolved.userAgent,
            connectedAt: now,
            lastSeenAt: now,
            closedAt: null,
          }),
        );
      },
      onsessionclosed: (sessionId) => close(sessionId),
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) close(transport.sessionId);
    };
    const server = createMcpServer({
      runtime: options.runtime,
      dispatcher: options.dispatcher,
      connectionIdOf: () => connectionId,
      identity,
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body, authInfo: authInfoFor(principal) });
  };

  return {
    get sessionCount() {
      return sessions.size;
    },
    connectionIdOf(mcpSessionId) {
      return mcpSessionId === undefined ? null : (sessions.get(mcpSessionId)?.connectionId ?? null);
    },
    async handleMcpRequest(request, principal, context = {}) {
      // DNS-rebinding defense, identical to `hostGuard` (spec 03 §2), so `/mcp` and the dashboard
      // can never disagree about a Host. The HTTP layer checks first; this covers embedders.
      const host = request.headers.get('host') ?? new URL(request.url).host;
      if (!isHostAllowed(hostnameOf(host), hostPolicy)) {
        return jsonRpcError(403, -32000, `Invalid Host header: ${host}`);
      }
      const sessionId = request.headers.get(MCP_SESSION_HEADER);
      if (sessionId !== null) {
        const entry = sessions.get(sessionId);
        // Another principal's MCP session answers exactly like an unknown one.
        if (entry === undefined || entry.subject !== principal.subject) {
          return jsonRpcError(404, -32001, 'Session not found');
        }
        record(
          'touch',
          options.connections?.update(entry.connectionId, { lastSeenAt: options.clock.now() }),
        );
        return entry.transport.handleRequest(request, { authInfo: authInfoFor(principal) });
      }
      if (request.method !== 'POST') {
        return jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        // Malformed JSON is a protocol error, not a server fault.
        return jsonRpcError(400, -32700, 'Parse error: Invalid JSON');
      }
      if (!hasInitialize(body)) {
        return jsonRpcError(400, -32000, 'Bad Request: No valid session ID provided');
      }
      return initialize(request, body, principal, context);
    },
    async closeAll() {
      const entries = [...sessions.entries()];
      await Promise.allSettled(entries.map(([, e]) => e.transport.close()));
      for (const [id] of entries) close(id);
    },
  };
}
