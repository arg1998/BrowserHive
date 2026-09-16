/** @module app/maintenance/startup-reconcile.test — boot recovery steps, isolation, stale browser degradation; backup listing. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import type { Degradation } from '../../ports/degradation-reporter.ts';
import { BackupScheduler } from './backup-scheduler.ts';
import { reconcileOnStartup } from './startup-reconcile.ts';
import { MemoryFileSystem } from './test-support.ts';

describe('reconcileOnStartup', () => {
  it('closes open sessions as interrupted, recovers orphans, closes connections, reports stale browsers', async () => {
    const clock = new FakeClock(42);
    const calls: string[] = [];
    const reported: Degradation[] = [];
    const result = await reconcileOnStartup({
      sessions: {
        reconcileOpen: async (at, reason) => {
          calls.push(`sessions ${at} ${reason}`);
          return 2;
        },
      },
      operatorRequests: {
        recoverOrphans: async (now) => {
          calls.push(`orphans ${now}`);
          return 1;
        },
      },
      mcpConnections: { closeAll: async () => 3 },
      findStaleBrowserProcesses: async () => [111, 222],
      degradations: { report: (d) => void reported.push(d), recovered: () => undefined },
      clock,
      logger: new CollectingLogger(),
    });
    expect(calls).toEqual(['sessions 42 interrupted', 'orphans 42']);
    expect(result).toEqual({
      sessionsClosed: 2,
      requestsRejected: 1,
      connectionsClosed: 3,
      stalePids: [111, 222],
    });
    expect(reported).toEqual([
      expect.objectContaining({ code: 'STALE_BROWSER_PROCESSES', details: { count: 2 } }),
    ]);
  });

  it('a failing step is isolated and reported as null; no stale browsers resolves the code', async () => {
    const recovered: string[] = [];
    const logger = new CollectingLogger();
    const result = await reconcileOnStartup({
      sessions: {
        reconcileOpen: async () => {
          throw new Error('locked');
        },
      },
      findStaleBrowserProcesses: async () => [],
      degradations: { report: () => undefined, recovered: (c) => void recovered.push(c) },
      clock: new FakeClock(),
      logger,
    });
    expect(result).toEqual({
      sessionsClosed: null,
      requestsRejected: 0,
      connectionsClosed: 0,
      stalePids: [],
    });
    expect(recovered).toEqual(['STALE_BROWSER_PROCESSES']);
    expect(logger.records.some((r) => r.msg === 'reconcile step failed')).toBe(true);
  });
});

describe('BackupScheduler', () => {
  it('lists backups newest first and tracks the last backup', async () => {
    const fs = new MemoryFileSystem();
    fs.addFile('/b/browserhive-v1-20260101T000000Z.db', 'aa', 100);
    fs.addFile('/b/browserhive-v2-20260102T000000Z.db', 'bbbb', 200);
    fs.addFile('/b/notes.txt', 'x', 300);
    const clock = new FakeClock(500);
    const backups = new BackupScheduler({
      maintenance: { backup: async () => '/b/browserhive-v2-new.db' },
      fs,
      backupsDir: '/b',
      clock,
      logger: new CollectingLogger(),
    });
    const list = await backups.listBackups();
    expect(list.map((b) => [b.schemaVersion, b.sizeBytes])).toEqual([
      [2, 4],
      [1, 2],
    ]);
    expect(await backups.refreshLastBackup()).toBe(200);
    const [a, b] = await Promise.all([backups.backupNow(), backups.backupNow()]);
    expect(a).toBe(b);
    expect(backups.lastBackupAt()).toBe(500);
  });

  it('reports integer epoch ms for backups whose filesystem mtime is fractional', async () => {
    const fs = new MemoryFileSystem();
    fs.addFile('/b/browserhive-v1-20260101T000000Z.db', 'aa', 1789584516340.4568);
    const backups = new BackupScheduler({
      maintenance: { backup: async () => '/b/x.db' },
      fs,
      backupsDir: '/b',
      clock: new FakeClock(1),
      logger: new CollectingLogger(),
    });
    expect(await backups.refreshLastBackup()).toBe(1789584516340);
    expect((await backups.listBackups())[0]?.createdAt).toBe(1789584516340);
  });
});
