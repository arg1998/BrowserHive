/** @module infra/persistence/migrations/runner.test — D-04 runner: head, idempotence, backups, rollback, compat window. */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeClock, FakeLogger, tempDir } from '../../../../test/persistence/helpers.ts';
import { isAppError } from '../../../kernel/errors/app-error.ts';
import { openDatabase } from '../open.ts';
import { pragmaNumber } from '../pragma.ts';
import { initial } from './0001-initial.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './index.ts';
import type { Migration } from './migration.ts';
import { readMinReaderVersion, runMigrations } from './runner.ts';

const clock = new FakeClock();
const logger = new FakeLogger();

const v2: Migration = {
  version: 2,
  name: 'add-widgets',
  compatible: true,
  sql: 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nCREATE INDEX idx_widgets_name ON widgets(name);',
};
const v3: Migration = {
  version: 3,
  name: 'resize-widgets',
  compatible: false,
  sql: 'ALTER TABLE widgets ADD COLUMN size INTEGER;',
};
const broken: Migration = {
  version: 2,
  name: 'broken',
  compatible: true,
  sql: 'CREATE TABLE half (id INTEGER PRIMARY KEY);\nINSERT INTO nope (x) VALUES (1);',
};

function run(
  raw: Database,
  migrations: readonly Migration[],
  path = ':memory:',
  backupsDir: string | null = null,
) {
  return runMigrations({
    raw,
    path,
    migrations,
    appVersion: '0.1.0-test',
    clock,
    logger,
    backupsDir,
  });
}

describe('runMigrations', () => {
  it('migrates a fresh database to SCHEMA_VERSION with audit rows', () => {
    const raw = new Database(':memory:');
    const result = run(raw, [initial]);
    expect(result).toMatchObject({ from: 0, to: initial.version, backupPath: null });
    expect(pragmaNumber(raw, 'user_version')).toBe(initial.version);
    expect(readMinReaderVersion(raw)).toBe(1);
    const rows = raw
      .query('SELECT version, name, app_version, duration_ms FROM schema_migrations')
      .all();
    expect(rows).toEqual([
      { version: 1, name: 'initial', app_version: '0.1.0-test', duration_ms: 0 },
    ]);
    raw.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const raw = new Database(':memory:');
    run(raw, [initial]);
    const again = run(raw, [initial]);
    expect(again.applied).toEqual([]);
    expect(again.from).toBe(initial.version);
    raw.close();
  });

  it('executes every statement of a multi-statement migration via exec', () => {
    const raw = new Database(':memory:');
    run(raw, [initial, v2]);
    const objects = raw
      .query(
        "SELECT name FROM sqlite_master WHERE name IN ('widgets', 'idx_widgets_name') ORDER BY name",
      )
      .all();
    expect(objects).toEqual([{ name: 'idx_widgets_name' }, { name: 'widgets' }]);
    expect(pragmaNumber(raw, 'user_version')).toBe(2);
    // v2 is compatible: the reader floor stays at 1.
    expect(readMinReaderVersion(raw)).toBe(1);
    run(raw, [initial, v2, v3]);
    expect(readMinReaderVersion(raw)).toBe(3);
    raw.close();
  });

  it('creates a backup before an upgrade and prunes to the last five', () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const backups = join(dir.path, 'backups');
      const raw = new Database(path, { create: true });
      expect(run(raw, [initial], path, backups).backupPath).toBeNull();
      const chain = [initial, v2, v3];
      let migrations: Migration[] = [initial];
      const stamps: string[] = [];
      for (let i = 0; i < 7; i++) {
        const next: Migration = {
          version: 2 + i,
          name: `step-${i}`,
          compatible: true,
          sql: `CREATE TABLE t_${i} (id INTEGER PRIMARY KEY);`,
        };
        migrations = [...migrations, next];
        clock.advance(1_000);
        const result = run(raw, migrations, path, backups);
        expect(result.backupPath).not.toBeNull();
        expect(result.backupPath?.startsWith(join(backups, `browserhive-v${1 + i}-`))).toBe(true);
        if (result.backupPath !== null) stamps.push(result.backupPath);
      }
      void chain;
      const files = readdirSync(backups)
        .filter((f) => f.endsWith('.db'))
        .sort();
      expect(files.length).toBe(5);
      // The backup taken before the first DDL of an upgrade is a valid BrowserHive database.
      const backup = new Database(stamps[stamps.length - 1] ?? '', { readonly: true });
      expect(backup.query('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 7 });
      backup.close();
      raw.close();
    } finally {
      dir.dispose();
    }
  });

  it('rolls back a failing migration and throws MIGRATION_FAILED', () => {
    const raw = new Database(':memory:');
    run(raw, [initial]);
    let error: unknown;
    try {
      run(raw, [initial, broken]);
    } catch (e) {
      error = e;
    }
    expect(isAppError(error, 'MIGRATION_FAILED')).toBe(true);
    if (isAppError(error, 'MIGRATION_FAILED'))
      expect(error.details).toMatchObject({ from: 1, to: 2, name: 'broken' });
    expect(pragmaNumber(raw, 'user_version')).toBe(1);
    expect(raw.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get()).toEqual({
      n: 0,
    });
    expect(raw.query('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    expect(pragmaNumber(raw, 'foreign_keys')).toBe(1);
    raw.close();
  });
});

describe('compatibility window (openDatabase)', () => {
  async function seedNewer(path: string, dataDir: string, minReader: number): Promise<void> {
    const handle = await openDatabase({ path, dataDir, appVersion: 'x', clock, logger });
    handle.raw.exec('PRAGMA user_version = 99');
    handle.raw
      .query("UPDATE meta SET value = ? WHERE key = 'min_reader_version'")
      .run(String(minReader));
    await handle.close();
  }

  it('opens a newer database whose reader floor we satisfy', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      await seedNewer(path, dir.path, SCHEMA_VERSION);
      const handle = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'x',
        clock,
        logger,
      });
      expect(handle.schemaVersion).toBe(99);
      expect(handle.migrationsApplied).toEqual([]);
      expect(logger.records.some((r) => r.msg === 'db newer than binary')).toBe(true);
      await handle.close();
    } finally {
      dir.dispose();
    }
  });

  it('refuses a newer database outside the window with DB_NEWER_THAN_BINARY naming the backup', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const backups = join(dir.path, 'backups');
      await seedNewer(path, dir.path, SCHEMA_VERSION + 1);
      await Bun.write(join(backups, 'browserhive-v1-20260101T000000000Z.db'), 'x');
      let error: unknown;
      try {
        await openDatabase({ path, dataDir: dir.path, appVersion: 'x', clock, logger });
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'DB_NEWER_THAN_BINARY')).toBe(true);
      if (isAppError(error, 'DB_NEWER_THAN_BINARY')) {
        expect(error.details).toEqual({
          db_version: 99,
          min_reader_version: SCHEMA_VERSION + 1,
          binary_version: SCHEMA_VERSION,
          backup_path: join(backups, 'browserhive-v1-20260101T000000000Z.db'),
        });
        expect(error.message).toContain('browserhive db restore');
      }
    } finally {
      dir.dispose();
    }
  });

  it('lets a second read-only opener inventory the file without deadlocking', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const writer = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'x',
        clock,
        logger,
      });
      const reader = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'x',
        clock,
        logger,
        readOnly: true,
      });
      const rows = await reader.db.selectFrom('schema_migrations').select('version').execute();
      expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version })));
      await reader.close();
      await writer.close();
    } finally {
      dir.dispose();
    }
  });
});
