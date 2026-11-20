/** @module test/persistence/template-refusals-migration.test — schema v13 (`0013-template-refusals`) over a v12 database: one new table, empty after the upgrade; the minimum reader stays 10 (compatible) and a v12 binary still opens the database; the CHECKs refuse an unknown kind or reason and a zero count; the v13 fixture's row reads back (deferred D60). */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { DISK_MIGRATION_TEST_MS, FakeClock, FakeLogger, TEMPLATE_ID, tempDir } from './helpers.ts';

// Each case opens a database on disk: fsync stalls on CI runners (D30 l, helpers.ts).
setDefaultTimeout(DISK_MIGRATION_TEST_MS);

const FIXTURES = join(import.meta.dir, 'fixtures');

async function openCopy(fixture: string) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock: new FakeClock(),
    logger: new FakeLogger(),
  });
  return { dir, path, handle, uow: new SqliteUnitOfWork(handle.db) };
}

const INSERT = `INSERT INTO template_refusals
  (template_id, principal_id, harness, kind, reason, count, first_at, last_at)
  VALUES (?, 'p', 'cursor', ?, ?, ?, 1, 1)`;

describe('migration 0013-template-refusals', () => {
  it('upgrades a v12 database: an empty table, reader unchanged', async () => {
    const { dir, handle, uow } = await openCopy('v12.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      expect(await uow.repos.templateRefusals.list(TEMPLATE_ID)).toEqual([]);
      expect(MIGRATIONS.find((m) => m.version === 13)?.compatible).toBe(true);
      expect(handle.minReaderVersion).toBe(10);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('a v12 binary still opens the upgraded database', async () => {
    const { dir, path, handle } = await openCopy('v12.db');
    await handle.close();
    try {
      const older = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'v12-binary',
        clock: new FakeClock(),
        logger: new FakeLogger(),
        migrations: MIGRATIONS.filter((m) => m.version <= 12),
      });
      const uow = new SqliteUnitOfWork(older.db);
      expect((await uow.repos.templates.get(TEMPLATE_ID))?.templateId).toBe(TEMPLATE_ID);
      await older.close();
    } finally {
      dir.dispose();
    }
  });

  it('refuses an unknown kind or reason and a zero count', async () => {
    const { dir, handle } = await openCopy('v12.db');
    try {
      expect(() =>
        handle.raw.run(INSERT, [TEMPLATE_ID, 'peek', 'principal_not_allowed', 1]),
      ).toThrow(/CHECK/);
      expect(() => handle.raw.run(INSERT, [TEMPLATE_ID, 'list', 'recording', 1])).toThrow(/CHECK/);
      expect(() =>
        handle.raw.run(INSERT, [TEMPLATE_ID, 'list', 'principal_not_allowed', 0]),
      ).toThrow(/CHECK/);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it("reads the v13 fixture's refused agent", async () => {
    const { dir, handle, uow } = await openCopy('v13.db');
    try {
      expect(await uow.repos.templateRefusals.list(TEMPLATE_ID)).toEqual([
        {
          templateId: TEMPLATE_ID,
          principal: 'p-refused',
          harness: 'other',
          harnessDeclared: 'Nightly Scraper',
          kind: 'launch',
          reason: 'harness_not_allowed',
          count: 3,
          firstAt: 1_700_000_000_000,
          lastAt: 1_700_000_001_000,
        },
      ]);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
