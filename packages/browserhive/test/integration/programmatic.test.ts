/** @module test/integration/programmatic.test — `createServer` from `browserhive`: eager validation, listen → /health → stop twice, stop after a failed listen. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { ConfigError, createServer, VERSION } from '../../src/index.ts';
import { tempDir } from '../composition/support.ts';

const silent = { stdout: () => undefined, stderr: () => undefined };

describe('createServer', () => {
  let dir = tempDir('bh-programmatic-');
  afterEach(() => {
    dir.cleanup();
    dir = tempDir('bh-programmatic-');
  });
  afterAll(() => dir.cleanup());

  it('listen → /health ready → stop twice', async () => {
    const server = await createServer({
      port: 0,
      dataDir: dir.path,
      env: {},
      configFile: false,
      output: silent,
    });
    expect(server.url).toBeNull();
    expect(server.provenance.port.source).toBe('cli');
    expect(Object.isFrozen(server.config)).toBe(true);
    const listening = server.listen();
    expect(server.listen()).toBe(listening);
    await listening;
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', version: VERSION });
    await server.stop();
    await server.stop({ deadlineMs: 1_000 });
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it('validates eagerly with the CLI messages', async () => {
    const fail = async (options: Parameters<typeof createServer>[0]) => {
      try {
        await createServer({ env: {}, configFile: false, output: silent, ...options });
      } catch (err) {
        return err;
      }
      return null;
    };
    const invalid = await fail({ sessionLease: '2 hours', dataDir: dir.path });
    expect(invalid).toBeInstanceOf(ConfigError);
    if (invalid instanceof ConfigError) {
      expect(invalid.exitCode).toBe(64);
      expect(invalid.message).toContain('browserhive: invalid value');
    }
    const unknown = await fail({ dataDir: dir.path, ...{ maxSession: 2 } });
    expect(unknown).toBeInstanceOf(ConfigError);
    if (unknown instanceof ConfigError)
      expect(unknown.message).toContain("Did you mean 'maxSessions'?");
    const policy = await fail({ host: '0.0.0.0', dataDir: dir.path });
    expect(policy instanceof ConfigError && policy.exitCode).toBe(3);
  });

  it('stop() after a failed listen() unwinds and resolves', async () => {
    const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('busy') });
    const server = await createServer({
      port: holder.port,
      dataDir: dir.path,
      env: {},
      configFile: false,
      output: silent,
    });
    await expect(server.listen()).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    await server.stop();
    await server.stop();
    holder.stop(true);
    // The unwind released the data dir: a second server on the same dir boots.
    const next = await createServer({
      port: 0,
      dataDir: dir.path,
      env: {},
      configFile: false,
      output: silent,
    });
    await next.listen();
    await next.stop();
  });
});
