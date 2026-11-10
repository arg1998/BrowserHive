/** @module test/persistence/templates-migration.test — schema v9 (`0009-templates`) over a v8 database: the four template tables with their frozen CHECK lists, the session's template columns (nothing backfilled), the operator-token rewrite of the 0.2.x full scope list, the minimum reader unchanged, and the repositories round-tripping every column (spec 13 §2.5, D-49). */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scope } from '@browserhive/contracts/enums';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import {
  FakeClock,
  FakeLogger,
  sessionRecord,
  TEMPLATE_ID,
  tempDir,
  templateRecord,
  templateSiteRecord,
} from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** The 0.2.x full list (19 scopes, registry order), as v8's `FULL_V02` literal. */
const FULL_V02 = Scope.options.slice(0, Scope.options.indexOf('mcp:tools') + 1);

async function openCopy(fixture: string, prepare?: (raw: Database) => void) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  if (prepare !== undefined) {
    const raw = new Database(path);
    try {
      prepare(raw);
    } finally {
      raw.close();
    }
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

function insertToken(
  raw: Database,
  id: string,
  principal: string,
  scopes: readonly string[],
): void {
  raw
    .query(
      "INSERT INTO credentials (credential_id, principal_id, kind, public_prefix, secret_hash, display, scopes_json, created_at) VALUES (?, ?, 'api_token', ?, 'h', ?, ?, 1)",
    )
    .run(id, principal, id, id, JSON.stringify(scopes));
}

describe('migration 0009-templates', () => {
  it('rewrites operator tokens issued with the 0.2.x full list after v8 and nothing else', async () => {
    const { dir, handle } = await openCopy('v8.db', (raw) => {
      raw
        .query(
          "INSERT OR IGNORE INTO principals (principal_id, kind, display, must_change_password, created_at, updated_at) VALUES ('bot', 'agent', 'bot', 0, 1, 1)",
        )
        .run();
      insertToken(raw, 'op-full', 'local', FULL_V02);
      insertToken(raw, 'op-reordered', 'local', [...FULL_V02].reverse());
      insertToken(raw, 'op-subset', 'local', ['system:read']);
      insertToken(raw, 'agent-full', 'bot', FULL_V02);
    });
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      const rows = handle.raw
        .query<{ credential_id: string; scopes_json: string }, []>(
          'SELECT credential_id, scopes_json FROM credentials',
        )
        .all();
      expect(Object.fromEntries(rows.map((r) => [r.credential_id, r.scopes_json]))).toEqual({
        'cred-1': '[]',
        'op-full': '[]',
        'op-reordered': JSON.stringify([...FULL_V02].reverse()),
        'op-subset': '["system:read"]',
        'agent-full': JSON.stringify(FULL_V02),
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

  it('leaves every existing session exclusive (no template columns backfilled)', async () => {
    const { dir, handle, uow } = await openCopy('v8.db');
    try {
      const counts = handle.raw
        .query<{ n: number; total: number }, []>(
          'SELECT SUM(template_id IS NULL AND template_name IS NULL AND template_mode IS NULL AND sealed IS NULL) AS n, COUNT(*) AS total FROM sessions',
        )
        .get();
      expect(counts?.total).toBeGreaterThan(0);
      expect(counts?.n).toBe(counts?.total ?? -1);
      const session = await uow.repos.sessions.get('shop-a1b2c3d4');
      expect(session?.template).toBeNull();
      expect(session?.sealed).toBeNull();
      expect(await uow.repos.templates.count()).toBe(0);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('round-trips a template, its sites and a template session', async () => {
    const { dir, handle, uow } = await openCopy('v8.db');
    try {
      const template = templateRecord({
        harnesses: [],
        authorizedPrincipals: ['p-agent'],
        proxy: {
          server: 'http://proxy.test:8080',
          bypass: null,
          username: 'u',
          passwordEnv: 'JOB_PROXY_PASSWORD',
          label: 'Job proxy',
        },
        unseal: {
          cookieValues: true,
          evaluate: false,
          cookieWrites: false,
          stateExport: false,
          principals: ['p-agent'],
        },
        identity: {
          seed: 'b'.repeat(21),
          locale: 'de-DE',
          languages: ['de-DE', 'de'],
          timezoneId: 'Europe/Berlin',
          countryCode: 'DE',
          geolocation: { latitude: 52.5, longitude: 13.4 },
        },
      });
      await uow.repos.templates.insert(template);
      await uow.repos.templateSites.upsert(
        templateSiteRecord({
          form: { username: '#u', password: '#p' },
          learnedCookieNames: ['sid', 'li_at'],
        }),
      );
      expect(await uow.repos.templates.get(TEMPLATE_ID)).toEqual(template);
      expect((await uow.repos.templateSites.list(TEMPLATE_ID))[0]?.form).toEqual({
        username: '#u',
        password: '#p',
      });
      await uow.repos.sessions.insert(
        sessionRecord({
          sessionId: 'jobs-12345678',
          template: { templateId: TEMPLATE_ID, name: 'job-hunt', version: 3, mode: 'live' },
          sealed: true,
        }),
      );
      expect((await uow.repos.sessions.get('jobs-12345678'))?.template).toEqual({
        templateId: TEMPLATE_ID,
        name: 'job-hunt',
        version: 3,
        mode: 'live',
      });
      // Deleting the template keeps the session's history: the name survives, the id goes.
      expect(await uow.repos.templates.remove(TEMPLATE_ID)).toBe(true);
      expect(await uow.repos.templateSites.list(TEMPLATE_ID)).toEqual([]);
      const after = await uow.repos.sessions.get('jobs-12345678');
      expect(after?.template).toEqual({
        templateId: null,
        name: 'job-hunt',
        version: 3,
        mode: 'live',
      });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('enforces the frozen CHECK lists and the unique name', async () => {
    const { dir, handle, uow } = await openCopy('v8.db');
    try {
      await uow.repos.templates.insert(templateRecord());
      const name = await uow.repos.templates
        .insert(templateRecord({ templateId: 'tp-other00001' }))
        .catch((e: unknown) => e);
      expect(isAppError(name, 'TEMPLATE_NAME_TAKEN')).toBe(true);
      const bad = (statement: string) => () => handle.raw.query(statement).run();
      expect(
        bad(`UPDATE templates SET status = 'live' WHERE template_id = '${TEMPLATE_ID}'`),
      ).toThrow(/CHECK/);
      expect(
        bad(`UPDATE templates SET max_concurrent = 21 WHERE template_id = '${TEMPLATE_ID}'`),
      ).toThrow(/CHECK/);
      expect(
        bad(`UPDATE templates SET health_interval_ms = 60000 WHERE template_id = '${TEMPLATE_ID}'`),
      ).toThrow(/CHECK/);
      expect(
        bad(
          `INSERT INTO template_versions (template_id, version, reason, size_bytes, sha256, key_id, structure_sha256, summary_json, health_json, created_at) VALUES ('${TEMPLATE_ID}', 1, 'checkpoint', 1, 'x', 'k', 's', '{}', '{}', 1)`,
        ),
      ).toThrow(/CHECK/);
      // `template_mode` is an open set: a future `serial` is stored and read as the refusing mode.
      await uow.repos.sessions.insert(sessionRecord({ sessionId: 'later-12345678' }));
      handle.raw
        .query(
          "UPDATE sessions SET template_name = 'job-hunt', template_mode = 'serial' WHERE session_id = 'later-12345678'",
        )
        .run();
      expect((await uow.repos.sessions.get('later-12345678'))?.template?.mode).toBe('maintenance');
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('optimistic versions: a stale If-Match is a CONFLICT, a rename onto a taken name is refused', async () => {
    const { dir, handle, uow } = await openCopy('v8.db');
    try {
      await uow.repos.templates.insert(templateRecord());
      await uow.repos.templates.insert(
        templateRecord({ templateId: 'tp-other00001', name: 'other' }),
      );
      const updated = await uow.repos.templates.update(TEMPLATE_ID, { description: 'x' }, 1);
      expect(updated.version).toBe(2);
      const stale = await uow.repos.templates
        .update(TEMPLATE_ID, { description: 'y' }, 1)
        .catch((e: unknown) => e);
      expect(isAppError(stale, 'CONFLICT')).toBe(true);
      const taken = await uow.repos.templates
        .update(TEMPLATE_ID, { name: 'other' })
        .catch((e: unknown) => e);
      expect(isAppError(taken, 'TEMPLATE_NAME_TAKEN')).toBe(true);
      await uow.repos.templates.touchLastUsed(TEMPLATE_ID, 42);
      expect((await uow.repos.templates.get(TEMPLATE_ID))?.lastUsedAt).toBe(42);
      expect((await uow.repos.templates.get(TEMPLATE_ID))?.version).toBe(2);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });
});
