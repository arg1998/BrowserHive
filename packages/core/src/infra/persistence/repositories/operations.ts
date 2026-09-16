/** @module infra/persistence/repositories/operations — SQLite system events, idempotency, artifact outbox, MCP connections, schema migrations. */

import { type Kysely, sql } from 'kysely';
import type {
  ArtifactOutboxRepository,
  IdempotencyRepository,
  McpConnectionPatch,
  McpConnectionRepository,
  SchemaMigrationRepository,
  SystemEventRepository,
} from '../../../ports/persistence/operations.ts';
import type { Page, SystemEventListQuery } from '../../../ports/persistence/queries.ts';
import type {
  ArtifactOutboxRecord,
  IdempotencyRecord,
  McpConnectionRecord,
  NewArtifact,
  NewSystemEvent,
  SchemaMigrationRecord,
  SystemEventRecord,
} from '../../../ports/persistence/records.ts';
import type { DB } from '../generated/db.d.ts';
import { toJsonOrNull } from '../mappers/codec.ts';
import {
  artifactFromRow,
  artifactToRow,
  idempotencyFromRow,
  idempotencyToRow,
  mcpConnectionFromRow,
  mcpConnectionPatchToRow,
  mcpConnectionToRow,
  schemaMigrationFromRow,
  systemEventFromRow,
} from '../mappers/operations.ts';
import { asNumber, clampLimit, decodeCursor, toPage } from './common.ts';

const SYSTEM_EVENTS = 'system_events';

