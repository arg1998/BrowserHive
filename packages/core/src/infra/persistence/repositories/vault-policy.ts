/** @module infra/persistence/repositories/vault-policy — SQLite `VaultBindingRepository` and `VaultGroupPolicyRepository` (optimistic versions). */

import { type Kysely, sql } from 'kysely';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { Page, VaultBindingListQuery } from '../../../ports/persistence/queries.ts';
import type {
  VaultBindingRecord,
  VaultExportDocument,
  VaultGroupPolicyRecord,
} from '../../../ports/persistence/records.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
  VaultImportMode,
  VaultImportResult,
} from '../../../ports/persistence/vault-policy.ts';
import type { DB } from '../generated/db.d.ts';
import {
  vaultBindingFromRow,
  vaultBindingToRow,
  vaultGroupPolicyFromRow,
  vaultGroupPolicyToRow,
} from '../mappers/vault-policy.ts';
import { asNumber, clampLimit, decodeCursor, like, toPage } from './common.ts';

const BINDINGS = 'vault_bindings';

function conflict(current: number | undefined): AppError {
  return new AppError('CONFLICT', { ...(current !== undefined && { current_version: current }) });
}

/** Runs `fn` in a transaction unless `db` already is one. */
async function inTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.isTransaction ? fn(db) : db.transaction().execute(fn);
}

/** SQLite implementation of {@link VaultBindingRepository}. */
export class SqliteVaultBindingRepository implements VaultBindingRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(query: VaultBindingListQuery): Promise<Page<VaultBindingRecord>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(BINDINGS, query.cursor);
    let qb = this.#db.selectFrom('vault_bindings').selectAll();
    if (query.groupId !== undefined) {
      qb =
        query.groupId === null
          ? qb.where('group_id', 'is', null)
          : qb.where('group_id', '=', query.groupId);
    }
    if (query.q !== undefined && query.q !== '') {
      const term = query.q;
      qb = qb.where((eb) =>
        eb.or([
          like(sql.ref('handle'), term),
          like(sql.ref('title'), term),
          like(sql.ref('item_name'), term),
        ]),
      );
    }
    if (cursor !== null) qb = qb.where('handle', '>', cursor.id);
    const rows = await qb
      .orderBy('handle', 'asc')
      .limit(limit + 1)
      .execute();
    return toPage(BINDINGS, rows, limit, vaultBindingFromRow, (row) => ({
      key: row.handle,
      id: row.handle,
    }));
  }

  async get(handle: string): Promise<VaultBindingRecord | null> {
    const row = await this.#db
      .selectFrom('vault_bindings')
      .selectAll()
      .where('handle', '=', handle)
      .executeTakeFirst();
    return row === undefined ? null : vaultBindingFromRow(row);
  }

  async upsert(binding: VaultBindingRecord, ifVersion?: number): Promise<VaultBindingRecord> {
    const row = vaultBindingToRow(binding);
    const { handle: _handle, version: _version, created_at: _created, ...updatable } = row;
    if (ifVersion === undefined) {
      await this.#db
        .insertInto('vault_bindings')
        .values({ ...row, version: 1 })
        .onConflict((oc) =>
          oc
            .column('handle')
            .doUpdateSet({ ...updatable, version: sql`vault_bindings.version + 1` }),
        )
        .execute();
    } else if (ifVersion === 0) {
      const result = await this.#db
        .insertInto('vault_bindings')
        .values({ ...row, version: 1 })
        .onConflict((oc) => oc.column('handle').doNothing())
        .executeTakeFirst();
      if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n)
        throw conflict((await this.get(binding.handle))?.version);
    } else {
      const result = await this.#db
        .updateTable('vault_bindings')
        .set({ ...updatable, version: ifVersion + 1 })
        .where('handle', '=', binding.handle)
        .where('version', '=', ifVersion)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw conflict((await this.get(binding.handle))?.version);
    }
    const stored = await this.get(binding.handle);
    if (stored === null) throw new AppError('INTERNAL_ERROR', { ref: 'vault-binding-upsert' });
    return stored;
  }

  async remove(handle: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('vault_bindings')
      .where('handle', '=', handle)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async exportAll(): Promise<VaultExportDocument> {
    const bindings = await this.#db
      .selectFrom('vault_bindings')
      .selectAll()
      .orderBy('handle', 'asc')
      .execute();
    const policies = await this.#db
      .selectFrom('vault_group_policies')
      .selectAll()
      .orderBy('group_key', 'asc')
      .execute();
    return {
      version: 3,
      bindings: bindings.map(vaultBindingFromRow),
      policies: policies.map(vaultGroupPolicyFromRow),
    };
  }

  async importAll(doc: VaultExportDocument, mode: VaultImportMode): Promise<VaultImportResult> {
    return inTransaction(this.#db, async (trx) => {
      if (mode === 'replace') {
        await trx.deleteFrom('vault_bindings').execute();
        await trx.deleteFrom('vault_group_policies').execute();
      }
      const bindings = new SqliteVaultBindingRepository(trx);
      const policies = new SqliteVaultGroupPolicyRepository(trx);
      for (const binding of doc.bindings) await bindings.upsert(binding);
      for (const policy of doc.policies) await policies.upsert(policy);
      return { bindings: doc.bindings.length, policies: doc.policies.length };
    });
  }

  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('vault_bindings')
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}

/** SQLite implementation of {@link VaultGroupPolicyRepository}. */
export class SqliteVaultGroupPolicyRepository implements VaultGroupPolicyRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(): Promise<readonly VaultGroupPolicyRecord[]> {
    const rows = await this.#db
      .selectFrom('vault_group_policies')
      .selectAll()
      .orderBy('group_key', 'asc')
      .execute();
    return rows.map(vaultGroupPolicyFromRow);
  }

  async get(groupKey: string): Promise<VaultGroupPolicyRecord | null> {
    const row = await this.#db
      .selectFrom('vault_group_policies')
      .selectAll()
      .where('group_key', '=', groupKey)
      .executeTakeFirst();
    return row === undefined ? null : vaultGroupPolicyFromRow(row);
  }

  async upsert(
    policy: VaultGroupPolicyRecord,
    ifVersion?: number,
  ): Promise<VaultGroupPolicyRecord> {
    const row = vaultGroupPolicyToRow(policy);
    const { group_key: _key, version: _version, created_at: _created, ...updatable } = row;
    if (ifVersion === undefined) {
      await this.#db
        .insertInto('vault_group_policies')
        .values({ ...row, version: 1 })
        .onConflict((oc) =>
          oc
            .column('group_key')
            .doUpdateSet({ ...updatable, version: sql`vault_group_policies.version + 1` }),
        )
        .execute();
    } else if (ifVersion === 0) {
      const result = await this.#db
        .insertInto('vault_group_policies')
        .values({ ...row, version: 1 })
        .onConflict((oc) => oc.column('group_key').doNothing())
        .executeTakeFirst();
      if ((result.numInsertedOrUpdatedRows ?? 0n) === 0n)
        throw conflict((await this.get(policy.groupKey))?.version);
    } else {
      const result = await this.#db
        .updateTable('vault_group_policies')
        .set({ ...updatable, version: ifVersion + 1 })
        .where('group_key', '=', policy.groupKey)
        .where('version', '=', ifVersion)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw conflict((await this.get(policy.groupKey))?.version);
    }
    const stored = await this.get(policy.groupKey);
    if (stored === null) throw new AppError('INTERNAL_ERROR', { ref: 'vault-policy-upsert' });
    return stored;
  }

  async remove(groupKey: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom('vault_group_policies')
      .where('group_key', '=', groupKey)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('vault_group_policies')
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}
