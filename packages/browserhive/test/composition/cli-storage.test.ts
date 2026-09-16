/** @module test/composition/cli-storage.test — `openStorageForCli`: writable opens hold the lock and refuse while a server runs; read-only opens coexist and report the live lock; auth operations work. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isAppError } from '@browserhive/core/runtime';
import { bootServer, LOCK_FILE_NAME, openStorageForCli } from '../../src/composition/index.ts';
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

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return isAppError(err) ? err.code : 'non-app-error';
  }
}

describe('openStorageForCli', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });
  afterAll(() => dir.cleanup());

  it('creates and migrates the database, holds the lock until close, issues tokens', async () => {
    const storage = await openStorageForCli({
      dataDir: dir.path,
      readOnly: false,
      migrate: true,
      logger: quiet,
      command: 'admin tokens create',
    });
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(true);
    expect(
      await codeOf(
        openStorageForCli({ dataDir: dir.path, readOnly: false, migrate: true, logger: quiet }),
      ),
    ).toBe('DATA_DIR_LOCKED');
    const issued = await storage.auth.createToken(
      {
        subject: 'local',
        kind: 'operator',
        display: 'cli',
        auth: { method: 'local' },
        scopes: [],
        tenantId: null,
        mustChangePassword: false,
      },
      { ownerKind: 'agent', display: 'ci runner' },
    );
    expect(issued.token.reveal()).toMatch(/^bh_agent_/);
    expect((await storage.auth.listTokens()).length).toBe(1);
    await storage.close();
    await storage.close();
    expect(existsSync(join(dir.path, LOCK_FILE_NAME))).toBe(false);
  });

  it('refuses writable opens while a server runs; read-only opens report the server lock', async () => {
    const server = await bootServer(bootInputFor(dir.path));
    expect(
      await codeOf(
        openStorageForCli({ dataDir: dir.path, readOnly: false, migrate: false, logger: quiet }),
      ),
    ).toBe('DATA_DIR_LOCKED');
    const reader = await openStorageForCli({
      dataDir: dir.path,
      readOnly: true,
      migrate: false,
      logger: quiet,
    });
    expect(reader.serverLock?.pid).toBe(process.pid);
    expect(reader.serverLock?.owner).toBe('serve');
    expect((await reader.maintenance.inventory()).tables.length).toBeGreaterThan(0);
    await reader.close();
    await server.stop();
  });

  it('a read-only open of a missing database fails with DB_OPEN_FAILED', async () => {
    expect(
      await codeOf(
        openStorageForCli({
          dataDir: join(dir.path, 'nope'),
          readOnly: true,
          migrate: false,
          logger: quiet,
        }),
      ),
    ).toBe('DB_OPEN_FAILED');
  });
});
