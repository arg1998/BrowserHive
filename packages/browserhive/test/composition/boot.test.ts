/** @module test/composition/boot.test — phase order, unwind on failure (storage closed, lock released), idempotent stop, `done` exit code, boot error mapping. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode } from '@browserhive/contracts/errors';
import { isAppError } from '@browserhive/core/runtime';
import {
  bootServer,
  LOCK_FILE_NAME,
  openStorageForCli,
  type PhaseDefinition,
} from '../../src/composition/index.ts';
import { bootInputFor, tempDir } from './support.ts';

const quiet = {
  child: () => quiet,
  isLevelEnabled: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function recording(events: string[]) {
  return (defaults: readonly PhaseDefinition[]): readonly PhaseDefinition[] =>
    defaults.map((phase) => ({
      ...phase,
      run: async (ctx) => {
        events.push(`run:${phase.name}`);
        const handle = await phase.run(ctx);
        return {
          stop: async (deadlineMs: number) => {
            events.push(`stop:${phase.name}`);
            await handle.stop(deadlineMs);
          },
        };
      },
    }));
}

async function expectBootError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('bootServer', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });
  afterAll(() => dir.cleanup());

  it('runs the phases in order and unwinds them in reverse; stop is idempotent', async () => {
    const events: string[] = [];
    const input = bootInputFor(dir.path);
    const server = await bootServer(input, { phases: recording(events) });
    expect(events).toEqual([
      'run:resolve-config',
      'run:observability',
      'run:open-storage',
      'run:build-domain',
      'run:wire-observers',
      'run:open-listeners',
      'run:ready',
    ]);
    expect(server.transport).toBe('http');
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(true);

    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    await first;
    await server.stop();
    expect(await server.done).toBe(0);
    expect(events.slice(7)).toEqual([
      'stop:ready',
      'stop:open-listeners',
      'stop:wire-observers',
      'stop:build-domain',
      'stop:open-storage',
      'stop:observability',
      'stop:resolve-config',
    ]);
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(false);
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it('a bind failure in open-listeners unwinds earlier phases: storage closed, lock released', async () => {
    const events: string[] = [];
    const input = bootInputFor(dir.path);
    const failingServe = () => {
      throw Object.assign(new Error('Failed to start server. Is port 9 in use?'), {
        code: 'EADDRINUSE',
      });
    };
    await expectBootError(
      bootServer(input, { phases: recording(events), serve: failingServe }),
      'PORT_IN_USE',
    );
    expect(events).toEqual([
      'run:resolve-config',
      'run:observability',
      'run:open-storage',
      'run:build-domain',
      'run:wire-observers',
      'run:open-listeners',
      'stop:wire-observers',
      'stop:build-domain',
      'stop:open-storage',
      'stop:observability',
      'stop:resolve-config',
    ]);
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(false);
    // The database was closed and the lock released: a writable CLI open succeeds.
    const storage = await openStorageForCli({
      dataDir: dir.path,
      readOnly: false,
      migrate: false,
      logger: quiet,
    });
    expect(storage.handle.schemaVersion).toBeGreaterThan(0);
    await storage.close();
  });

  it('maps other listen errors to BIND_FAILED', async () => {
    const input = bootInputFor(dir.path);
    const serve = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    await expectBootError(bootServer(input, { serve }), 'BIND_FAILED');
  });

  it('an unreadable blocklist fails build-domain with BLOCKLIST_LOAD_FAILED and releases the lock', async () => {
    const input = bootInputFor(dir.path, { blocklist: join(dir.path, 'missing.txt') });
    await expectBootError(bootServer(input), 'BLOCKLIST_LOAD_FAILED');
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(false);
  });

  it('refuses a data dir locked by a live process and replaces a stale lock', async () => {
    const lock = join(dir.path, LOCK_FILE_NAME);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 1, owner: 'serve' }));
    await expectBootError(bootServer(bootInputFor(dir.path)), 'DATA_DIR_LOCKED');
    expect(existsSync(lock)).toBe(true);

    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12_345, startedAt: 1, owner: 'serve' }));
    const server = await bootServer(bootInputFor(dir.path));
    await server.stop();
    expect(existsSync(lock)).toBe(false);
  });

  it('prints the banner through output once ready, with the seed secrets on first start', async () => {
    const input = bootInputFor(dir.path, { admin: true, auth: 'token' });
    const server = await bootServer(input);
    const banner = input.output.out.join('\n');
    expect(banner).toContain(`MCP        ${server.url}/mcp`);
    expect(banner).toContain(`Dashboard  ${server.url}/`);
    expect(banner).toMatch(/admin: {2}first-run password: \S{24}/);
    expect(banner).toMatch(/bearer token for principal agent-1: bh_agent_/);
    expect(banner).toContain('Press Ctrl-C to stop.');
    await server.stop();

    const again = bootInputFor(dir.path, { admin: true, auth: 'token' });
    const second = await bootServer(again);
    expect(again.output.out.join('\n')).not.toContain('first-run password');
    expect(again.output.out.join('\n')).not.toContain('bearer token for principal');
    await second.stop();
  });
});
