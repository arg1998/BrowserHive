/** @module composition/phases/listeners-stdio — the stdio front door: one `McpServer` over the SDK stdio transport, principal `local`; the process stops when the client goes away (D-02). */

import type { Readable, Writable } from 'node:stream';
import { serializeError } from '@browserhive/core/runtime';
import {
  ConnectionIdentity,
  connectionPatchOf,
  createMcpServer,
  startStdio,
} from '@browserhive/core/server';
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
  // Identity (spec 02 §1.4): the environment the harness gave this process is the only stdio
  // channel besides `initialize` and `_meta` (BROWSERHIVE_HARNESS/MODEL/WORKSPACE, CLAUDECODE, …).
  let inserted: Promise<void> | undefined;
  const identity = new ConnectionIdentity({
    connectionId,
    logger,
    signals: { transport: 'stdio', env: ctx.input.env },
    persist: (patch) =>
      inserted?.then(() =>
        storage.uow.repos.mcpConnections.update(connectionId, {
          ...patch,
          lastSeenAt: ctx.clock.now(),
        }),
      ),
  });
  const resolved = identity.current;
  const columns = connectionPatchOf(resolved);
  inserted = storage.uow.repos.mcpConnections
    .insert({
      connectionId,
      principalId: 'local',
      transport: 'stdio',
      mcpSessionId: null,
      clientName: null,
      clientVersion: null,
      clientTitle: null,
      protocolVersion: null,
      capabilities: null,
      workspace: resolved.workspace,
      agentName: resolved.workspace,
      model: resolved.model,
      modelSource: resolved.modelSource,
      harness: resolved.harness,
      harnessSource: resolved.harnessSource,
      conflicts: columns.conflicts ?? [],
      meta: resolved.meta,
      ip: null,
      userAgent: null,
      connectedAt: now,
      lastSeenAt: now,
      closedAt: null,
    })
    .catch((err: unknown) => log.warn('connection row failed', { err: serializeError(err) }));
  log.debug('stdio client identity', {
    harness: resolved.harness,
    source: resolved.harnessSource,
  });

  // `initialize` (clientInfo, protocol version, capabilities, `_meta`) reaches the identity through
  // the server's initialize hook, which re-resolves and updates the row (spec 02 §1.4).
  const server = createMcpServer({
    runtime: domain.runtime,
    dispatcher: domain.dispatcher,
    connectionIdOf: () => connectionId,
    identity,
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
