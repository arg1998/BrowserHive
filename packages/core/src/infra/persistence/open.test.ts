/** @module infra/persistence/open.test — PRAGMAs, application_id, integrity and compat window on open (spec 09 §3.2). */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { FakeClock, FakeLogger, tempDir } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_VERSION } from './migrations/index.ts';
import { openDatabase, REQUIRED_PRAGMAS } from './open.ts';
import { pragmaNumber, pragmaString } from './pragma.ts';

const clock = new FakeClock();

async function open(path: string, dataDir: string, extra: { readOnly?: boolean } = {}) {
  return openDatabase({
    path,
    dataDir,
    appVersion: '0.1.0-test',
    clock,
    logger: new FakeLogger(),
    ...extra,
  });
}

describe('openDatabase', () => {
  it('asserts every required PRAGMA on a file-backed database', async () => {
    const dir = tempDir();
    try {
      const handle = await open(join(dir.path, 'browserhive.db'), dir.path);
      expect(pragmaString(handle.raw, 'journal_mode')).toBe(REQUIRED_PRAGMAS.journal_mode);
      expect(pragmaNumber(handle.raw, 'foreign_keys')).toBe(REQUIRED_PRAGMAS.foreign_keys);
      expect(pragmaNumber(handle.raw, 'busy_timeout')).toBe(REQUIRED_PRAGMAS.busy_timeout);
      expect(pragmaNumber(handle.raw, 'synchronous')).toBe(REQUIRED_PRAGMAS.synchronous);
      expect(pragmaNumber(handle.raw, 'auto_vacuum')).toBe(REQUIRED_PRAGMAS.auto_vacuum);
      expect(pragmaNumber(handle.raw, 'application_id')).toBe(APPLICATION_ID);
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      expect(handle.minReaderVersion).toBe(1);
      expect(handle.migrationsApplied.map((m) => m.version)).toEqual(
        MIGRATIONS.map((m) => m.version),
      );
      await handle.close();
    } finally {
      dir.dispose();
    }
  });

  it('supports :memory: with the same schema', async () => {
    const handle = await open(':memory:', '/nonexistent');
    expect(pragmaNumber(handle.raw, 'application_id')).toBe(APPLICATION_ID);
    expect(pragmaNumber(handle.raw, 'foreign_keys')).toBe(1);
    expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
    const rows = await handle.db.selectFrom('schema_migrations').selectAll().execute();
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    await handle.close();
  });

  it('refuses a foreign database (application_id mismatch) with DB_OPEN_FAILED', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'other.db');
      const foreign = new Database(path, { create: true });
      foreign.exec('PRAGMA application_id=1234; CREATE TABLE t (x INTEGER);');
      foreign.close();
      let error: unknown;
      try {
        await open(path, dir.path);
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'DB_OPEN_FAILED')).toBe(true);
    } finally {
      dir.dispose();
    }
  });

  it('quarantines a corrupt file with DB_CORRUPT', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const first = await open(path, dir.path);
      await first.close();
      // Overwrite ten whole pages after page 1: the header survives, the schema b-tree does not.
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      bytes.fill(0xff, 4096 * 2, Math.min(bytes.length, 4096 * 12));
      await Bun.write(path, bytes);
      let error: unknown;
      try {
        await open(path, dir.path);
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'DB_CORRUPT')).toBe(true);
    } finally {
      dir.dispose();
    }
  });

  it('opens read-only without migrating and never writes', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const writer = await open(path, dir.path);
      await writer.close();
      const reader = await open(path, dir.path, { readOnly: true });
      expect(reader.migrationsApplied).toEqual([]);
      expect(reader.schemaVersion).toBe(SCHEMA_VERSION);
      expect(pragmaNumber(reader.raw, 'query_only')).toBe(1);
      await reader.close();
    } finally {
      dir.dispose();
    }
  });

  it('closes idempotently and checkpoints the WAL', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      const handle = await open(path, dir.path);
      await handle.close();
      await handle.close();
      expect(await Bun.file(`${path}-wal`).exists()).toBe(false);
    } finally {
      dir.dispose();
    }
  });
});
