/** @module infra/persistence/repositories/identity — SQLite `PrincipalRepository` and `CredentialRepository`. */

import type { Kysely } from 'kysely';
import type { CredentialKind, PrincipalKind } from '../../../ports/persistence/enums.ts';
import type {
  CredentialRepository,
  PrincipalPatch,
  PrincipalRepository,
} from '../../../ports/persistence/identity.ts';
import type { CredentialRecord, PrincipalRecord } from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import {
  credentialFromRow,
  credentialToRow,
  principalFromRow,
  principalPatchToRow,
  principalToRow,
} from '../mappers/identity.ts';

/** SQLite implementation of {@link PrincipalRepository}. */
export class SqlitePrincipalRepository implements PrincipalRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: PrincipalRecord): Promise<void> {
    await this.#db
      .insertInto('principals')
      .values(principalToRow(record))
      .onConflict((oc) => oc.column('principal_id').doNothing())
      .execute();
  }

  async get(principalId: string): Promise<PrincipalRecord | null> {
    const row = await this.#db
      .selectFrom('principals')
      .selectAll()
      .where('principal_id', '=', principalId)
      .executeTakeFirst();
    return row === undefined ? null : principalFromRow(row);
  }

  async list(kind?: PrincipalKind): Promise<readonly PrincipalRecord[]> {
    let qb = this.#db.selectFrom('principals').selectAll();
    if (kind !== undefined) qb = qb.where('kind', '=', kind);
    const rows = await qb.orderBy('created_at', 'asc').orderBy('principal_id', 'asc').execute();
    return rows.map(principalFromRow);
  }

  async update(principalId: string, patch: PrincipalPatch): Promise<boolean> {
    const row = principalPatchToRow(patch);
    if (Object.keys(row).length === 0) return false;
    const result = await this.#db
      .updateTable('principals')
      .set(row)
      .where('principal_id', '=', principalId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

/** SQLite implementation of {@link CredentialRepository}. */
export class SqliteCredentialRepository implements CredentialRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: CredentialRecord): Promise<void> {
    await this.#db
      .insertInto('credentials')
      .values(credentialToRow(record))
      .onConflict((oc) => oc.column('credential_id').doNothing())
      .execute();
  }

  async get(credentialId: string): Promise<CredentialRecord | null> {
    const row = await this.#db
      .selectFrom('credentials')
      .selectAll()
      .where('credential_id', '=', credentialId)
      .executeTakeFirst();
    return row === undefined ? null : credentialFromRow(row);
  }

  async findByPrefix(publicPrefix: string): Promise<CredentialRecord | null> {
    const row = await this.#db
      .selectFrom('credentials')
      .selectAll()
      .where('public_prefix', '=', publicPrefix)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : credentialFromRow(row);
  }

  async listByPrincipal(
    principalId: string,
    kind?: CredentialKind,
  ): Promise<readonly CredentialRecord[]> {
    let qb = this.#db.selectFrom('credentials').selectAll().where('principal_id', '=', principalId);
    if (kind !== undefined) qb = qb.where('kind', '=', kind);
    const rows = await qb.orderBy('created_at', 'asc').orderBy('credential_id', 'asc').execute();
    return rows.map(credentialFromRow);
  }

  async listActive(kind: CredentialKind): Promise<readonly CredentialRecord[]> {
    const rows = await this.#db
      .selectFrom('credentials')
      .selectAll()
      .where('kind', '=', kind)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .orderBy('credential_id', 'asc')
      .execute();
    return rows.map(credentialFromRow);
  }

  async replaceSecret(credentialId: string, secretHash: string): Promise<boolean> {
    const result = await this.#db
      .updateTable('credentials')
      .set({ secret_hash: secretHash })
      .where('credential_id', '=', credentialId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async touch(credentialId: string, at: number): Promise<void> {
    await this.#db
      .updateTable('credentials')
      .set({ last_used_at: at })
      .where('credential_id', '=', credentialId)
      .execute();
  }

  async revoke(credentialId: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('credentials')
      .set({ revoked_at: at })
      .where('credential_id', '=', credentialId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
