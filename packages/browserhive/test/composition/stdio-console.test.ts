/** @module test/composition/stdio-console.test — under `transport=stdio` every `console.*` call goes to the logger on stderr and stdout stays silent; the guard is removed on stop. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { bootServer } from '../../src/composition/index.ts';
import { bootInputFor, globalConsole, tempDir } from './support.ts';

describe('stdio console redirect', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });
  afterAll(() => dir.cleanup());

  it('routes console output to stderr while serving and restores console afterwards', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const base = bootInputFor(dir.path, { transport: 'stdio', logLevel: 'debug' });
    const original = globalConsole.log;
    const server = await bootServer({ ...base, stdio: { stdin, stdout } });
    expect(server.url).toBeNull();
    expect(globalConsole.log).not.toBe(original);
    globalConsole.log('stray library output');
    globalConsole.error('stray error');
    expect(written.join('')).toBe('');
    expect(base.output.out).toEqual([]);
    const err = base.output.err.join('\n');
    expect(err).toContain('stray library output');
    expect(err).toContain('stray error');
    // The stdio banner is two lines on stderr.
    expect(base.output.err.some((line) => line.includes('BrowserHive 0.0.0-test'))).toBe(true);
    await server.stop();
    expect(globalConsole.log).toBe(original);
    expect(await server.done).toBe(0);
  });

  it('stops with exit code 0 when the stdio client goes away', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const base = bootInputFor(dir.path, { transport: 'stdio' });
    const server = await bootServer({ ...base, stdio: { stdin, stdout } });
    stdin.end();
    expect(await server.done).toBe(0);
  });
});
