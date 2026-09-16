/** @module interface/mcp/transports/stdio.test — stdio smoke: initialize → tools/list → tools/call over injected streams; only JSON-RPC reaches stdout. */

import { afterEach, describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createToolHarness, type ToolHarness } from '../../../../test/helpers/fake-transport.ts';
import { createMcpServer } from '../server.ts';
import { startStdio } from './stdio.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function lines(stream: PassThrough): () => Promise<unknown> {
  let buffer = '';
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const parsed: unknown = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(parsed);
      else queue.push(parsed);
      at = buffer.indexOf('\n');
    }
  });
  return () =>
    queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r));
}

describe('stdio transport', () => {
  it('serves initialize, tools/list and a tool call as the local principal', async () => {
    h = await createToolHarness({ transport: 'stdio' });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const next = lines(stdout);
    const server = createMcpServer({ runtime: h.services.runtime, dispatcher: h.dispatcher });
    const transport = await startStdio(server, { stdin, stdout });
    const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect(await next()).toMatchObject({ id: 1, result: { serverInfo: { name: 'browserhive' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = (await next()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools).toHaveLength(43);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_sessions', arguments: {} },
    });
    expect(await next()).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: '[]' }] },
    });
    expect(h.observations().at(-1)?.principal).toBe('local');
    await transport.close();
  });
});
