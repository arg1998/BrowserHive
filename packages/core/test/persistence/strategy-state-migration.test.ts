/** @module test/persistence/strategy-state-migration.test — schema v12 (`0012-strategy-state`, D53) over a v11 database: the table is added empty, the minimum reader stays 10 (compatible) and a v11 binary still opens the database and deletes templates; the repository upserts, lists and removes rows; deleting a template removes its rows (FK cascade); and the store over real SQLite keeps a budget across a reopen and discards a corrupt row with a warning. */

import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { StrategyState } from '../../src/app/site-packs/strategy-state.ts';
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import type { StrategyStateRecord } from '../../src/ports/persistence/strategy-state.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../helpers/test-logger.ts';
import { FakeClock, FakeLogger, TEMPLATE_ID, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const AT = 1_700_000_000_000;

async function openCopy(fixture: string, dir = tempDir(), clock = new FakeClock(AT)) {
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  return { dir, path, ...(await openAt(path, dir.path, clock)) };
}

async function openAt(path: string, dataDir: string, clock = new FakeClock(AT)) {
  const handle = await openDatabase({
    path,
    dataDir,
    appVersion: 'test',
    clock,
    logger: new FakeLogger(),
  });
  return { handle, uow: new SqliteUnitOfWork(handle.db) };
}

function record(overrides: Partial<StrategyStateRecord> = {}): StrategyStateRecord {
  return {
    templateId: TEMPLATE_ID,
    strategy: 'pace-writes',
    packId: 'linkedin.com',
    scopeKey: 'invites',
    stateJson: JSON.stringify({ tokens: 0, at: AT, capacity: 5, period_ms: 3_600_000 }),
    updatedAt: AT,
    ...overrides,
  };
}

describe('migration 0012-strategy-state', () => {
  it('upgrades a v11 database: an empty table, reader unchanged', async () => {
    const { dir, handle, uow } = await openCopy('v11.db');
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      expect(await uow.repos.strategyState.list()).toEqual([]);
      expect(MIGRATIONS.find((m) => m.version === 12)?.compatible).toBe(true);
      expect(handle.minReaderVersion).toBe(10);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('a v11 binary still opens the upgraded database and deletes a template with state', async () => {
    const { dir, path, handle, uow } = await openCopy('v11.db');
    await uow.repos.strategyState.put(record());
    await handle.close();
    try {
      const older = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'v11-binary',
        clock: new FakeClock(),
        logger: new FakeLogger(),
        migrations: MIGRATIONS.filter((m) => m.version <= 11),
      });
      try {
        older.raw.run('DELETE FROM templates WHERE template_id = ?', [TEMPLATE_ID]);
        const left = older.raw
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM template_strategy_state')
          .get();
        expect(left?.n).toBe(0);
      } finally {
        await older.close();
      }
    } finally {
      dir.dispose();
    }
  });

  it('puts, replaces, lists and removes rows; a template deletion removes its rows', async () => {
    const { dir, handle, uow } = await openCopy('v12.db');
    try {
      const repo = uow.repos.strategyState;
      // The v12 fixture's seeded launch turn.
      expect((await repo.list()).map((r) => r.strategy)).toEqual(['launch-spacing']);
      await repo.put(record());
      await repo.put(record({ stateJson: '{"tokens":1}', updatedAt: AT + 1 }));
      const rows = await repo.list();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.strategy === 'pace-writes')).toEqual(
        record({ stateJson: '{"tokens":1}', updatedAt: AT + 1 }),
      );
      expect(await repo.remove(record())).toBe(true);
      expect(await repo.remove(record())).toBe(false);
      // A row of a template that does not exist is refused (FK).
      await expect(repo.put(record({ templateId: 'tp-missing01' }))).rejects.toThrow();

      await repo.put(record());
      expect(await uow.repos.templates.remove(TEMPLATE_ID)).toBe(true);
      expect(await repo.list()).toEqual([]);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('the store keeps a budget across a reopen and discards a corrupt row with a warning', async () => {
    const clock = new FakeClock(AT);
    const { dir, path, handle, uow } = await openCopy('v12.db', tempDir(), clock);
    try {
      const bus = new RecordingEventBus<DomainEvents>();
      const first = new StrategyState({
        repo: uow.repos.strategyState,
        clock,
        logger: createCollectingLogger(),
        bus,
      });
      await first.restore();
      first.set(
        'pace-writes',
        { templateId: TEMPLATE_ID, packId: 'linkedin.com', scopeKey: 'invites' },
        { tokens: 1, at: AT, capacity: 5, periodMs: 3_600_000 },
        'now',
      );
      await first.stop();
      handle.raw.run(
        "UPDATE template_strategy_state SET state_json = '{oops' WHERE strategy = 'launch-spacing'",
      );
      await handle.close();

      const reopened = await openAt(path, dir.path, clock);
      try {
        const logger = createCollectingLogger();
        const second = new StrategyState({
          repo: reopened.uow.repos.strategyState,
          clock,
          logger,
          bus,
        });
        await second.restore();
        expect(
          second.get('pace-writes', {
            templateId: TEMPLATE_ID,
            packId: 'linkedin.com',
            scopeKey: 'invites',
          }),
        ).toEqual({ tokens: 1, at: AT, capacity: 5, periodMs: 3_600_000 });
        expect(second.get('launch-spacing', { templateId: TEMPLATE_ID })).toBeUndefined();
        expect(logger.has('strategy row discarded')).toBe(true);
        await second.stop();
        expect((await reopened.uow.repos.strategyState.list()).map((r) => r.strategy)).toEqual([
          'pace-writes',
        ]);
      } finally {
        await reopened.handle.close();
      }
    } finally {
      dir.dispose();
    }
  });
});
