/** @module test/cli/db — `db status | backup | restore | migrate` and `admin` against a temp file database opened through the composition's `openStorageForCli` */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@browserhive/core/persistence';
import { createLogger, createNodeFileSystem, createSystemClock } from '@browserhive/core/runtime';
import { z } from 'zod';
import type { CliDeps } from '../../src/cli/deps.ts';
import { inspectDatabaseFile, openCliStorage } from '../../src/cli/production/storage.ts';
import { nodeConfigFs } from '../../src/composition/config-fs.ts';
import { acquireDataDirLock, readLiveLock } from '../../src/composition/lock-file.ts';
import { cliHarness } from './helpers.ts';

let root = '';
let dataDir = '';

function realDeps(): Partial<CliDeps> {
  const clock = createSystemClock();
  const logger = createLogger({
    level: 'error',
    format: 'json',
    clock,
    stream: { write: () => true },
  });
  const context = { logger, appVersion: '0.1.0', clock };
  return {
    fs: createNodeFileSystem(),
    configFs: nodeConfigFs,
    openStorage: (input) => openCliStorage(input, context),
    inspectDatabase: (path) => inspectDatabaseFile(path, context),
    copyFile: (from, to) => copyFile(from, to),
    schemaVersion: SCHEMA_VERSION,
    lock: {
      read: (dir) => readLiveLock(dir),
      acquire: (dir, owner) => acquireDataDirLock({ dataDir: dir, owner, now: clock.now() }),
    },
  };
}

