/** @module test/persistence/backups.test — backup selection and pruning across schema versions (D-04, spec 13 §9.9): pruning never deletes the pre-upgrade backup of an incompatible migration, and the "binary too old" refusal names the backup that binary can restore, not a later backup of the newer schema. */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMaintenanceService } from '../../src/infra/persistence/maintenance.ts';
import {
  pruneBackups,
  readableBackup,
  readerFloors,
} from '../../src/infra/persistence/migrations/backups.ts';
import { MIGRATIONS } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** Writes `browserhive-v<version>-<stamp>.db` with an mtime of `at` seconds. */
function backupFile(dir: string, version: number, at: number): string {
  const path = join(dir, `browserhive-v${version}-2026010${at}T000000000Z.db`);
  writeFileSync(path, 'x');
  utimesSync(path, at, at);
  return path;
}

describe('backups across schema versions', () => {
  it('names the highest readable version, newest within it', () => {
    const dir = tempDir();
    try {
      const v8 = backupFile(dir.path, 8, 1);
      backupFile(dir.path, 9, 2);
      const v9 = backupFile(dir.path, 9, 3);
      backupFile(dir.path, 10, 4);
      expect(readableBackup(dir.path, 10)).toContain('browserhive-v10-');
      expect(readableBackup(dir.path, 9)).toBe(v9);
      expect(readableBackup(dir.path, 8)).toBe(v8);
      expect(readableBackup(dir.path, 7)).toBeNull();
    } finally {
      dir.dispose();
    }
  });

  it('never prunes the newest backup below each reader floor, and removes sidecars', () => {
    const dir = tempDir();
    try {
      const v8 = backupFile(dir.path, 8, 1);
      const v9 = backupFile(dir.path, 9, 2);
      const v10 = [3, 4, 5, 6, 7, 8].map((at) => backupFile(dir.path, 10, at));
      writeFileSync(`${v10[0]}-wal`, 'wal');
      expect(readerFloors()).toContain(10);
      const removed = pruneBackups(dir.path, 5, [10]);
      expect(removed.sort()).toEqual([v8, v10[0] ?? ''].sort());
      expect(existsSync(v9)).toBe(true);
      expect(existsSync(`${v10[0]}-wal`)).toBe(false);
      // Without a floor the same call would have taken the v9 file too.
      const plain = tempDir();
      try {
        const p9 = backupFile(plain.path, 9, 2);
        for (const at of [3, 4, 5, 6, 7]) backupFile(plain.path, 10, at);
        expect(pruneBackups(plain.path, 5, [])).toEqual([p9]);
      } finally {
        plain.dispose();
      }
    } finally {
      dir.dispose();
    }
  });

  it('after an upgrade and many manual backups, a v9 binary is told to restore the v9 backup', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      copyFileSync(join(FIXTURES, 'v9.db'), path);
      const clock = new FakeClock();
      const logger = new FakeLogger();
      const handle = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'test',
        clock,
        logger,
      });
      const preUpgrade = handle.backupPath;
      expect(preUpgrade).toContain('browserhive-v9-');
      const maintenance = new SqliteMaintenanceService({
        handle,
        clock,
        logger,
        appVersion: 'test',
      });
      for (let i = 0; i < 7; i++) {
        clock.advance(60_000);
        await maintenance.backup();
      }
      await handle.close();
      expect(existsSync(preUpgrade ?? '')).toBe(true);

      let error: unknown;
      try {
        const older = await openDatabase({
          path,
          dataDir: dir.path,
          appVersion: 'v9-binary',
          clock,
          logger,
          migrations: MIGRATIONS.filter((m) => m.version <= 9),
        });
        await older.close();
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'DB_NEWER_THAN_BINARY')).toBe(true);
      if (isAppError(error, 'DB_NEWER_THAN_BINARY')) {
        expect(error.details['backup_path']).toBe(preUpgrade ?? '');
        expect(error.message).toContain(`browserhive db restore ${preUpgrade ?? ''}`);
      }
    } finally {
      dir.dispose();
    }
  });
});
