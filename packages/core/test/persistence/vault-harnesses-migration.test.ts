/** @module test/persistence/vault-harnesses-migration.test — schema v7 (`0007-vault-harnesses`) over a v6 database: four nullable columns, nothing backfilled (every rule keeps meaning "all harnesses", no declared name is guessed), the minimum reader unchanged, and the columns round-trip with `null` and `[]` kept apart (03 §7, D-48). */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWireExport } from '../../src/app/vault/export.ts';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
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

describe('migration 0007-vault-harnesses', () => {
  it('upgrades a v6 database: rules read "all harnesses", nothing declared, reader unchanged', async () => {
    const { dir, handle, uow } = await openCopy('v6.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      const nulls = (table: string, column: string) =>
        handle.raw
          .query<{ n: number; total: number }, []>(
            `SELECT SUM(${column} IS NULL) AS n, COUNT(*) AS total FROM ${table}`,
          )
          .get();
      for (const [table, column] of [
        ['vault_bindings', 'harnesses_json'],
        ['vault_group_policies', 'harnesses_json'],
        ['mcp_connections', 'harness_declared'],
        ['sessions', 'harness_declared'],
      ] as const) {
        const row = nulls(table, column);
        expect(row?.total).toBeGreaterThan(0);
        expect(row?.n).toBe(row?.total);
      }
      const reader = handle.raw
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_reader_version'")
        .get();
      expect(reader?.value).toBe('1');

      const binding = await uow.repos.vaultBindings.get('github');
      expect(binding?.harnesses).toBeNull();
      const policies = await uow.repos.vaultGroupPolicies.list();
      expect(policies.every((p) => p.harnesses === null)).toBe(true);
      // An old rule exports without the field, so the document stays what older binaries wrote.
      const doc = toWireExport(await uow.repos.vaultBindings.exportAll());
      expect(doc.bindings.every((b) => !('harnesses' in b))).toBe(true);
      expect(doc.policies.every((p) => !('harnesses' in p))).toBe(true);
      const session = await uow.repos.sessions.get('shop-a1b2c3d4');
      expect(session?.harness).toBe('claude-code');
      expect(session?.harnessDeclared).toBeNull();
      expect((await uow.repos.mcpConnections.get('c-1'))?.harnessDeclared).toBeNull();
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('round-trips lists and declared names, keeping null (all) and [] (none) apart', async () => {
    const { dir, handle, uow } = await openCopy('v7.db');
    try {
      expect((await uow.repos.vaultBindings.get('github'))?.harnesses).toEqual([
        'claude-code',
        'Nightly Scraper',
      ]);
      expect((await uow.repos.vaultGroupPolicies.get('__ungrouped__'))?.harnesses).toEqual([
        'unknown',
      ]);
      expect((await uow.repos.sessions.get('shop-a1b2c3d4'))?.harnessDeclared).toBe('Claude Code');
      expect((await uow.repos.mcpConnections.get('c-1'))?.harnessDeclared).toBe('Claude Code');

      const stored = await uow.repos.vaultBindings.get('github');
      if (stored === null) throw new Error('binding missing');
      await uow.repos.vaultBindings.upsert({ ...stored, harnesses: [] }, stored.version);
      expect((await uow.repos.vaultBindings.get('github'))?.harnesses).toEqual([]);
      const raw = handle.raw
        .query<{ harnesses_json: string | null }, []>(
          "SELECT harnesses_json FROM vault_bindings WHERE handle = 'github'",
        )
        .get();
      expect(raw?.harnesses_json).toBe('[]');
      const again = await uow.repos.vaultBindings.get('github');
      if (again === null) throw new Error('binding missing');
      await uow.repos.vaultBindings.upsert({ ...again, harnesses: null }, again.version);
      expect((await uow.repos.vaultBindings.get('github'))?.harnesses).toBeNull();

      await uow.repos.sessions.insert(
        sessionRecord({
          sessionId: 'decl-22222222',
          harness: 'opencode',
          harnessDeclared: 'OpenCode',
        }),
      );
      expect((await uow.repos.sessions.get('decl-22222222'))?.harnessDeclared).toBe('OpenCode');
      await uow.repos.mcpConnections.update('c-1', { harnessDeclared: 'claude code' });
      expect((await uow.repos.mcpConnections.get('c-1'))?.harnessDeclared).toBe('claude code');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
