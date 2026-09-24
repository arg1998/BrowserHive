/** @module test/helpers/in-memory-repos — Map-backed `Repositories`, `WriteQueue` and `UnitOfWork` for app-layer tests; unimplemented ports throw on use (spec 09 §4). */

import { AppError } from '../../src/kernel/errors/app-error.ts';
import type { ClosedReason } from '../../src/ports/persistence/enums.ts';
import type { EventLogRepository } from '../../src/ports/persistence/event-log.ts';
import type {
  McpConnectionPatch,
  McpConnectionRepository,
} from '../../src/ports/persistence/operations.ts';
import type { Page, SessionFacets, SessionListQuery } from '../../src/ports/persistence/queries.ts';
import type {
  EventRecord,
  McpConnectionRecord,
  NewEvent,
  SessionListRow,
  SessionPatch,
  SessionRecord,
} from '../../src/ports/persistence/records.ts';
import type {
  SessionDeleteResult,
  SessionRepository,
} from '../../src/ports/persistence/sessions.ts';
import type { Repositories, UnitOfWork } from '../../src/ports/persistence/unit-of-work.ts';
import type { WriteJob, WriteQueue } from '../../src/ports/persistence/write-queue.ts';
import {
  InMemoryNotificationRepository,
  InMemorySystemEventRepository,
} from './in-memory-repos-operations.ts';

export { InMemoryNotificationRepository, InMemorySystemEventRepository };

import {
  InMemoryBlocklistAuditRepository,
  InMemoryPageRepository,
  InMemoryScreenshotRepository,
  InMemoryToolCallRepository,
  InMemoryVaultAuditRepository,
  pageOf,
} from './in-memory-repos-facts.ts';

export {
  InMemoryBlocklistAuditRepository,
  InMemoryPageRepository,
  InMemoryScreenshotRepository,
  InMemoryToolCallRepository,
  InMemoryVaultAuditRepository,
} from './in-memory-repos-facts.ts';

/**
 * A repository this bundle does not model. Any member access yields a function that throws, so a
 * test reaching an unmodelled port fails loudly instead of silently succeeding. The `as T` here is
 * the one structural cast of the bundle: a Proxy has no static shape to satisfy.
 */
function notImplemented<T extends object>(name: string): T {
  const proxy = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new AppError(
          'INTERNAL_ERROR',
          { ref: 'in-memory-repo' },
          { message: `in-memory ${name}.${String(property)} is not implemented` },
        );
      },
    },
  );
  return proxy as T;
}

/** `sessions` in memory; `counts` are derived from the fact repos of the owning bundle. */
export class InMemorySessionRepository implements SessionRepository {
  readonly rows = new Map<string, SessionRecord>();
  /** Every patch applied, in order (assertions on recorder projections). */
  readonly patches: Array<{ sessionId: string; patch: SessionPatch }> = [];

  constructor(private readonly counts: (sessionId: string) => SessionListRow['counts']) {}

  async insert(record: SessionRecord): Promise<void> {
    if (!this.rows.has(record.sessionId)) this.rows.set(record.sessionId, record);
  }

  async update(sessionId: string, patch: SessionPatch): Promise<boolean> {
    const row = this.rows.get(sessionId);
    if (row === undefined) return false;
    this.patches.push({ sessionId, patch });
    this.rows.set(sessionId, { ...row, ...patch });
    return true;
  }

  async get(sessionId: string): Promise<SessionListRow | null> {
    const row = this.rows.get(sessionId);
    return row === undefined ? null : this.row(row);
  }

