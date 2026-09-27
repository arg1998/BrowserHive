/** @module test/persistence/session-browser-migration.test — schema v4 (`0004-session-browser`) over a v3 database: additive, nothing backfilled, old sessions serve no `browser` ("not recorded"), and the columns round-trip (03 §7, D-31). */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { sessionRowToSummary } from '../../src/interface/http/serializers/sessions.ts';
import { FakeClock, FakeLogger, sessionRecord, tempDir } from './helpers.ts';

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

describe('migration 0004-session-browser', () => {
  it('upgrades a v3 database: existing sessions stay unrecorded and serve no browser', async () => {
    const { dir, handle, uow } = await openCopy('v3.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      const raw = handle.raw
        .query<{ sandboxed: number | null; browser_version: string | null }, []>(
          'SELECT sandboxed, browser_version FROM sessions',
        )
        .all();
      expect(raw.length).toBeGreaterThan(0);
      for (const row of raw) {
        expect(row.sandboxed).toBeNull();
        expect(row.browser_version).toBeNull();
      }
      const page = await uow.repos.sessions.list({ limit: 50 });
      expect(page.items.length).toBe(raw.length);
      for (const row of page.items) {
        expect(row.sandboxed).toBeNull();
        expect(row.browserVersion).toBeNull();
        expect('browser' in sessionRowToSummary(row, 1_700_000_000_000, false)).toBe(false);
        const detail = await uow.repos.sessions.get(row.sessionId);
        expect(detail?.sandboxed).toBeNull();
      }
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('round-trips the launch record through insert and update, and a patch without it keeps it', async () => {
    const { dir, handle, uow } = await openCopy('v3.db');
    try {
      await uow.transaction(async (r) => {
        await r.sessions.insert(sessionRecord({ sessionId: 'rec-22222222', state: 'reserved' }));
      });
      expect((await uow.repos.sessions.get('rec-22222222'))?.sandboxed).toBeNull();
      await uow.repos.sessions.update('rec-22222222', {
        state: 'live',
        sandboxed: false,
        browserVersion: '153.0.8010.12',
      });
      await uow.repos.sessions.update('rec-22222222', { state: 'closed', closedAt: 1 });
      const row = await uow.repos.sessions.get('rec-22222222');
      expect(row?.sandboxed).toBe(false);
      expect(row?.browserVersion).toBe('153.0.8010.12');
      if (row === null) throw new Error('row missing');
      expect(sessionRowToSummary(row, 2, false).browser).toEqual({
        version: '153.0.8010.12',
        sandboxed: false,
      });
      // A launch without a readable version records its verdict alone.
      await uow.repos.sessions.update('rec-22222222', { sandboxed: true, browserVersion: null });
      const persistent = await uow.repos.sessions.get('rec-22222222');
      if (persistent === null) throw new Error('row missing');
      expect(sessionRowToSummary(persistent, 2, false).browser).toEqual({
        version: null,
        sandboxed: true,
      });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('refuses a sandboxed value other than 0 or 1', async () => {
    const { dir, handle } = await openCopy('v4.db');
    try {
      expect(() =>
        handle.raw.exec("UPDATE sessions SET sandboxed = 2 WHERE session_id = 'shop-a1b2c3d4'"),
      ).toThrow();
      const row = handle.raw
        .query<{ sandboxed: number | null; browser_version: string | null }, [string]>(
          'SELECT sandboxed, browser_version FROM sessions WHERE session_id = ?',
        )
        .get('shop-a1b2c3d4');
      expect(row).toEqual({ sandboxed: 1, browser_version: '154.0.8037.57' });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