async function cli(argv: string[], answers: string[] | null = null) {
  return cliHarness({ argv: [...argv, '--dataDir', dataDir], answers, overrides: realDeps() });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bh-cli-db-'));
  dataDir = join(root, 'data');
  const init = await cli(['init', '--skipBrowsers']);
  expect(init.code).toBe(0);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('db (temp file database)', () => {
  it('status prints versions, application id, pending, size, integrity', async () => {
    const run = await cli(['db', 'status']);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(
      new RegExp(`^user_version\\s+${SCHEMA_VERSION} \\(this binary: ${SCHEMA_VERSION}\\)$`, 'm'),
    );
    expect(run.stdout).toMatch(/^application_id\s+0x42484956 \(BHIV\)$/m);
    expect(run.stdout).toMatch(/^pending migrations\s+none$/m);
    expect(run.stdout).toMatch(/^integrity\s+ok$/m);
    const json = z
      .object({
        user_version: z.number(),
        min_reader_version: z.number(),
        application_id: z.literal(0x42484956),
        pending_migrations: z.array(z.object({ version: z.number(), name: z.string() })),
        size_bytes: z.number().positive(),
        page_count: z.number(),
        last_backup: z.object({ path: z.string() }).nullable(),
        quick_check: z.object({ ok: z.literal(true) }),
      })
      .parse(JSON.parse((await cli(['db', 'status', '--json'])).stdout));
    expect(json.pending_migrations).toEqual([]);
  });

  it('status without a database exits 1 naming init', async () => {
    const run = await cliHarness({
      argv: ['db', 'status', '--dataDir', join(root, 'empty')],
      overrides: realDeps(),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Run 'browserhive init' to create it.");
  });

  it('backup --out writes a SQLite copy; without --out it lands in backups/', async () => {
    const out = join(root, 'manual.db');
    const run = await cli(['db', 'backup', '--out', out]);
    expect(run.code).toBe(0);
    expect(readFileSync(out).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect((await cli(['db', 'backup', '--out', out])).code).toBe(1);
    const auto = await cli(['db', 'backup']);
    expect(auto.code).toBe(0);
    expect(auto.stdout).toMatch(
      new RegExp(`backups/browserhive-v${SCHEMA_VERSION}-\\d{8}T\\d{9}Z\\.db`),
    );
  });

  it('migrate --dryRun and migrate report an up-to-date schema', async () => {
    expect((await cli(['db', 'migrate', '--dryRun'])).stdout).toContain('database is up to date');
    const json = JSON.parse((await cli(['db', 'migrate', '--json'])).stdout);
    expect(json).toEqual({
      dry_run: false,
      from: SCHEMA_VERSION,
      to: SCHEMA_VERSION,
      applied: [],
      backup_path: null,
    });
  });

  it('restore: refuses while locked, refuses non-BrowserHive files, backs up then replaces', async () => {
    const snapshot = join(root, 'snapshot.db');
    expect((await cli(['db', 'backup', '--out', snapshot])).code).toBe(0);
    const created = await cli(['admin', 'tokens', 'create', 'agent-9', '--json']);
    expect(created.code).toBe(0);

    const lock = acquireDataDirLock({ dataDir, owner: 'serve', now: 1 });
    try {
      const locked = await cli(['db', 'restore', snapshot, '--yes']);
      expect(locked.code).toBe(3);
      expect(locked.stderr).toContain('[DATA_DIR_LOCKED] Refusing to restore the database');
    } finally {
      lock.release();
    }

    const bogus = join(root, 'bogus.db');
    writeFileSync(bogus, 'not a database at all, just text'.repeat(10));
    const refused = await cli(['db', 'restore', bogus, '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('is not a BrowserHive database');

    expect((await cli(['db', 'restore', snapshot])).code).toBe(1);
    const aborted = await cli(['db', 'restore', snapshot], ['no']);
    expect(aborted.stdout).toContain('Aborted — nothing was changed.');

    const restored = await cli(['db', 'restore', snapshot], ['YES']);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('✓ current database backed up:');
    expect(restored.stdout).toContain(`✓ restored ${snapshot}`);
    const list = JSON.parse((await cli(['admin', 'tokens', 'list', '--json'])).stdout);
    expect(list).toEqual([]);
  });
});

describe('admin (temp file database)', () => {
  it('tokens create shows the plaintext once; list shows prefix; revoke by principal', async () => {
    const created = await cli(['admin', 'tokens', 'create', 'agent-2', '--expiresIn', '30d']);
    expect(created.code).toBe(0);
    const token = /token: {3}(bh_agent_[A-Za-z0-9_-]{43})/.exec(created.stdout)?.[1];
    expect(token).toBeDefined();
    const list = await cli(['admin', 'tokens', 'list']);
    expect(list.stdout).toMatch(
      /^PRINCIPAL\s+KIND\s+PREFIX\s+CREATED\s+LAST USED\s+EXPIRES\s+ID$/m,
    );
    expect(list.stdout).toMatch(/^agent-2\s+agent\s+\S{8}\s/m);
    expect(list.stdout).not.toContain(token ?? 'x');
    const revoked = await cli(['admin', 'tokens', 'revoke', 'agent-2']);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain('✓ revoked');
    expect((await cli(['admin', 'tokens', 'revoke', 'agent-2'])).code).toBe(1);
  });

  it('reset-password prints once, writes credentials.txt 0600, refuses while locked', async () => {
    const run = await cli(['admin', 'reset-password', '--json']);
    expect(run.code).toBe(0);
    const body = z
      .object({ password: z.string().length(24), credentials_path: z.string() })
      .parse(JSON.parse(run.stdout));
    expect(readFileSync(body.credentials_path, 'utf8').trim()).toBe(body.password);
    expect(statSync(body.credentials_path).mode & 0o777).toBe(0o600);

    const lock = acquireDataDirLock({ dataDir, owner: 'serve', now: 1 });
    try {
      const locked = await cli(['admin', 'reset-password']);
      expect(locked.code).toBe(3);
      expect(locked.stderr).toContain('[DATA_DIR_LOCKED] Refusing to reset the admin password');
      expect(locked.stderr).toContain("'serve'");
      const tokens = await cli(['admin', 'tokens', 'list']);
      expect(tokens.code).toBe(3);
      expect(tokens.stderr).toContain('--url');
    } finally {
      lock.release();
    }
  });
});