  async list(query: SessionListQuery): Promise<Page<SessionListRow>> {
    const rows = [...this.rows.values()]
      .filter((r) => query.owner === undefined || r.owner === query.owner)
      .filter((r) => query.states === undefined || query.states.includes(r.state))
      .filter((r) => {
        const archived = query.archived ?? 'exclude';
        if (archived === 'exclude') return r.archivedAt === null;
        if (archived === 'only') return r.archivedAt !== null;
        return true;
      })
      .filter((r) => {
        if (query.view === 'live') return r.closedAt === null;
        if (query.view === 'closed') return r.closedAt !== null;
        return true;
      })
      .filter(
        (r) =>
          query.harnesses === undefined ||
          query.harnesses.length === 0 ||
          query.harnesses.includes(r.harness ?? 'unknown'),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return pageOf(
      rows.map((r) => this.row(r)),
      query,
    );
  }

  async facets(_query: SessionListQuery): Promise<SessionFacets> {
    const harnesses = new Map<string, number>();
    for (const row of this.rows.values()) {
      const harness = row.harness ?? 'unknown';
      harnesses.set(harness, (harnesses.get(harness) ?? 0) + 1);
    }
    return {
      owners: [],
      channels: [],
      persistenceModes: [],
      states: [],
      harnesses: [...harnesses.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, count })),
    };
  }

  async markClosed(sessionId: string, at: number, reason: ClosedReason): Promise<boolean> {
    const row = this.rows.get(sessionId);
    if (row === undefined || row.closedAt !== null) return false;
    const state = reason === 'crash' ? 'crashed' : 'closed';
    this.rows.set(sessionId, { ...row, closedAt: at, closedReason: reason, state });
    return true;
  }

  async archive(sessionId: string, at: number): Promise<boolean> {
    const row = this.rows.get(sessionId);
    if (row === undefined) return false;
    this.rows.set(sessionId, { ...row, archivedAt: at });
    return true;
  }

  async unarchive(sessionId: string): Promise<boolean> {
    const row = this.rows.get(sessionId);
    if (row === undefined) return false;
    this.rows.set(sessionId, { ...row, archivedAt: null });
    return true;
  }

  async delete(sessionId: string, sessionDir: string): Promise<SessionDeleteResult> {
    const existed = this.rows.delete(sessionId);
    return { rows: existed ? 1 : 0, paths: existed ? [sessionDir] : [] };
  }

  async reconcileOpen(at: number, reason: ClosedReason): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.closedAt === null) {
        this.rows.set(row.sessionId, {
          ...row,
          closedAt: at,
          closedReason: reason,
          state: 'closed',
        });
        n++;
      }
    }
    return n;
  }

  /** Slug of a stored session, for the fact repos' join column. */
  slugOf(sessionId: string | null): string | null {
    return sessionId === null ? null : (this.rows.get(sessionId)?.slug ?? null);
  }

  private row(record: SessionRecord): SessionListRow {
    // `mcpConnections` is not implemented in memory, so no stored session knows its client.
    return { ...record, counts: this.counts(record.sessionId), client: null };
  }
}

/** `mcp_connections` in memory. */
export class InMemoryMcpConnectionRepository implements McpConnectionRepository {
  readonly rows = new Map<string, McpConnectionRecord>();

  constructor(private readonly sessionsOf: (connectionId: string) => number) {}

  async insert(record: McpConnectionRecord): Promise<void> {
    if (!this.rows.has(record.connectionId)) this.rows.set(record.connectionId, record);
  }

  async update(connectionId: string, patch: McpConnectionPatch): Promise<boolean> {
    const row = this.rows.get(connectionId);
    if (row === undefined) return false;
    this.rows.set(connectionId, { ...row, ...patch });
    return true;
  }

  async get(connectionId: string): Promise<McpConnectionRecord | null> {
    return this.rows.get(connectionId) ?? null;
  }

  async listOpen(): Promise<readonly McpConnectionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.closedAt === null)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  async listRecent(limit: number) {
    const rows = [...this.rows.values()]
      .sort(
        (a, b) =>
          Number(b.closedAt === null) - Number(a.closedAt === null) ||
          b.lastSeenAt - a.lastSeenAt ||
          b.connectionId.localeCompare(a.connectionId),
      )
      .slice(0, limit)
      .map((r) => ({ ...r, sessions: this.sessionsOf(r.connectionId) }));
    return { rows, live: [...this.rows.values()].filter((r) => r.closedAt === null).length };
  }

  async closeAll(at: number): Promise<number> {
    let n = 0;
    for (const [id, row] of this.rows) {
      if (row.closedAt === null) {
        this.rows.set(id, { ...row, closedAt: at });
        n += 1;
      }
    }
    return n;
  }
}

/** `events` in memory (append-only with `seq`). */
export class InMemoryEventLogRepository implements EventLogRepository {
  readonly rows: EventRecord[] = [];

  async append(event: NewEvent): Promise<number> {
    const seq = this.rows.length + 1;
    this.rows.push({ ...event, seq });
    return seq;
  }

  async replay(
    afterSeq: number,
    limit: number,
    sessionId?: string,
  ): Promise<readonly EventRecord[]> {
    return this.rows
      .filter((r) => r.seq > afterSeq && (sessionId === undefined || r.sessionId === sessionId))
      .slice(0, limit);
  }

  async head(): Promise<number> {
    return this.rows.length;
  }
}

