/** @module test/cli/templates-rekey.test — `browserhive templates rekey --oldKeyEnv <ENV>` (spec 13 §2.4): the refusals (server running, variable unset or not a key, no current key, same key, usage), then end to end on a temporary data directory with a real SQLite database: every file re-encrypted and its row updated, an interrupted run finished, a repeated run a no-op, a file under an unknown key reported with exit 1. */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '@browserhive/core/persistence';
import { createLogger, createNodeFileSystem, createSystemClock } from '@browserhive/core/runtime';
import {
  decodeTemplateKey,
  FileTemplateStateStore,
  type TemplateKey,
  templateKeyOf,
} from '@browserhive/core/server';
import type { CliDeps } from '../../src/cli/deps.ts';
import { openCliStorage } from '../../src/cli/production/storage.ts';
import { nodeConfigFs } from '../../src/composition/config-fs.ts';
import { acquireDataDirLock, readLiveLock } from '../../src/composition/lock-file.ts';
import { cliHarness, DATA_DIR, MemoryFs } from './helpers.ts';

const OLD = Buffer.alloc(32, 1).toString('base64');
const NEW = Buffer.alloc(32, 2).toString('base64');
const STRAY = Buffer.alloc(32, 3).toString('base64');
const STATE = {
  cookies: [],
  origins: [{ origin: 'https://a.example', localStorage: [{ name: 'k', value: 'v' }] }],
};

/** The columns of `template_versions` that `rekey` updates. */
interface VersionRow {
  template_id: string;
  version: number;
  key_id: string;
  sha256: string;
  size_bytes: number;
}

function key(text: string): TemplateKey {
  const bytes = decodeTemplateKey(text);
  if (bytes === null) throw new Error('bad test key');
  return templateKeyOf(bytes);
}

