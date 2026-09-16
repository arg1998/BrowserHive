/** @module domain/operator-requests/broker — the one broker behind attention and vault confirm (D-15): durable row, deadline, lease pause, cancellation, settlement, orphan recovery. */

import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ClosedReason, OperatorRequestKind } from '../../ports/persistence/enums.ts';
import type {
  OperatorActionRepository,
  OperatorRequestRepository,
} from '../../ports/persistence/index.ts';
import type {
  OperatorRequestFacets,
  OperatorRequestListRow,
  OperatorRequestResolution,
} from '../../ports/persistence/operator-requests.ts';
import type { OperatorRequestListQuery, Page } from '../../ports/persistence/queries.ts';
import type { OperatorRequestRecord } from '../../ports/persistence/records.ts';
import {
  CANCELLED_MESSAGE,
  RESTART_MESSAGE,
  SESSION_CLOSE_MESSAGE,
  TIMEOUT_MESSAGE,
} from './messages.ts';
import { leaseCall, queueFullError, toJsonObject } from './support.ts';
import {
  type LeaseController,
  type OpenOperatorRequest,
  type OperatorDecision,
  type OperatorRequestEvents,
  type OperatorRequestHandle,
  type OperatorRequestLimits,
  type OperatorRequestOutcome,
  outcomeOf,
  type ResolveResult,
} from './types.ts';
import { operatorRequestEvent } from './wire.ts';

/** Default queue bounds. */
export const DEFAULT_LIMITS: OperatorRequestLimits = { perSession: 8, global: 256 };

/** Constructor dependencies of {@link OperatorRequestBroker}. */
export interface OperatorRequestBrokerDeps {
  readonly requests: OperatorRequestRepository;
  readonly actions: OperatorActionRepository;
  readonly leases: LeaseController;
  readonly events: EventPublisher<OperatorRequestEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly limits?: Partial<OperatorRequestLimits>;
}

interface Pending {
  readonly record: OperatorRequestRecord;
  readonly sessionSlug: string | null;
  readonly promise: Promise<OperatorRequestOutcome>;
  readonly resolve: (outcome: OperatorRequestOutcome) => void;
  readonly deadline: AbortController;
  detach: () => void;
}

interface SettleInput {
  readonly status: 'resolved' | 'rejected' | 'timeout' | 'cancelled';
  readonly message?: string;
  readonly reason?: string;
  readonly resolvedBy?: string;
  readonly resumeLease?: boolean;
}

/**
 * In-memory map is authoritative for live blocking; the `operator_requests` table is its durable
 * projection. Exactly one broker per process; both `request_attention` and the vault confirm
 * gate open requests here and await the returned promise.
 */
export class OperatorRequestBroker {
  private readonly deps: OperatorRequestBrokerDeps;
  private readonly limits: OperatorRequestLimits;
  private readonly log: Logger;
  private readonly pending = new Map<string, Pending>();
  private shuttingDown = false;

  constructor(deps: OperatorRequestBrokerDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.log = deps.logger.child({ module: 'attention.broker' });
  }

  /**
   * Opens a request: reuses an idempotent match, enforces the queue bounds, pauses the lease,
   * persists the row, arms the deadline and disconnect cancellation, publishes the created event.
   * @throws `RATE_LIMITED` when the per-session or global open queue is full.
   */
  async open(input: OpenOperatorRequest): Promise<OperatorRequestHandle> {
    const reused = await this.findIdempotent(input);
    if (reused !== null) return reused;

    this.assertCapacity(input.sessionId);
    const createdAt = this.deps.clock.now();
    const timeoutMs =
      input.timeoutMs !== undefined && input.timeoutMs > 0 && Number.isFinite(input.timeoutMs)
        ? input.timeoutMs
        : null;
    const record: OperatorRequestRecord = {
      requestId: this.deps.ids.operatorRequestId(),
      kind: input.kind,
      sessionId: input.sessionId,
      owner: input.owner,
      reason: input.reason,
      mode: input.mode ?? null,
      entryName: input.entryName ?? null,
      tool: input.tool ?? null,
      toolEventId: input.toolEventId ?? null,
      pageUrl: input.pageUrl ?? null,
      options: toJsonObject(input.options),
      idempotencyKey: input.idempotencyKey ?? null,
      status: 'pending',
      message: null,
      resolvedBy: null,
      resolutionReason: null,
      createdAt,
      deadlineAt: timeoutMs === null ? null : createdAt + timeoutMs,
      resolvedAt: null,
    };

    leaseCall(this.deps.leases, this.log, 'pause', record.sessionId, createdAt);
    await this.deps.requests.insert(record);

    let resolve: (outcome: OperatorRequestOutcome) => void = () => undefined;
    const promise = new Promise<OperatorRequestOutcome>((r) => {
      resolve = r;
    });
    const entry: Pending = {
      record,
      sessionSlug: input.sessionSlug ?? null,
      promise,
      resolve,
      deadline: new AbortController(),
      detach: () => undefined,
    };
    this.pending.set(record.requestId, entry);

    if (timeoutMs !== null) this.armDeadline(record.requestId, timeoutMs, entry.deadline.signal);
    if (input.signal !== undefined) this.armCancellation(record.requestId, input.signal, entry);

    this.log.info('operator request opened', {
      request_id: record.requestId,
      kind: record.kind,
      session_id: record.sessionId,
      ...(record.mode !== null && { mode: record.mode }),
      ...(timeoutMs !== null && { timeout_ms: timeoutMs }),
    });
    this.publish('created', record, entry.sessionSlug);
    return { id: record.requestId, createdAt, timeoutMs, promise, reused: false };
  }

