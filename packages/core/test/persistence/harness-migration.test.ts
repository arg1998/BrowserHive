/** @module test/persistence/harness-migration.test — schema v3 (`0003-harness-identity`) over a v2 database: additive, backfills `workspace` and the sources, and sessions created before it read `unknown` (03 §7, D-30). */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

async function openV2Copy(prepare?: (raw: import('bun:sqlite').Database) => void) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, 'v2.db'), path);
  if (prepare !== undefined) {
    const { Database } = await import('bun:sqlite');
    const raw = new Database(path);
    prepare(raw);
    raw.close();
  }
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock: new FakeClock(),
    logger: new FakeLogger(),
  });
  return { dir, handle, uow: new SqliteUnitOfWork(handle.db) };
}

describe('migration 0003-harness-identity', () => {
  it('upgrades a v2 database: old sessions read unknown and stay listed', async () => {
    const { dir, handle, uow } = await openV2Copy();
    try {
      expect(handle.schemaVersion).toBe(3);
      const page = await uow.repos.sessions.list({ limit: 50 });
      expect(page.items.length).toBeGreaterThan(0);
      for (const row of page.items) expect(row.harness).toBeNull();
      const facets = await uow.repos.sessions.facets({});
      expect(facets.harnesses).toEqual([{ value: 'unknown', count: page.items.length }]);
      const filtered = await uow.repos.sessions.list({ limit: 50, harnesses: ['unknown'] });
      expect(filtered.items.length).toBe(page.items.length);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('backfills workspace from agent_name and marks stored header values', async () => {
    const { dir, handle, uow } = await openV2Copy((raw) => {
      raw.exec(
        "UPDATE mcp_connections SET agent_name = 'checkout-bot', harness = 'Claude Code', model = 'opus'",
      );
    });
    try {
      const rows = handle.raw
        .query<
          {
            workspace: string | null;
            agent_name: string | null;
            harness_source: string | null;
            model_source: string | null;
          },
          []
        >('SELECT workspace, agent_name, harness_source, model_source FROM mcp_connections')
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.workspace).toBe('checkout-bot');
        expect(row.agent_name).toBe('checkout-bot');
        expect(row.harness_source).toBe('header');
        expect(row.model_source).toBe('header');
      }
      const recent = await uow.repos.mcpConnections.listRecent(10);
      expect(recent.rows[0]?.workspace).toBe('checkout-bot');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
