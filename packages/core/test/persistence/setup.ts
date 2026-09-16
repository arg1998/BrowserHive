/** @module test/persistence/setup — opens an in-memory database with repositories for conformance suites. */

import { SqliteAnalyticsQueries } from '../../src/infra/persistence/analytics.ts';
import type { DatabaseHandle } from '../../src/infra/persistence/open.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import type { AnalyticsQueries } from '../../src/ports/persistence/analytics.ts';
import type { Repositories } from '../../src/ports/persistence/unit-of-work.ts';
import { FakeClock, FakeLogger } from './helpers.ts';

/** Everything a conformance test needs. */
export interface TestDb {
  readonly handle: DatabaseHandle;
  readonly repos: Repositories;
  readonly uow: SqliteUnitOfWork;
  readonly analytics: AnalyticsQueries;
  readonly clock: FakeClock;
  readonly logger: FakeLogger;
  close(): Promise<void>;
}

/** Opens `:memory:` migrated to head. */
export async function openMemory(): Promise<TestDb> {
  const clock = new FakeClock();
  const logger = new FakeLogger();
  const handle = await openDatabase({
    path: ':memory:',
    dataDir: '/nonexistent',
    appVersion: '0.1.0-test',
    clock,
    logger,
  });
  const uow = new SqliteUnitOfWork(handle.db);
  return {
    handle,
    repos: uow.repos,
    uow,
    analytics: new SqliteAnalyticsQueries(handle.db, uow.repos),
    clock,
    logger,
    close: () => handle.close(),
  };
}