  /** Operator decision; appends an `operator_actions` row. Not-open requests are reported, not thrown. */
  async resolve(id: string, decision: OperatorDecision, by: string): Promise<ResolveResult> {
    const outcome = await this.settle(id, { ...decision, resolvedBy: by });
    if (outcome === null) {
      const stored = await this.deps.requests.get(id);
      return { ok: false, status: stored?.status ?? null };
    }
    await this.deps.actions.append({
      eventId: this.deps.ids.eventId(),
      principalId: by,
      action: `${outcome.kind}.${decision.status}`,
      resourceKind: 'operator_request',
      resourceId: id,
      details: {
        status: decision.status,
        ...(decision.message !== undefined && { message: decision.message }),
        ...(decision.reason !== undefined && { reason: decision.reason }),
      },
      occurredAt: outcome.outcome.resolvedAt ?? this.deps.clock.now(),
    });
    return { ok: true, outcome: outcome.outcome };
  }

  /** Client-side cancellation (disconnect, `notifications/cancelled`, heartbeat rejection). */
  async cancel(id: string, message: string = CANCELLED_MESSAGE): Promise<boolean> {
    return (await this.settle(id, { status: 'cancelled', message })) !== null;
  }

  /** Rejects every open request of a session with the per-reason message; the lease is not resumed. */
  async settleForSession(sessionId: string, reason: ClosedReason): Promise<number> {
    const message = SESSION_CLOSE_MESSAGE[reason];
    let count = 0;
    for (const id of this.openIdsFor(sessionId)) {
      if ((await this.settle(id, { status: 'rejected', message, resumeLease: false })) !== null) {
        count += 1;
      }
    }
    return count;
  }

  /** Rejects every open request (server shutdown). Idempotent. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const id of [...this.pending.keys()]) {
      await this.settle(id, {
        status: 'rejected',
        message: SESSION_CLOSE_MESSAGE.shutdown,
        resumeLease: false,
      });
    }
  }

  /** Marks pending rows left by a previous process as `rejected`; returns how many. */
  async recoverOrphans(now: number = this.deps.clock.now()): Promise<number> {
    let count = 0;
    for (const row of await this.deps.requests.open()) {
      if (this.pending.has(row.requestId)) continue;
      const done = await this.deps.requests.resolve(row.requestId, {
        status: 'rejected',
        at: now,
        message: RESTART_MESSAGE,
      });
      if (done) {
        count += 1;
        this.log.warn('orphan request recovered', { request_id: row.requestId, kind: row.kind });
      }
    }
    return count;
  }

  /**
   * The outcome for `id`: the live promise while open, the stored terminal outcome once settled,
   * reject-on-read for a stored `pending` row without a waiter, `null` for an unknown id.
   */
  async result(id: string): Promise<OperatorRequestOutcome | null> {
    const live = this.pending.get(id);
    if (live !== undefined) return live.promise;
    const stored = await this.deps.requests.get(id);
    if (stored === null) return null;
    if (stored.status !== 'pending') return outcomeOf(stored);
    const at = this.deps.clock.now();
    await this.deps.requests.resolve(id, { status: 'rejected', at, message: RESTART_MESSAGE });
    return {
      requestId: id,
      status: 'rejected',
      message: RESTART_MESSAGE,
      resolvedBy: null,
      resolutionReason: null,
      resolvedAt: at,
    };
  }

  /** Stored row (open or history) or `null`. */
  get(id: string): Promise<OperatorRequestListRow | null> {
    return this.deps.requests.get(id);
  }

