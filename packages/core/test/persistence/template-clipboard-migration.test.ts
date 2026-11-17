/** @module test/persistence/template-clipboard-migration.test — schema v11 (`0011-template-clipboard`) over a v10 database: one column, every existing template keeps clipboard writes allowed (`0`), the minimum reader stays 10 (compatible), the CHECK refuses anything but 0 and 1, and the repository round-trips the switch (spec 13 §2.1, D18). */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { FakeClock, FakeLogger, TEMPLATE_ID, tempDir, templateRecord } from './helpers.ts';

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
  return { dir, handle, uow: new SqliteUnitOfWork(handle.db) };
}

describe('migration 0011-template-clipboard', () => {
  it('upgrades a v10 database: existing templates allow clipboard writes, reader unchanged', async () => {
    const { dir, handle, uow } = await openCopy('v10.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      const rows = handle.raw
        .query<{ deny_clipboard_writes: number }, []>('SELECT deny_clipboard_writes FROM templates')
        .all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.deny_clipboard_writes === 0)).toBe(true);
      expect((await uow.repos.templates.get(TEMPLATE_ID))?.denyClipboardWrites).toBe(false);

      expect(MIGRATIONS.find((m) => m.version === 11)?.compatible).toBe(true);
      expect(handle.minReaderVersion).toBe(10);
      const reader = handle.raw
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_reader_version'")
        .get();
      expect(reader?.value).toBe('10');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('a v10 binary still opens the upgraded database and reads its templates', async () => {
    const { dir, handle } = await openCopy('v10.db');
    const path = join(dir.path, 'browserhive.db');
    await handle.close();
    try {
      const older = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'v10-binary',
        clock: new FakeClock(),
        logger: new FakeLogger(),
        migrations: MIGRATIONS.filter((m) => m.version <= 10),
      });
      try {
        // The opener accepts it (min_reader_version 10); an insert that does not name the column,
        // as v10's repository writes it, gets the default.
        const uow = new SqliteUnitOfWork(older.db);
        expect((await uow.repos.templates.get(TEMPLATE_ID))?.templateId).toBe(TEMPLATE_ID);
        older.raw.run(
          `INSERT INTO templates (template_id, name, display_name, status, owner, channel, stealth,
             fingerprint, humanize, identity_json, health_interval_ms, created_at, updated_at)
           SELECT 'tp-older00001', 'older', 'older', status, owner, channel, stealth, fingerprint,
             humanize, identity_json, health_interval_ms, created_at, updated_at
           FROM templates WHERE template_id = ?`,
          [TEMPLATE_ID],
        );
        const row = older.raw
          .query<{ deny_clipboard_writes: number }, []>(
            "SELECT deny_clipboard_writes FROM templates WHERE template_id = 'tp-older00001'",
          )
          .get();
        expect(row?.deny_clipboard_writes).toBe(0);
      } finally {
        await older.close();
      }
    } finally {
      dir.dispose();
    }
  });

  it('refuses a value other than 0 or 1', async () => {
    const { dir, handle } = await openCopy('v10.db');
    try {
      expect(() =>
        handle.raw.run(`UPDATE templates SET deny_clipboard_writes = 2 WHERE template_id = ?`, [
          TEMPLATE_ID,
        ]),
      ).toThrow(/CHECK/);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('round-trips the switch through insert, update and a v11 fixture', async () => {
    const { dir, handle, uow } = await openCopy('v11.db');
    try {
      const stored = await uow.repos.templates.get(TEMPLATE_ID);
      expect(stored?.denyClipboardWrites).toBe(true);
      if (stored === null) throw new Error('template missing');
      const off = await uow.repos.templates.update(
        TEMPLATE_ID,
        { denyClipboardWrites: false },
        stored.version,
      );
      expect(off.denyClipboardWrites).toBe(false);
      expect((await uow.repos.templates.get(TEMPLATE_ID))?.denyClipboardWrites).toBe(false);

      await uow.repos.templates.insert(
        templateRecord({
          templateId: 'tp-clipboard1',
          name: 'clipboard',
          denyClipboardWrites: true,
        }),
      );
      const raw = handle.raw
        .query<{ deny_clipboard_writes: number }, []>(
          "SELECT deny_clipboard_writes FROM templates WHERE template_id = 'tp-clipboard1'",
        )
        .get();
      expect(raw?.deny_clipboard_writes).toBe(1);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
