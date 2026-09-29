/** @module test/persistence/notification-actions-migration.test — schema v6 (`0006-notification-actions`) over a v5 database: three new, empty tables, the minimum reader unchanged, the outcome CHECK and the token cascades, and `purge` inventorying a v5 database (03 §7; D-41). */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMaintenanceService } from '../../src/infra/persistence/maintenance.ts';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

async function openCopy(fixture: string, readOnly = false) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock: new FakeClock(),
    logger: new FakeLogger(),
    ...(readOnly && { readOnly: true }),
  });
  return { dir, handle };
}

describe('migration 0006-notification-actions', () => {
  it('upgrades a v5 database with empty act-button tables and keeps the minimum reader', async () => {
    const { dir, handle } = await openCopy('v5.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      for (const table of [
        'notification_action_tokens',
        'notification_actions',
        'notification_cursors',
      ]) {
        const row = handle.raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
        expect(row?.n).toBe(0);
      }
      const reader = handle.raw
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_reader_version'")
        .get();
      expect(reader?.value).toBe('1');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('checks the outcome and drops tokens with their notification', async () => {
    const { dir, handle } = await openCopy('v6.db');
    try {
      expect(() =>
        handle.raw.run(
          "INSERT INTO notification_actions (at, channel_id, channel_name, channel_kind, action_id, op, actor, outcome) VALUES (1, 'c', 'n', 'telegram', 'a', 'attention.resolve', 'telegram:1', 'maybe')",
        ),
      ).toThrow();
      const before = handle.raw
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notification_action_tokens')
        .get();
      expect(before?.n).toBe(1);
      handle.raw.run("DELETE FROM notifications WHERE notification_id = 'n-fixture00002'");
      const after = handle.raw
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notification_action_tokens')
        .get();
      expect(after?.n).toBe(0);
      const audit = handle.raw
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notification_actions')
        .get();
      expect(audit?.n).toBe(1);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('purge inventories a v5 database without failing on the new tables', async () => {
    const { dir, handle } = await openCopy('v5.db', true);
    try {
      const maintenance = new SqliteMaintenanceService({
        handle,
        clock: new FakeClock(),
        logger: new FakeLogger(),
        appVersion: 'test',
      });
      const tables = (await maintenance.inventory()).tables.map((t) => t.table);
      expect(tables).toContain('notification_channels');
      expect(tables).not.toContain('notification_actions');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
