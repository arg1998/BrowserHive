/** @module test/persistence/schema-fingerprint.test — a fresh install must match the committed golden (D-04 drift). */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { schemaFingerprint } from './fingerprint.ts';
import { FakeClock, FakeLogger } from './helpers.ts';

const GOLDEN = join(import.meta.dir, 'fixtures', `schema-v${SCHEMA_VERSION}.json`);

describe('schema fingerprint', () => {
  it('matches the committed golden (UPDATE_GOLDENS=1 to bless)', async () => {
    const handle = await openDatabase({
      path: ':memory:',
      dataDir: '/nonexistent',
      appVersion: 'test',
      clock: new FakeClock(),
      logger: new FakeLogger(),
    });
    const actual = schemaFingerprint(handle.raw);
    await handle.close();
    const file = Bun.file(GOLDEN);
    // Blessing is an explicit action by the developer running the suite, not a config source.
    if (Bun.env['UPDATE_GOLDENS'] === '1' || !(await file.exists())) {
      await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected: unknown = JSON.parse(await Bun.file(GOLDEN).text());
    expect(expected).toEqual(actual);
  });

  it('covers every table of the spec', async () => {
    const handle = await openDatabase({
      path: ':memory:',
      dataDir: '/nonexistent',
      appVersion: 'test',
      clock: new FakeClock(),
      logger: new FakeLogger(),
    });
    const names = schemaFingerprint(handle.raw).tables.map((t) => t.name);
    await handle.close();
    for (const table of [
      'schema_migrations',
      'meta',
      'principals',
      'credentials',
      'auth_sessions',
      'grants',
      'auth_events',
      'mcp_connections',
      'sessions',
      'events',
      'tool_calls',
      'pages',
      'screenshots',
      'vault_access',
      'blocked_requests',
      'operator_requests',
      'operator_actions',
      'vault_bindings',
      'vault_group_policies',
      'notifications',
      'preferences',
      'system_events',
      'artifact_outbox',
      'idempotency_keys',
      'logs',
      'resource_samples',
    ]) {
      expect(names).toContain(table);
    }
  });
});
