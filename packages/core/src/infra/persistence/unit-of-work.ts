/** @module infra/persistence/unit-of-work — `UnitOfWork` over a Kysely transaction (`BEGIN IMMEDIATE`). */

import type { Kysely } from 'kysely';
import type { Repositories, UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import type { DB } from './generated/db.d.ts';
import { createRepositories } from './repositories/index.ts';

/** SQLite implementation of {@link UnitOfWork}; also exposes the auto-commit repositories. */
export class SqliteUnitOfWork implements UnitOfWork {
  readonly #db: Kysely<DB>;
  /** Repositories bound to the auto-commit connection. */
  readonly repos: Repositories;

  constructor(db: Kysely<DB>) {
    this.#db = db;
    this.repos = createRepositories(db);
  }

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.#db.transaction().execute((trx) => fn(createRepositories(trx)));
  }
}
