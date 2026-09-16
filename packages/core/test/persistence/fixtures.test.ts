/** @module test/persistence/fixtures.test — every shipped fixture DB upgrades to head and fingerprints like a fresh install. */

import { describe, expect, it } from 'bun:test';
import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { schemaFingerprint } from './fingerprint.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const fixtures = readdirSync(FIXTURES).filter((f) => /^v\d+\.db$/.test(f));

describe('fixture databases', () => {
  it('ships one fixture per schema version', () => {
    expect(fixtures).toContain(`v${SCHEMA_VERSION}.db`);
  });

  for (const fixture of fixtures) {
    it(`${fixture} replays through the runner and matches a fresh install`, async () => {
      const dir = tempDir();
      try {
        const path = join(dir.path, 'browserhive.db');
        copyFileSync(join(FIXTURES, fixture), path);
        const upgraded = await openDatabase({
          path,
          dataDir: dir.path,
          appVersion: 'test',
          clock: new FakeClock(),
          logger: new FakeLogger(),
        });
        const fresh = await openDatabase({
          path: ':memory:',
          dataDir: dir.path,
          appVersion: 'test',
          clock: new FakeClock(),
          logger: new FakeLogger(),
        });
        expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
        expect(schemaFingerprint(upgraded.raw)).toEqual(schemaFingerprint(fresh.raw));
        const sessions = await upgraded.db.selectFrom('sessions').select('session_id').execute();
        expect(sessions.length).toBeGreaterThan(0);
        await fresh.close();
        await upgraded.close();
      } finally {
        dir.dispose();
      }
    });
  }
});