/** SQLite implementation of {@link SystemEventRepository}. */
export class SqliteSystemEventRepository implements SystemEventRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async record(event: NewSystemEvent): Promise<SystemEventRecord> {
    const details = toJsonOrNull(event.details);
    let open = this.#db
      .selectFrom('system_events')
      .selectAll()
      .where('code', '=', event.code)
      .where('resolved_at', 'is', null);
    open =
      details === null
        ? open.where('details_json', 'is', null)
        : open.where('details_json', '=', details);
    const existing = await open.orderBy('seq', 'desc').executeTakeFirst();
    if (existing !== undefined) {
      await this.#db
        .updateTable('system_events')
        .set({
          count: existing.count + 1,
          last_seen_at: event.at,
          message: event.message,
          severity: event.severity,
        })
        .where('seq', '=', existing.seq)
        .execute();
      return systemEventFromRow({
        ...existing,
        count: existing.count + 1,
        last_seen_at: event.at,
        message: event.message,
        severity: event.severity,
      });
    }
    const result = await this.#db
      .insertInto('system_events')
      .values({
        event_id: event.eventId,
        code: event.code,
        severity: event.severity,
        message: event.message,
        details_json: details,
        first_seen_at: event.at,
        last_seen_at: event.at,
      })
      .executeTakeFirst();
    const row = await this.#db
      .selectFrom('system_events')
      .selectAll()
      .where('seq', '=', Number(result.insertId ?? 0n))
      .executeTakeFirst();
    if (row === undefined) throw new Error('system_events insert did not return a row');
    return systemEventFromRow(row);
  }

  async resolve(code: string, at: number): Promise<number> {
    const result = await this.#db
      .updateTable('system_events')
      .set({ resolved_at: at })
      .where('code', '=', code)
      .where('resolved_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async list(query: SystemEventListQuery): Promise<Page<SystemEventRecord>> {
    const limit = clampLimit(query.limit);
    const dir = query.dir ?? 'desc';
    const cursor = decodeCursor(SYSTEM_EVENTS, query.cursor);
    let qb = this.#db.selectFrom('system_events').selectAll();
    if (query.severities !== undefined && query.severities.length > 0)
      qb = qb.where('severity', 'in', [...query.severities]);
    if (query.openOnly === true) qb = qb.where('resolved_at', 'is', null);
    if (query.since !== undefined) qb = qb.where('last_seen_at', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('last_seen_at', '<=', query.until);
    if (cursor !== null) qb = qb.where('seq', dir === 'desc' ? '<' : '>', Number(cursor.key));
    const rows = await qb
      .orderBy('seq', dir)
      .limit(limit + 1)
      .execute();
    return toPage(SYSTEM_EVENTS, rows, limit, systemEventFromRow, (row) => ({
      key: row.seq,
      id: row.event_id,
    }));
  }

  async open(): Promise<readonly SystemEventRecord[]> {
    const rows = await this.#db
      .selectFrom('system_events')
      .selectAll()
      .where('resolved_at', 'is', null)
      .orderBy('seq', 'asc')
      .execute();
    return rows.map(systemEventFromRow);
  }
}

/** SQLite implementation of {@link IdempotencyRepository}. */
export class SqliteIdempotencyRepository implements IdempotencyRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async put(record: IdempotencyRecord): Promise<boolean> {
    const result = await this.#db
      .insertInto('idempotency_keys')
      .values(idempotencyToRow(record))
      .onConflict((oc) => oc.column('key').doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async get(key: string, principalId: string, route: string): Promise<IdempotencyRecord | null> {
    const row = await this.#db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('key', '=', key)
      .where('principal_id', '=', principalId)
      .where('route', '=', route)
      .executeTakeFirst();
    return row === undefined ? null : idempotencyFromRow(row);
  }

  async pruneOlderThan(before: number): Promise<number> {
    const result = await this.#db
      .deleteFrom('idempotency_keys')
      .where('created_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

/** SQLite implementation of {@link ArtifactOutboxRepository}. */
export class SqliteArtifactOutboxRepository implements ArtifactOutboxRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async enqueue(artifact: NewArtifact): Promise<number> {
    const result = await this.#db
      .insertInto('artifact_outbox')
      .values(artifactToRow(artifact))
      .executeTakeFirst();
    return Number(result.insertId ?? 0n);
  }

  async pending(limit: number): Promise<readonly ArtifactOutboxRecord[]> {
    const rows = await this.#db
      .selectFrom('artifact_outbox')
      .selectAll()
      .orderBy('enqueued_at', 'asc')
      .orderBy('outbox_id', 'asc')
      .limit(clampLimit(limit, 100, 1000))
      .execute();
    return rows.map(artifactFromRow);
  }

  async markFailed(outboxId: number, error: string): Promise<void> {
    await this.#db
      .updateTable('artifact_outbox')
      .set({ attempts: sql`attempts + 1`, last_error: error })
      .where('outbox_id', '=', outboxId)
      .execute();
  }

  async remove(outboxId: number): Promise<void> {
    await this.#db.deleteFrom('artifact_outbox').where('outbox_id', '=', outboxId).execute();
  }

  async count(): Promise<number> {
    const row = await this.#db
      .selectFrom('artifact_outbox')
      .select(sql<number>`COUNT(*)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}

/** SQLite implementation of {@link McpConnectionRepository}. */
export class SqliteMcpConnectionRepository implements McpConnectionRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async insert(record: McpConnectionRecord): Promise<void> {
    await this.#db
      .insertInto('mcp_connections')
      .values(mcpConnectionToRow(record))
      .onConflict((oc) => oc.column('connection_id').doNothing())
      .execute();
  }

  async update(connectionId: string, patch: McpConnectionPatch): Promise<boolean> {
    const row = mcpConnectionPatchToRow(patch);
    if (Object.keys(row).length === 0) return false;
    const result = await this.#db
      .updateTable('mcp_connections')
      .set(row)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async get(connectionId: string): Promise<McpConnectionRecord | null> {
    const row = await this.#db
      .selectFrom('mcp_connections')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    return row === undefined ? null : mcpConnectionFromRow(row);
  }

  async listOpen(): Promise<readonly McpConnectionRecord[]> {
    const rows = await this.#db
      .selectFrom('mcp_connections')
      .selectAll()
      .where('closed_at', 'is', null)
      .orderBy('last_seen_at', 'desc')
      .orderBy('connection_id', 'desc')
      .execute();
    return rows.map(mcpConnectionFromRow);
  }

  async closeAll(at: number): Promise<number> {
    const result = await this.#db
      .updateTable('mcp_connections')
      .set({ closed_at: at })
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

/** SQLite implementation of {@link SchemaMigrationRepository}. */
export class SqliteSchemaMigrationRepository implements SchemaMigrationRepository {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async list(): Promise<readonly SchemaMigrationRecord[]> {
    const rows = await this.#db
      .selectFrom('schema_migrations')
      .selectAll()
      .orderBy('version', 'asc')
      .execute();
    return rows.map(schemaMigrationFromRow);
  }

  async currentVersion(): Promise<number> {
    const row = await this.#db
      .selectFrom('schema_migrations')
      .select(sql<number>`COALESCE(MAX(version), 0)`.as('n'))
      .executeTakeFirst();
    return asNumber(row?.n);
  }
}
