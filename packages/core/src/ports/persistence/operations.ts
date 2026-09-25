/** @module ports/persistence/operations — system events, idempotency, artifact outbox, MCP connections, migrations, operator actions. */

import type { AuditListQuery, Page, SystemEventListQuery } from './queries.ts';
import type {
  ArtifactOutboxRecord,
  IdempotencyRecord,
  LogRecordRow,
  McpConnectionRecord,
  NewArtifact,
  NewOperatorAction,
  NewSystemEvent,
  OperatorActionRecord,
  SchemaMigrationRecord,
  SystemEventRecord,
} from './records.ts';

/** Repository over `system_events` (degradations, spec 10 §3). */
export interface SystemEventRepository {
  /**
   * Records an occurrence: when an unresolved row with the same `code` and `fingerprint`
   * exists, bumps `count` and `last_seen_at`; otherwise inserts. Returns the stored row.
   */
  record(event: NewSystemEvent): Promise<SystemEventRecord>;
  /** Resolves every open row with this `code`; returns the count. */
  resolve(code: string, at: number): Promise<number>;
  /** Lists rows newest first (`GET /system/events`). */
  list(query: SystemEventListQuery): Promise<Page<SystemEventRecord>>;
  /** Unresolved rows, oldest first. */
  open(): Promise<readonly SystemEventRecord[]>;
}

/** Repository over `idempotency_keys`. */
export interface IdempotencyRepository {
  /** Stores a response; returns false when the key already existed (the stored one wins). */
  put(record: IdempotencyRecord): Promise<boolean>;
  /** Stored response for a key owned by the principal on this route, or `null`. */
  get(key: string, principalId: string, route: string): Promise<IdempotencyRecord | null>;
  /** Deletes keys created before `before`; returns the count. */
  pruneOlderThan(before: number): Promise<number>;
}

/** Repository over `artifact_outbox`. */
export interface ArtifactOutboxRepository {
  /** Enqueues a file for deletion and returns its id. */
  enqueue(artifact: NewArtifact): Promise<number>;
  /** Oldest pending entries (`limit` clamped to 1..1000). */
  pending(limit: number): Promise<readonly ArtifactOutboxRecord[]>;
  /** Records a failed attempt. */
  markFailed(outboxId: number, error: string): Promise<void>;
  /** Removes a completed entry. */
  remove(outboxId: number): Promise<void>;
  /** Number of pending entries. */
  count(): Promise<number>;
}

/** Mutable subset of an MCP connection. */
export type McpConnectionPatch = Partial<
  Pick<
    McpConnectionRecord,
    | 'principalId'
    | 'mcpSessionId'
    | 'clientName'
    | 'clientVersion'
    | 'protocolVersion'
    | 'capabilities'
    | 'clientTitle'
    | 'workspace'
    | 'agentName'
    | 'model'
    | 'modelSource'
    | 'harness'
    | 'harnessSource'
    | 'conflicts'
    | 'meta'
    | 'ip'
    | 'userAgent'
    | 'lastSeenAt'
    | 'closedAt'
  >
>;

/** Repository over `mcp_connections`. */
export interface McpConnectionRepository {
  /** Inserts a connection; duplicate id is ignored. */
  insert(record: McpConnectionRecord): Promise<void>;
  /** Applies a partial update; returns true when a row changed. */
  update(connectionId: string, patch: McpConnectionPatch): Promise<boolean>;
  /** Fetches one connection or `null`. */
  get(connectionId: string): Promise<McpConnectionRecord | null>;
  /** Connections not yet closed, most recently seen first. */
  listOpen(): Promise<readonly McpConnectionRecord[]>;
  /**
   * Open connections (most recently seen first), then closed ones (most recently seen first),
   * skipping `offset` rows and returning up to `limit`, each with the number of sessions it
   * launched; `live` counts every open row and `total` every row.
   */
  listRecent(
    limit: number,
    offset?: number,
  ): Promise<{
    readonly rows: readonly (McpConnectionRecord & { readonly sessions: number })[];
    readonly live: number;
    readonly total: number;
  }>;
  /** Closes every open connection (startup recovery); returns the count. */
  closeAll(at: number): Promise<number>;
}

/** Read-only view of `schema_migrations` (surfaced on `/api/v1/system`). */
export interface SchemaMigrationRepository {
  /** Applied migrations in version order. */
  list(): Promise<readonly SchemaMigrationRecord[]>;
  /** Highest applied version, or 0. */
  currentVersion(): Promise<number>;
}

/** Repository over `operator_actions` (audit class). */
export interface OperatorActionRepository {
  /** Appends an action and returns its `seq`. */
  append(action: NewOperatorAction): Promise<number>;
  /** Lists actions newest first. */
  list(query: AuditListQuery): Promise<Page<OperatorActionRecord>>;
}

/** Repository over `logs`: the durable log sink's batched inserts (spec 10 §4.3, `--logPersist`). */
export interface LogRepository {
  /** Inserts rows (their `seq` is assigned by SQLite); an empty batch is a no-op. */
  insertMany(rows: readonly Omit<LogRecordRow, 'seq'>[]): Promise<void>;
}
