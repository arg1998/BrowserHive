/** @module composition/phases/listeners-stdio — the stdio front door: one `McpServer` over the SDK stdio transport, principal `local`; the process stops when the client goes away (D-02). */

import type { Readable, Writable } from 'node:stream';
import { serializeError } from '@browserhive/core/runtime';
import { createMcpServer, startStdio } from '@browserhive/core/server';
import { type BootContext, part } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';

/** Opens the stdio transport. Only JSON-RPC frames are ever written to `stdout`. */
export async function openStdioListener(ctx: BootContext): Promise<PhaseHandle> {
  const { logger } = part(ctx.observability, 'observability');
  const domain = part(ctx.domain, 'domain');
  const storage = part(ctx.storage, 'storage');
  const log = logger.child({ module: 'mcp.stdio' });
  const stdin: Readable = ctx.input.stdio?.stdin ?? process.stdin;
  const stdout: Writable = ctx.input.stdio?.stdout ?? process.stdout;
  const connectionId = `c-${domain.ids.opaque(10)}`;
  const now = ctx.clock.now();
  await storage.uow.repos.mcpConnections
    .insert({
      connectionId,
      principalId: 'local',
      transport: 'stdio',
      mcpSessionId: null,
      clientName: null,
      clientVersion: null,
      protocolVersion: null,
      capabilities: null,
      agentName: null,
      model: null,
      harness: null,
      ip: null,
      userAgent: null,
      connectedAt: now,
      lastSeenAt: now,
      closedAt: null,
    })
    .catch((err: unknown) => log.warn('connection row failed', { err: serializeError(err) }));

  const server = createMcpServer({
    runtime: domain.runtime,
    dispatcher: domain.dispatcher,
    connectionIdOf: () => connectionId,
  });
  let closing = false;
  const clientGone = (): void => {
    if (closing) return;
    closing = true;
    log.info('stdio client closed');
    ctx.requestStop(0);
  };
  const transport = await startStdio(server, { stdin, stdout });
  const previous = transport.onclose;
  transport.onclose = () => {
    previous?.();
    clientGone();
  };
  stdin.once('end', clientGone);
  stdin.once('close', clientGone);
  ctx.health.check('listeners', 'ok');
  ctx.listeners = { url: null, port: null, mcpConnections: () => (closing ? 0 : 1) };

  return {
    async stop() {
      closing = true;
      stdin.off('end', clientGone);
      stdin.off('close', clientGone);
      await server.close().catch(() => undefined);
      await storage.uow.repos.mcpConnections
        .update(connectionId, { closedAt: ctx.clock.now() })
        .catch(() => undefined);
    },
  };
}