describe('templates rekey refusals', () => {
  const fs = (): MemoryFs => new MemoryFs({ [`${DATA_DIR}/admin/template.key`]: `${NEW}\n` });
  const rekey = (env: Record<string, string>, extra: string[] = [], lock = false) =>
    cliHarness({
      argv: ['templates', 'rekey', '--oldKeyEnv', 'BH_OLD_KEY', ...extra],
      env,
      fs: fs(),
      ...(lock && { lock: { pid: 4242, owner: 'serve', startedAt: 1 } }),
    });

  it('refuses while a server holds the data directory (3)', async () => {
    const run = await rekey({ BH_OLD_KEY: OLD }, [], true);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('[DATA_DIR_LOCKED] Refusing to re-encrypt the template files');
  });

  it('refuses an unset or malformed old key without printing it', async () => {
    const unset = await rekey({});
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('BH_OLD_KEY is not set');
    const bad = await rekey({ BH_OLD_KEY: 'not-a-key' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('BH_OLD_KEY does not hold a template key');
    expect(bad.stderr).not.toContain('not-a-key');
  });

  it('refuses without a current key (never creating one) and when the old key is the current one', async () => {
    const none = await cliHarness({
      argv: ['templates', 'rekey', '--oldKeyEnv', 'BH_OLD_KEY'],
      env: { BH_OLD_KEY: OLD },
    });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no current key');
    expect(none.stderr).toContain('rekey never creates a key');
    expect(none.fs.writes).toEqual([]);
    const same = await rekey({ BH_OLD_KEY: NEW });
    expect(same.code).toBe(1);
    expect(same.stderr).toContain('BH_OLD_KEY holds the current key');
  });

  it('--oldKeyEnv is required and must be a variable name (64)', async () => {
    const missing = await cliHarness({ argv: ['templates', 'rekey'] });
    expect(missing.code).toBe(64);
    expect(missing.stderr).toContain("'templates rekey' requires --oldKeyEnv <ENV>");
    const value = await cliHarness({ argv: ['templates', 'rekey', '--oldKeyEnv', OLD] });
    expect(value.code).toBe(64);
    expect(value.stderr).not.toContain(OLD);
  });
});

describe('templates rekey (temp data dir, real database)', () => {
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
      schemaVersion: SCHEMA_VERSION,
      lock: {
        read: (dir) => readLiveLock(dir),
        acquire: (dir, owner) => acquireDataDirLock({ dataDir: dir, owner, now: clock.now() }),
      },
    };
  }

  const cli = (argv: string[], env: Record<string, string> = {}) =>
    cliHarness({ argv: [...argv, '--dataDir', dataDir], env, overrides: realDeps() });
  const rekey = () =>
    cli(['templates', 'rekey', '--oldKeyEnv', 'BH_OLD_KEY'], {
      BH_OLD_KEY: OLD,
      BROWSERHIVE_TEMPLATE_KEY: NEW,
    });
  const store = (): FileTemplateStateStore =>
    new FileTemplateStateStore({
      templatesDir: join(dataDir, 'templates'),
      keys: { current: null, previous: null },
    });

  function insertTemplate(db: Database, id: string, name: string, versions: number[]): void {
    db.run(
      `INSERT INTO templates (template_id, name, display_name, status, owner, channel, stealth, fingerprint, humanize, identity_json, health_interval_ms, created_at, updated_at)
       VALUES (?, ?, ?, 'ready', 'admin', 'chromium', 'standard', 1, 0, '{}', 3600000, 1, 1)`,
      [id, name, name],
    );
    for (const version of versions) {
      db.run(
        `INSERT INTO template_versions (template_id, version, reason, size_bytes, sha256, key_id, structure_sha256, summary_json, health_json, created_at)
         VALUES (?, ?, 'manual', 0, '', ?, '', '{"domains":[],"storage_origins":0}', '[]', 1)`,
        [id, version, key(OLD).keyId],
      );
    }
  }

  function rows(db: Database): VersionRow[] {
    return db
      .query<VersionRow, []>(
        'SELECT template_id, version, key_id, sha256, size_bytes FROM template_versions ORDER BY template_id, version',
      )
      .all();
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bh-cli-rekey-'));
    dataDir = join(root, 'data');
    expect((await cli(['init', '--skipBrowsers'])).code).toBe(0);
    const db = new Database(join(dataDir, 'browserhive.db'));
    insertTemplate(db, 'tp-aaaaaaaaaa', 'alpha', [1, 2]);
    insertTemplate(db, 'tp-bbbbbbbbbb', 'beta', [1]);
    db.close();
    const files = store();
    for (const [id, slots] of [
      ['tp-aaaaaaaaaa', [1, 2, 'latest']],
      ['tp-bbbbbbbbbb', [1]],
    ] as const) {
      for (const slot of slots) await files.writeWith(id, slot, STATE, key(OLD));
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('re-encrypts every file with the current key and updates the rows; a repeat is a no-op', async () => {
    const run = await rekey();
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('alpha (tp-aaaaaaaaaa)');
    expect(run.stdout).toContain('3 re-encrypted, 0 already on the current key');
    expect(run.stdout).toContain('4 file(s) re-encrypted, 0 already on the current key, 0 failed.');
    expect(run.stdout).not.toContain(OLD);
    expect(run.stdout).not.toContain(NEW);
    const reader = new FileTemplateStateStore({
      templatesDir: join(dataDir, 'templates'),
      keys: { current: key(NEW), previous: null },
    });
    expect((await reader.readWithKey('tp-aaaaaaaaaa', 'latest')).state).toEqual(STATE);
    const db = new Database(join(dataDir, 'browserhive.db'), { readonly: true });
    for (const r of rows(db)) {
      expect(r.key_id).toBe(key(NEW).keyId);
      const bytes = readFileSync(
        join(dataDir, 'templates', r.template_id, 'versions', `v${r.version}.state.enc`),
      );
      expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(r.size_bytes).toBe(bytes.length);
    }
    db.close();

    const again = await rekey();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(
      '0 file(s) re-encrypted, 4 already on the current key, 0 failed.',
    );
    const json = await cli(['templates', 'rekey', '--oldKeyEnv', 'BH_OLD_KEY', '--json'], {
      BH_OLD_KEY: OLD,
      BROWSERHIVE_TEMPLATE_KEY: NEW,
    });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ rewritten: 0, skipped: 4, failed: [] });
  });

  it('finishes an interrupted run: a file renamed before its row moved, and a leftover .tmp', async () => {
    // As if a run died after rewriting alpha v1 but before updating its row.
    await store().writeWith('tp-aaaaaaaaaa', 1, STATE, key(NEW));
    const versions = join(dataDir, 'templates', 'tp-aaaaaaaaaa', 'versions');
    writeFileSync(join(versions, 'v2.state.enc.tmp'), 'partial');
    const run = await rekey();
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('3 file(s) re-encrypted, 1 already on the current key, 0 failed.');
    expect(readdirSync(versions).some((name) => name.endsWith('.tmp'))).toBe(false);
    const db = new Database(join(dataDir, 'browserhive.db'), { readonly: true });
    expect(rows(db).every((r) => r.key_id === key(NEW).keyId)).toBe(true);
    db.close();
  });

  it('reports a file under an unknown key with exit 1 and still re-encrypts the rest', async () => {
    await store().writeWith('tp-bbbbbbbbbb', 1, STATE, key(STRAY));
    const run = await rekey();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('beta (tp-bbbbbbbbbb)');
    expect(run.stderr).toContain('tp-bbbbbbbbbb 1:');
    expect(run.stderr).toContain('some files could not be re-encrypted');
    expect(run.stdout).toContain('3 file(s) re-encrypted, 0 already on the current key, 1 failed.');
  });

  it('refuses while the database is held by another process', async () => {
    const lock = acquireDataDirLock({ dataDir, owner: 'serve', now: Date.now() });
    try {
      const run = await rekey();
      expect(run.code).toBe(3);
    } finally {
      lock.release();
    }
  });
});
