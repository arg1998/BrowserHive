/** @module interface/mcp/transports/stdio — wires an MCP server to stdin/stdout. Console → stderr redirection is the composition root's job. */

import type { Readable, Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export { LOCAL_PRINCIPAL } from '../../../domain/auth/principal.ts';

/**
 * Connects `server` to a stdio transport (process stdin/stdout unless streams are injected) and
 * returns it. Every call is dispatched as the `local` principal (no `authInfo` under stdio).
 */
export async function startStdio(
  server: McpServer,
  io: { readonly stdin?: Readable; readonly stdout?: Writable } = {},
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport(io.stdin, io.stdout);
  await server.connect(transport);
  return transport;
}