  /** Open requests held in memory, oldest first. */
  listOpen(kind?: OperatorRequestKind): readonly OperatorRequestRecord[] {
    return [...this.pending.values()]
      .map((p) => p.record)
      .filter((r) => kind === undefined || r.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Number of open requests, optionally of one kind. */
  openCount(kind?: OperatorRequestKind): number {
    return this.listOpen(kind).length;
  }

  /** True when the session has an open request matching `predicate` (default: any). */
  hasOpen(sessionId: string, predicate?: (record: OperatorRequestRecord) => boolean): boolean {
    for (const p of this.pending.values()) {
      if (p.record.sessionId === sessionId && (predicate === undefined || predicate(p.record))) {
        return true;
      }
    }
    return false;
  }

  /** Open and historical rows with filters (`GET /attention`, `GET /vault/confirm`). */
  history(query: OperatorRequestListQuery): Promise<Page<OperatorRequestListRow>> {
    return this.deps.requests.listHistory(query);
  }

  /** Status/mode facet counts for the same filters as {@link history}. */
  facets(query: OperatorRequestListQuery): Promise<OperatorRequestFacets> {
    return this.deps.requests.facets(query);
  }

  // --- internals ------------------------------------------------------------------------------

  private async findIdempotent(input: OpenOperatorRequest): Promise<OperatorRequestHandle | null> {
    const key = input.idempotencyKey;
    if (key === undefined) return null;
    for (const p of this.pending.values()) {
      const r = p.record;
      if (r.sessionId === input.sessionId && r.idempotencyKey === key && r.kind === input.kind) {
        const timeoutMs = r.deadlineAt === null ? null : r.deadlineAt - r.createdAt;
        return {
          id: r.requestId,
          createdAt: r.createdAt,
          timeoutMs,
          promise: p.promise,
          reused: true,
        };
      }
    }
    const stored = await this.deps.requests.getByIdempotencyKey(input.sessionId, key);
    if (stored === null || stored.kind !== input.kind) return null;
    const outcome = await this.result(stored.requestId);
    if (outcome === null) return null;
    return {
      id: stored.requestId,
      createdAt: stored.createdAt,
      timeoutMs: stored.deadlineAt === null ? null : stored.deadlineAt - stored.createdAt,
      promise: Promise.resolve(outcome),
      reused: true,
    };
  }

  private assertCapacity(sessionId: string): void {
    const perSession = this.openIdsFor(sessionId).length;
    if (perSession >= this.limits.perSession || this.pending.size >= this.limits.global) {
      throw queueFullError(perSession, this.pending.size, this.limits);
    }
  }

  private openIdsFor(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [id, p] of this.pending) if (p.record.sessionId === sessionId) ids.push(id);
    return ids;
  }

  private armDeadline(id: string, timeoutMs: number, signal: AbortSignal): void {
    this.deps.clock.sleep(timeoutMs, signal).then(
      () => this.settle(id, { status: 'timeout', message: TIMEOUT_MESSAGE }),
      () => undefined,
    );
  }

  private armCancellation(id: string, signal: AbortSignal, entry: Pending): void {
    const onAbort = (): void => {
      void this.cancel(id);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    entry.detach = () => signal.removeEventListener('abort', onAbort);
  }

  /** Moves a request to a terminal state exactly once; `null` when it was not open. */
  private async settle(
    id: string,
    input: SettleInput,
  ): Promise<{ outcome: OperatorRequestOutcome; kind: OperatorRequestKind } | null> {
    const entry = this.pending.get(id);
    if (entry === undefined) return null;
    this.pending.delete(id);
    entry.deadline.abort();
    entry.detach();

    const resolvedAt = this.deps.clock.now();
    if (input.resumeLease !== false) {
      leaseCall(this.deps.leases, this.log, 'resume', entry.record.sessionId, resolvedAt);
    }

    const resolution: OperatorRequestResolution = {
      status: input.status,
      at: resolvedAt,
      ...(input.message !== undefined && { message: input.message }),
      ...(input.resolvedBy !== undefined && { resolvedBy: input.resolvedBy }),
      ...(input.reason !== undefined && { reason: input.reason }),
    };
    await this.deps.requests.resolve(id, resolution);

    const record: OperatorRequestRecord = {
      ...entry.record,
      status: input.status,
      message: input.message ?? null,
      resolvedBy: input.resolvedBy ?? null,
      resolutionReason: input.reason ?? null,
      resolvedAt,
    };
    const outcome = outcomeOf(record);
    entry.resolve(outcome);
    this.log.info('operator request settled', {
      request_id: id,
      kind: record.kind,
      status: input.status,
      ...(input.resolvedBy !== undefined && { resolved_by: input.resolvedBy }),
    });
    this.publish('resolved', record, entry.sessionSlug);
    return { outcome, kind: record.kind };
  }

  private publish(
    phase: 'created' | 'resolved',
    record: OperatorRequestRecord,
    sessionSlug: string | null,
  ): void {
    const event = operatorRequestEvent(phase, record, sessionSlug);
    this.deps.events.publish(event.name, event.payload);
  }
}
