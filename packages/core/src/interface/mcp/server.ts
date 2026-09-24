/** @module interface/mcp/server — `createMcpServer`: the official-SDK `McpServer` with the 43 tools registered from the registry and `tools/call` routed through the dispatcher (spec 02 §1.1, D-02). */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  InitializeRequestSchema,
  type InitializeResult,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeFacts } from './context.ts';
import type { DispatchCall, ToolDispatcher } from './dispatcher.ts';
import {
  type ConnectionIdentity,
  clientOfIdentity,
  headerBag,
  type InitializeSignals,
  type RequestSignals,
} from './identity.ts';
import { principalFromAuthInfo } from './principal.ts';

/** Server name advertised in `serverInfo` (overridable only through the programmatic API). */
export const SERVER_NAME = 'browserhive';

/** Options of {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  readonly runtime: RuntimeFacts;
  readonly dispatcher: ToolDispatcher;
  /** Embedders only; defaults to `browserhive`. */
  readonly name?: string;
  /** Maps the transport's MCP session id to its `connections` record id (http); `null` otherwise. */
  readonly connectionIdOf?: (mcpSessionId: string | undefined) => string | null;
  /**
   * The connection's identity (spec 02 §1.4): told what `initialize` revealed and resolved again
   * for every tool call from the call's own headers, URL and `_meta`. Absent: calls carry no client.
   */
  readonly identity?: ConnectionIdentity;
}

/** The additive server-level instructions (spec 02 §1.1). */
export function serverInstructions(runtime: RuntimeFacts): string {
  const floorSeconds = Math.floor(runtime.minAttentionWaitMs / 1000);
  const lines = [
    'BrowserHive runs isolated, observable browser sessions for agents.',
    'Call launch_session first and pass the returned session_id to every page tool; close_session when done.',
    'request_attention BLOCKS until a human operator resolves it (http transport only).',
  ];
  if (floorSeconds > 0) {
    lines.push(`The operator requires a minimum attention wait of ${floorSeconds}s.`);
  }
  return lines.join(' ');
}

function initializeSignalsOf(params: {
  readonly clientInfo?:
    | {
        readonly name?: string | undefined;
        readonly version?: string | undefined;
        readonly title?: string | undefined;
      }
    | undefined;
  readonly protocolVersion?: string | undefined;
  readonly capabilities?: Readonly<Record<string, unknown>> | undefined;
  readonly _meta?: Readonly<Record<string, unknown>> | undefined;
}): InitializeSignals {
  return {
    ...(params.clientInfo !== undefined && {
      clientInfo: {
        ...(params.clientInfo.name !== undefined && { name: params.clientInfo.name }),
        ...(params.clientInfo.version !== undefined && { version: params.clientInfo.version }),
        ...(params.clientInfo.title !== undefined && { title: params.clientInfo.title }),
      },
    }),
    ...(params.protocolVersion !== undefined && { protocolVersion: params.protocolVersion }),
    ...(params.capabilities !== undefined && { capabilities: params.capabilities }),
    ...(params._meta !== undefined && { meta: params._meta }),
  };
}

function progressTokenOf(
  meta: Readonly<Record<string, unknown>> | undefined,
): string | number | undefined {
  const token = meta?.['progressToken'];
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

/**
 * Builds one `McpServer` (capabilities `tools.listChanged` + `logging`). Tools are listed with their
 * contract schemas (`inputSchema` from the zod object, `outputSchema` for object outputs) and every
 * call goes through the dispatcher: argument validation is the dispatcher's (so it is observed and
 * shaped as `[INVALID_ARGUMENTS]`), never the SDK's. Unknown tool names stay JSON-RPC errors.
 *
 * The SDK binds a server to one transport, so the HTTP transport builds one per MCP session.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { runtime, dispatcher } = options;
  const server = new McpServer(
    { name: options.name ?? SERVER_NAME, version: runtime.version },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions: serverInstructions(runtime),
    },
  );
  const registry = dispatcher.registry;
  for (const definition of registry.definitions) {
    const input = registry.inputOf(definition.name);
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: registry.descriptionOf(definition.name),
        ...(input !== undefined && { inputSchema: input }),
        outputSchema: definition.output,
        annotations: { title: definition.title, ...definition.annotations },
      },
      // Never invoked: `tools/call` is replaced below so the dispatcher owns validation.
      async () => ({ content: [] }),
    );
  }
  const identity = options.identity;
  if (identity !== undefined) {
    // The SDK keeps `clientInfo` and capabilities but not the `initialize` `_meta` or the requested
    // protocol version, so the handler is wrapped (both transports) and then defers to the SDK's.
    const sdk = server.server as unknown as {
      _oninitialize(request: unknown): Promise<InitializeResult>;
    };
    server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      identity.initialize(initializeSignalsOf(request.params));
      return sdk._oninitialize(request);
    });
  }
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (!dispatcher.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    }
    const meta: Readonly<Record<string, unknown>> | undefined = request.params._meta;
    const progressToken = progressTokenOf(meta);
    // Identity is resolved per request (02 §1.4): this call's headers, URL and `_meta` over the
    // connection's, so a stateless MCP revision without `initialize` keeps working.
    const signals: RequestSignals = {
      ...(extra.requestInfo !== undefined && {
        headers: headerBag(extra.requestInfo.headers),
        ...(extra.requestInfo.url !== undefined && { url: extra.requestInfo.url }),
      }),
      ...(meta !== undefined && { meta }),
    };
    const resolved = identity?.resolve(signals);
    const call: DispatchCall = {
      principal: principalFromAuthInfo(extra.authInfo),
      connectionId: options.connectionIdOf?.(extra.sessionId) ?? null,
      client: resolved === undefined ? null : clientOfIdentity(resolved),
      ...(resolved !== undefined && { identity: resolved }),
      signal: extra.signal,
      ...(meta !== undefined && { meta }),
      ...(progressToken !== undefined && {
        sendProgress: (report) =>
          extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: report.progress,
              ...(report.total !== undefined && { total: report.total }),
              ...(report.message !== undefined && { message: report.message }),
            },
          }),
      }),
    };
    const shaped = await dispatcher.dispatch(name, request.params.arguments, call);
    const result: CallToolResult = { ...shaped };
    return result;
  });
  return server;
}
