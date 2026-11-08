/** @module test/persistence/operator-token-scopes-migration.test — schema v8 (`0008-operator-token-scopes`): operator tokens issued without `scopes` (the full list of their release) become `[]`, so they keep every scope now that operator tokens are limited to their credential's scopes; every other credential is untouched, and the minimum reader is unchanged (03 §3.5). */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scope } from '@browserhive/contracts/enums';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** Every scope of 0.1.x, as a 0.1.x token issued without `scopes` stored it. */
const FULL_V01 = Scope.options.filter((s) => s !== 'channels:read' && s !== 'channels:write');

/** Copies a fixture, lets `prepare` write to it at its own version, then opens it (migrating). */
async function openCopy(
  fixture: string,
  prepare: (raw: Database) => void,
  clock = new FakeClock(),
) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  const raw = new Database(path);
  try {
    prepare(raw);
  } finally {
    raw.close();
  }
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock,
    logger: new FakeLogger(),
  });
  return { dir, handle };
}

function insertPrincipal(raw: Database, id: string, kind: 'operator' | 'agent'): void {
  raw
    .query(
      'INSERT OR IGNORE INTO principals (principal_id, kind, display, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)',
    )
    .run(id, kind, id);
}

function insertToken(
  raw: Database,
  id: string,
  principal: string,
  scopes: readonly string[],
  createdAt: number,
): void {
  raw
    .query(
      "INSERT INTO credentials (credential_id, principal_id, kind, public_prefix, secret_hash, display, scopes_json, created_at) VALUES (?, ?, 'api_token', ?, 'h', ?, ?, ?)",
    )
    .run(id, principal, id, id, JSON.stringify(scopes), createdAt);
}

function scopesOf(handle: Awaited<ReturnType<typeof openDatabase>>): Record<string, string> {
  const rows = handle.raw
    .query<{ credential_id: string; scopes_json: string }, []>(
      'SELECT credential_id, scopes_json FROM credentials',
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.credential_id, r.scopes_json]));
}

describe('migration 0008-operator-token-scopes', () => {
  it('rewrites full-set operator tokens to [] and leaves every other credential alone', async () => {
    const upgradedAt = 2_000;
    const { dir, handle } = await openCopy('v7.db', (raw) => {
      // The first 0.2.0 migration reached this database at `upgradedAt`.
      raw.query('UPDATE schema_migrations SET applied_at = ? WHERE version = 3').run(upgradedAt);
      insertPrincipal(raw, 'bot', 'agent');
      insertToken(raw, 'op-full', 'local', Scope.options, 3_000);
      insertToken(raw, 'op-v01', 'local', FULL_V01, 1_000);
      insertToken(raw, 'op-v01-chosen', 'local', FULL_V01, 3_000);
      insertToken(raw, 'op-subset', 'local', ['system:read'], 1_000);
      insertToken(raw, 'op-reordered', 'local', [...Scope.options].reverse(), 3_000);
      insertToken(raw, 'agent', 'bot', ['mcp:tools'], 1_000);
    });
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      expect(scopesOf(handle)).toEqual({
        'cred-1': '[]',
        'op-full': '[]',
        'op-v01': '[]',
        'op-v01-chosen': JSON.stringify(FULL_V01),
        'op-subset': '["system:read"]',
        'op-reordered': JSON.stringify([...Scope.options].reverse()),
        agent: '["mcp:tools"]',
      });
      const reader = handle.raw
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_reader_version'")
        .get();
      expect(reader?.value).toBe('1');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('a 0.1.x database upgrading in one step keeps its full-set operator tokens full', async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const { dir, handle } = await openCopy(
      'v2.db',
      (raw) => {
        insertToken(raw, 'op-v01', 'local', FULL_V01, 1_700_000_000_000);
        insertToken(raw, 'op-subset', 'local', ['sessions:read'], 1_700_000_000_000);
      },
      clock,
    );
    try {
      expect(scopesOf(handle)).toMatchObject({ 'op-v01': '[]', 'op-subset': '["sessions:read"]' });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
