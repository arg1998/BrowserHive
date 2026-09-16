/** @module infra/persistence/repositories/auth — SQLite `AuthSessionRepository`, `GrantRepository`, `AuthEventRepository`. */

import type { Kysely } from 'kysely';
import type {
  AuthEventRepository,
  AuthSessionRepository,
  GrantRepository,
} from '../../../ports/persistence/identity.ts';
import type { AuditListQuery, Page } from '../../../ports/persistence/queries.ts';
import type {
  AuthEventRecord,
  AuthSessionRecord,
  GrantRecord,
  NewAuthEvent,
} from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import {
  authEventFromRow,
  authEventToRow,
  authSessionFromRow,
  authSessionToRow,
  grantFromRow,
  grantToRow,
} from '../mappers/identity.ts';
import { clampLimit, decodeCursor, toPage } from './common.ts';

/** SQLite implementation of {@link AuthSessionRepository}. */
export class SqliteAuthSessionRepository implements AuthSessionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: AuthSessionRecord): Promise<void> {
    await this.#db
      .insertInto('auth_sessions')
      .values(authSessionToRow(record))
      .onConflict((oc) => oc.column('auth_session_id').doNothing())
      .execute();
  }

  async get(authSessionId: string): Promise<AuthSessionRecord | null> {
    const row = await this.#db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('auth_session_id', '=', authSessionId)
      .executeTakeFirst();
    return row === undefined ? null : authSessionFromRow(row);
  }

  async findByTokenHash(tokenHash: string, now: number): Promise<AuthSessionRecord | null> {
    const row = await this.#db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    return row === undefined ? null : authSessionFromRow(row);
  }

  async listActive(principalId: string): Promise<readonly AuthSessionRecord[]> {
    const rows = await this.#db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('principal_id', '=', principalId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .orderBy('auth_session_id', 'desc')
      .execute();
    return rows.map(authSessionFromRow);
  }

  async touch(authSessionId: string, at: number, expiresAt?: number): Promise<void> {
    await this.#db
      .updateTable('auth_sessions')
      .set({ last_seen_at: at, ...(expiresAt !== undefined && { expires_at: expiresAt }) })
      .where('auth_session_id', '=', authSessionId)
      .execute();
  }

  async revoke(authSessionId: string, at: number): Promise<boolean> {
    const result = await this.#db
      .updateTable('auth_sessions')
      .set({ revoked_at: at })
      .where('auth_session_id', '=', authSessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async revokeAll(principalId: string, at: number, keep?: string): Promise<number> {
    let qb = this.#db
      .updateTable('auth_sessions')
      .set({ revoked_at: at })
      .where('principal_id', '=', principalId)
      .where('revoked_at', 'is', null);
    if (keep !== undefined) qb = qb.where('auth_session_id', '<>', keep);
    return Number((await qb.executeTakeFirst()).numUpdatedRows);
  }

  async pruneExpired(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('auth_sessions')
      .where((eb) => eb.or([eb('expires_at', '<', before), eb('revoked_at', '<', before)]))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** SQLite implementation of {@link GrantRepository}. */
export class SqliteGrantRepository implements GrantRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: GrantRecord): Promise<void> {
    await this.#db
      .insertInto('grants')
      .values(grantToRow(record))
      .onConflict((oc) => oc.column('grant_id').doNothing())
      .execute();
  }

  async findByTokenHash(tokenHash: string, now: number): Promise<GrantRecord | null> {
    const row = await this.#db
      .selectFrom('grants')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    return row === undefined ? null : grantFromRow(row);
  }

  async markUsed(grantId: string, at: number): Promise<void> {
    await this.#db
      .updateTable('grants')
      .set({ used_at: at })
      .where('grant_id', '=', grantId)
      .execute();
  }

  async pruneExpired(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('grants')
      .where('expires_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

const AUTH_EVENTS = 'auth_events';

/** SQLite implementation of {@link AuthEventRepository}. */
export class SqliteAuthEventRepository implements AuthEventRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async append(event: NewAuthEvent): Promise<number> {
    const result = await this.#db
      .insertInto('auth_events')
      .values(authEventToRow(event))
      .onConflict((oc) => oc.column('event_id').doNothing())
      .executeTakeFirst();
    if (result.numInsertedOrUpdatedRows !== undefined && result.numInsertedOrUpdatedRows > 0n) {
      return Number(result.insertId ?? 0n);
    }
    const existing = await this.#db
      .selectFrom('auth_events')
      .select('seq')
      .where('event_id', '=', event.eventId)
      .executeTakeFirst();
    return existing?.seq ?? 0;
  }

  async list(query: AuditListQuery): Promise<Page<AuthEventRecord>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(AUTH_EVENTS, query.cursor);
    let qb = this.#db.selectFrom('auth_events').selectAll();
    if (query.principalId !== undefined) qb = qb.where('principal_id', '=', query.principalId);
    if (query.types !== undefined && query.types.length > 0)
      qb = qb.where('type', 'in', [...query.types]);
    if (query.since !== undefined) qb = qb.where('occurred_at', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('occurred_at', '<=', query.until);
    if (cursor !== null) qb = qb.where('seq', dir === 'desc' ? '<' : '>', Number(cursor.key));
    const rows = await qb
      .orderBy('seq', dir)
      .limit(limit + 1)
      .execute();
    return toPage(AUTH_EVENTS, rows, limit, authEventFromRow, (row) => ({
      key: row.seq,
      id: row.event_id,
    }));
  }
}
