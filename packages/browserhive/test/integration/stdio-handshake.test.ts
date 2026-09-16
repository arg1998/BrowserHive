/** @module test/integration/stdio-handshake.test — under `transport=stdio` stdout carries only JSON-RPC frames even when something calls `globalConsole.log`; logs and banner go to stderr (spec 09 §3.4). */

import { afterAll, describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import { bootServer } from '../../src/composition/index.ts';
import { bootInputFor, globalConsole, tempDir } from '../composition/support.ts';

const dir = tempDir('bh-stdio-');
afterAll(() => dir.cleanup());

describe('stdio handshake', () => {
  it('initialize + tools/list over piped streams; stdout holds only JSON-RPC frames', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buffered = '';
    const frames: unknown[] = [];
    const waiters: (() => void)[] = [];
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        frames.push(JSON.parse(line));
        for (const wake of waiters.splice(0)) wake();
        newline = buffered.indexOf('\n');
      }
    });
    const nextFrame = async (count: number) => {
      while (frames.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
      return frames[count - 1];
    };
    const input = bootInputFor(dir.path, { transport: 'stdio', logLevel: 'debug' });
    const server = await bootServer({ ...input, stdio: { stdin, stdout } });
    // A hook that writes to the console must never corrupt the protocol stream.
    globalConsole.log('noise from a dependency');
    const send = (message: object) => stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    expect(await nextFrame(1)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'browserhive' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    globalConsole.log('more noise');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await nextFrame(2);
    const names =
      typeof list === 'object' && list !== null && 'result' in list
        ? (list as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
        : [];
    expect(names).toEqual([...ALL_TOOL_NAMES]);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'request_attention', arguments: { session_id: 'x-00000000', reason: 'r' } },
    });
    const attention = await nextFrame(3);
    expect(JSON.stringify(attention)).toContain('ATTENTION_REQUIRES_HTTP');

    for (const frame of frames) expect(frame).toMatchObject({ jsonrpc: '2.0' });
    expect(buffered).toBe('');
    const stderr = input.output.err.join('\n');
    expect(stderr).toContain('noise from a dependency');
    expect(stderr).toContain('more noise');
    expect(input.output.out).toEqual([]);

    stdin.end();
    expect(await server.done).toBe(0);
  });
});