/** `system_events` in memory, aggregated by `code` + serialised details. */
export class InMemoryRepositories implements Repositories {
  readonly sessions: InMemorySessionRepository;
  readonly toolCalls: InMemoryToolCallRepository;
  readonly pages: InMemoryPageRepository;
  readonly screenshots: InMemoryScreenshotRepository;
  readonly vaultAudit: InMemoryVaultAuditRepository;
  readonly blocklistAudit: InMemoryBlocklistAuditRepository;
  readonly events = new InMemoryEventLogRepository();
  readonly systemEvents = new InMemorySystemEventRepository();
  readonly notifications = new InMemoryNotificationRepository();
  readonly operatorRequests = notImplemented<Repositories['operatorRequests']>('operatorRequests');
  readonly operatorActions = notImplemented<Repositories['operatorActions']>('operatorActions');
  readonly principals = notImplemented<Repositories['principals']>('principals');
  readonly credentials = notImplemented<Repositories['credentials']>('credentials');
  readonly authSessions = notImplemented<Repositories['authSessions']>('authSessions');
  readonly grants = notImplemented<Repositories['grants']>('grants');
  readonly authEvents = notImplemented<Repositories['authEvents']>('authEvents');
  readonly vaultBindings = notImplemented<Repositories['vaultBindings']>('vaultBindings');
  readonly vaultGroupPolicies =
    notImplemented<Repositories['vaultGroupPolicies']>('vaultGroupPolicies');
  readonly preferences = notImplemented<Repositories['preferences']>('preferences');
  readonly idempotency = notImplemented<Repositories['idempotency']>('idempotency');
  readonly logs = notImplemented<Repositories['logs']>('logs');
  readonly artifactOutbox = notImplemented<Repositories['artifactOutbox']>('artifactOutbox');
  readonly mcpConnections = new InMemoryMcpConnectionRepository(
    (id) => [...this.sessions.rows.values()].filter((r) => r.connectionId === id).length,
  );
  readonly schemaMigrations = notImplemented<Repositories['schemaMigrations']>('schemaMigrations');

  constructor() {
    this.sessions = new InMemorySessionRepository((sessionId) => this.countsFor(sessionId));
    const slugOf = (id: string | null) => this.sessions.slugOf(id);
    this.toolCalls = new InMemoryToolCallRepository(slugOf);
    this.pages = new InMemoryPageRepository(slugOf);
    this.screenshots = new InMemoryScreenshotRepository(this.toolCalls);
    this.vaultAudit = new InMemoryVaultAuditRepository(slugOf);
    this.blocklistAudit = new InMemoryBlocklistAuditRepository(slugOf);
  }

  private countsFor(sessionId: string): SessionListRow['counts'] {
    const calls = [...this.toolCalls.rows.values()].filter((r) => r.sessionId === sessionId);
    return {
      toolCalls: calls.length,
      errors: calls.filter((r) => !r.ok).length,
      pages: [...this.pages.rows.values()].filter((r) => r.sessionId === sessionId).length,
      blocked: [...this.blocklistAudit.rows.values()].filter((r) => r.sessionId === sessionId)
        .length,
      attentionOpen: 0,
      vaultAccess: [...this.vaultAudit.rows.values()].filter((r) => r.sessionId === sessionId)
        .length,
    };
  }
}

/** Options of {@link InMemoryWriteQueue}. */
export interface InMemoryWriteQueueOptions {
  /** Run enqueued jobs on a microtask instead of waiting for `drain()`. */
  readonly autoDrain?: boolean;
}

/** Records the operations enqueued and runs jobs against the bundle on `drain()`. */
export class InMemoryWriteQueue implements WriteQueue {
  readonly operations: string[] = [];
  readonly failures: Array<{ operation: string; error: unknown }> = [];
  private readonly jobs: Array<{ operation: string; job: WriteJob }> = [];
  private closed = false;
  private dropped = 0;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly repos: Repositories,
    private readonly options: InMemoryWriteQueueOptions = {},
  ) {}

  enqueue(operation: string, job: WriteJob): boolean {
    if (this.closed) {
      this.dropped++;
      return false;
    }
    this.operations.push(operation);
    this.jobs.push({ operation, job });
    if (this.options.autoDrain === true) void Promise.resolve().then(() => this.drain());
    return true;
  }

  async drain(): Promise<void> {
    if (this.draining !== undefined) return this.draining;
    this.draining = this.runAll().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  get depth(): number {
    return this.jobs.length;
  }

  get droppedWrites(): number {
    return this.dropped;
  }

  async close(): Promise<void> {
    await this.drain();
    this.closed = true;
  }

  private async runAll(): Promise<void> {
    while (this.jobs.length > 0) {
      const next = this.jobs.shift();
      if (next === undefined) break;
      try {
        await next.job(this.repos);
      } catch (error) {
        this.dropped++;
        this.failures.push({ operation: next.operation, error });
      }
    }
  }
}

/** Runs `fn` against the bundle directly (no rollback: tests assert on outcomes, not isolation). */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly repos: Repositories) {}

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return fn(this.repos);
  }
}
