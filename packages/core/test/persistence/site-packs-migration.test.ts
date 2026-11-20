/** @module test/persistence/site-packs-migration.test — schema v10 (`0010-site-packs`) over a v9 database (spec 13 §9.9, §17 T3a): the `operator_requests` rebuild keeps every row, column and index, the CHECK grows `security_intercept`, `template_id` round-trips, `meta.min_reader_version` becomes 10, v1's DDL is unchanged, and an older binary refuses the upgraded database naming the pre-upgrade backup. */

import { Database } from 'bun:sqlite';
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { type DatabaseHandle, openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import { DISK_MIGRATION_TEST_MS, FakeClock, FakeLogger, TEMPLATE_ID, tempDir } from './helpers.ts';

// Each case opens a database on disk: fsync stalls on CI runners (D30 l, helpers.ts).
setDefaultTimeout(DISK_MIGRATION_TEST_MS);

const FIXTURES = join(import.meta.dir, 'fixtures');
const V9_COLUMNS =
  'request_id, kind, session_id, owner, reason, mode, entry_name, tool, tool_event_id, page_url, options_json, idempotency_key, status, message, resolved_by, resolution_reason, created_at, deadline_at, resolved_at';
const ROWS_SQL = `SELECT ${V9_COLUMNS} FROM operator_requests ORDER BY request_id`;

/** Adds v9 rows that exercise every column (nulls, JSON, idempotency keys, terminal states). */
function seedV9(raw: Database): void {
  const insert = raw.query(
    `INSERT INTO operator_requests (${V9_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'a-v9-resolved',
    'attention',
    'shop-a1b2c3d4',
    'local',
    'login wall',
    'notify',
    null,
    'click',
    'e-tool-1',
    'https://example.com/login',
    '{"reason":"login","note":"é ✓"}',
    'idem-1',
    'resolved',
    'done',
    'local',
    'operator',
    1_700_000_010_000,
    1_700_000_020_000,
    1_700_000_015_000,
  );
  insert.run(
    'v-v9-confirm',
    'vault_confirm',
    'shop-a1b2c3d4',
    'agent-1',
    'vault fill',
    null,
    'github',
    'vault_fill',
    null,
    null,
    null,
    'idem-2',
    'timeout',
    null,
    null,
    null,
    1_700_000_030_000,
    null,
    1_700_000_040_000,
  );
}

async function upgrade(dir: {
  path: string;
}): Promise<{ handle: DatabaseHandle; before: unknown[] }> {
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, 'v9.db'), path);
  const raw = new Database(path);
  let before: unknown[];
  try {
    seedV9(raw);
    before = raw.query(ROWS_SQL).all();
  } finally {
    raw.close();
  }
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock: new FakeClock(),
    logger: new FakeLogger(),
  });
  return { handle, before };
}

function indexNames(raw: Database): string[] {
  return raw
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operator_requests' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

describe('migration 0010-site-packs', () => {
  it('pins v1 DDL byte-for-byte (frozen literals, spec 13 §9.9)', async () => {
    const golden = await Bun.file(join(FIXTURES, 'ddl', '0001-initial.sql')).text();
    expect(MIGRATIONS[0]?.sql).toBe(golden);
  });

  it('rebuilds operator_requests with every row, column and index preserved', async () => {
    const dir = tempDir();
    const { handle, before } = await upgrade(dir);
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      expect(handle.migrationsApplied.map((m) => m.name)).toEqual(
        MIGRATIONS.filter((m) => m.version >= 10).map((m) => m.name),
      );
      expect(before).toHaveLength(3);
      expect(handle.raw.query(ROWS_SQL).all()).toEqual(before);
      const templateIds = handle.raw
        .query<{ n: number }, []>(
          'SELECT COUNT(*) AS n FROM operator_requests WHERE template_id IS NOT NULL',
        )
        .get();
      expect(templateIds?.n).toBe(0);
      expect(indexNames(handle.raw)).toEqual([
        'idx_operator_requests_history',
        'idx_operator_requests_idem',
        'idx_operator_requests_open',
        'idx_operator_requests_session',
        'idx_operator_requests_template',
      ]);
      const leftovers = handle.raw
        .query("SELECT name FROM sqlite_master WHERE name LIKE 'operator_requests_v%'")
        .all();
      expect(leftovers).toEqual([]);
      expect(handle.raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
      // The idempotency unique index still holds after the rebuild.
      expect(() =>
        handle.raw
          .query(
            "INSERT INTO operator_requests (request_id, kind, session_id, owner, reason, status, idempotency_key, created_at) VALUES ('a-dup', 'attention', 'shop-a1b2c3d4', 'local', 'x', 'pending', 'idem-1', 1)",
          )
          .run(),
      ).toThrow(/UNIQUE/);
      // So does the session foreign key (ON DELETE CASCADE).
      expect(() =>
        handle.raw
          .query(
            "INSERT INTO operator_requests (request_id, kind, session_id, owner, reason, status, created_at) VALUES ('a-orphan', 'attention', 'nope-00000000', 'local', 'x', 'pending', 1)",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('extends the kind CHECK and round-trips template_id', async () => {
    const dir = tempDir();
    const { handle } = await upgrade(dir);
    try {
      const uow = new SqliteUnitOfWork(handle.db);
      await uow.repos.operatorRequests.insert({
        requestId: 'a-intercept01',
        kind: 'security_intercept',
        sessionId: 'shop-a1b2c3d4',
        owner: 'local',
        reason: 'LinkedIn security check',
        mode: 'takeover',
        entryName: null,
        tool: 'navigate',
        toolEventId: null,
        pageUrl: 'https://www.linkedin.com/checkpoint/challenge',
        options: { reason: 'challenge', site: 'linkedin' },
        idempotencyKey: null,
        createdAt: 1_700_000_050_000,
        deadlineAt: 1_700_001_850_000,
        templateId: TEMPLATE_ID,
      });
      const stored = await uow.repos.operatorRequests.get('a-intercept01');
      expect(stored?.kind).toBe('security_intercept');
      expect(stored?.templateId).toBe(TEMPLATE_ID);
      expect((await uow.repos.operatorRequests.get('a-v9-resolved'))?.templateId).toBeNull();
      expect(() =>
        handle.raw
          .query(
            "INSERT INTO operator_requests (request_id, kind, session_id, owner, reason, status, created_at) VALUES ('a-bogus', 'bogus', 'shop-a1b2c3d4', 'local', 'x', 'pending', 1)",
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('raises min_reader_version to 10 and an older binary refuses the database, naming the backup', async () => {
    const dir = tempDir();
    const { handle } = await upgrade(dir);
    const backupPath = handle.backupPath;
    try {
      expect(handle.minReaderVersion).toBe(10);
      const reader = handle.raw
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_reader_version'")
        .get();
      expect(reader?.value).toBe('10');
      expect(backupPath).toContain('browserhive-v9-');
    } finally {
      await handle.close();
    }
    try {
      // A v9 binary: the same opener with the migration list it shipped with.
      const older = MIGRATIONS.filter((m) => m.version <= 9);
      let error: unknown;
      try {
        const opened = await openDatabase({
          path: join(dir.path, 'browserhive.db'),
          dataDir: dir.path,
          appVersion: 'v9-binary',
          clock: new FakeClock(),
          logger: new FakeLogger(),
          migrations: older,
        });
        await opened.close();
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'DB_NEWER_THAN_BINARY')).toBe(true);
      if (isAppError(error, 'DB_NEWER_THAN_BINARY')) {
        expect(error.details).toEqual({
          db_version: SCHEMA_VERSION,
          min_reader_version: 10,
          binary_version: 9,
          backup_path: backupPath ?? '',
        });
        expect(error.message).toContain(`browserhive db restore ${backupPath ?? ''}`);
      }
    } finally {
      dir.dispose();
    }
  });
});
