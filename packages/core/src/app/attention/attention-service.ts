/** @module app/attention/attention-service — request_attention / get_attention_result / REST resolve semantics over the operator-request broker. */

import type { AttentionOutcome } from '@browserhive/contracts/tools';
import type { OperatorRequestBroker } from '../../domain/operator-requests/broker.ts';
import {
  assertAttentionTransport,
  effectiveAttentionWaitMs,
  effectiveTimeoutMs,
  type ProgressReport,
  waitWithHeartbeats,
} from '../../domain/operator-requests/heartbeat.ts';
import { unknownRequestMessage } from '../../domain/operator-requests/messages.ts';
import type {
  OperatorRequestOutcome,
  OperatorRequestTerminalStatus,
} from '../../domain/operator-requests/types.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { AttentionMode } from '../../ports/persistence/enums.ts';
import type {
  OperatorRequestFacets,
  OperatorRequestListRow,
} from '../../ports/persistence/operator-requests.ts';
import type { OperatorRequestListQuery, Page } from '../../ports/persistence/queries.ts';
import type { OperatorRequestRecord } from '../../ports/persistence/records.ts';

/** The config keys the service reads (already resolved to ms). */
export interface AttentionConfig {
  readonly transport: 'http' | 'stdio';
  /** Server cap on how long a request may block (`attentionTimeout`). */
  readonly attentionTimeoutMs: number;
  /** Operator floor on `max_wait_seconds` (`minAttentionWait`); `0` disables it. */
  readonly minAttentionWaitMs: number;
}

/** Constructor dependencies of {@link AttentionService}. */
export interface AttentionServiceDeps {
  readonly broker: OperatorRequestBroker;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: AttentionConfig;
}

/** `request_attention` input (camelCase). */
export interface AttentionRequestInput {
  readonly reason: string;
  readonly mode: AttentionMode;
  readonly options?: unknown;
  readonly maxWaitSeconds?: number;
  readonly idempotencyKey?: string;
}

/** Per-call context supplied by the tool dispatcher. */
export interface AttentionCallContext {
  /** Caller principal; becomes the request `owner`. */
  readonly principal: string;
  /** The session's slug (feed context). */
  readonly sessionSlug?: string;
  readonly toolEventId?: string;
  readonly pageUrl?: string | null;
  readonly reportProgress?: (report: ProgressReport) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** The two commands the live-view input gate distinguishes. */
export type LiveViewCommand = 'input' | 'session.set_viewport';

/**
 * Blocking attention semantics for the agent (spec 02 §5) plus the operator side of
 * `GET /attention`, `POST /attention/{id}/resolve` and the live-view input gate.
 */
export class AttentionService {
  private readonly deps: AttentionServiceDeps;

  constructor(deps: AttentionServiceDeps) {
    this.deps = deps;
  }

  /**
   * Opens an attention request and blocks with heartbeats until it settles.
   * @throws `ATTENTION_REQUIRES_HTTP` under stdio (before anything else), `RATE_LIMITED` when the queue is full.
   */
  async request(
    sessionId: string,
    input: AttentionRequestInput,
    ctx: AttentionCallContext,
  ): Promise<AttentionOutcome> {
    assertAttentionTransport(this.deps.config.transport, 'request_attention');
    const maxWaitMs = effectiveAttentionWaitMs(
      input.maxWaitSeconds,
      this.deps.config.minAttentionWaitMs,
    );
    const timeoutMs = effectiveTimeoutMs(maxWaitMs, this.deps.config.attentionTimeoutMs);
    const handle = await this.deps.broker.open({
      kind: 'attention',
      sessionId,
      ...(ctx.sessionSlug !== undefined && { sessionSlug: ctx.sessionSlug }),
      owner: ctx.principal,
      reason: input.reason,
      mode: input.mode,
      tool: 'request_attention',
      ...(ctx.toolEventId !== undefined && { toolEventId: ctx.toolEventId }),
      ...(ctx.pageUrl !== undefined && ctx.pageUrl !== null && { pageUrl: ctx.pageUrl }),
      ...(input.options !== undefined && { options: input.options }),
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      timeoutMs,
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
    });
    return this.block(handle.id, handle.promise, handle.timeoutMs, ctx);
  }

  /**
   * Re-attaches to a request by id (same principal). Settled ⇒ immediate; pending ⇒ blocks with
   * heartbeats; unknown or another principal's ⇒ `rejected` with the unknown-request message.
   * @throws `ATTENTION_REQUIRES_HTTP` under stdio.
   */
  async result(requestId: string, ctx: AttentionCallContext): Promise<AttentionOutcome> {
    assertAttentionTransport(this.deps.config.transport, 'get_attention_result');
    const row = await this.deps.broker.get(requestId);
    const outcome =
      row === null || row.owner !== ctx.principal || row.kind !== 'attention'
        ? null
        : await this.deps.broker.result(requestId);
    if (outcome === null) {
      return {
        status: 'rejected',
        message: unknownRequestMessage(requestId),
        resolved_at: this.deps.clock.now(),
        request_id: requestId,
      };
    }
    const timeoutMs =
      row !== null && row.deadlineAt !== null ? row.deadlineAt - row.createdAt : null;
    return this.block(requestId, Promise.resolve(outcome), timeoutMs, ctx);
  }

  /** Operator resolve (`decision: 'resolve'`). */
  resolve(requestId: string, by: string, message?: string): Promise<OperatorRequestTerminalStatus> {
    return this.decide(requestId, 'resolved', by, message);
  }

  /** Operator reject (`decision: 'reject'`). */
  reject(requestId: string, by: string, message?: string): Promise<OperatorRequestTerminalStatus> {
    return this.decide(requestId, 'rejected', by, message);
  }

  /** Open attention requests, oldest first (dashboard queue). */
  listOpen(): readonly OperatorRequestRecord[] {
    return this.deps.broker.listOpen('attention');
  }

  /** Number of open attention requests (`open_count`). */
  openCount(): number {
    return this.deps.broker.openCount('attention');
  }

  /** `GET /attention` / `GET /sessions/{id}/attention`. */
  history(query: OperatorRequestListQuery): Promise<Page<OperatorRequestListRow>> {
    return this.deps.broker.history({ ...query, kind: 'attention' });
  }

  /** Status/mode facet counts of `GET /attention` (disjunctive per dimension). */
  facets(query: OperatorRequestListQuery): Promise<OperatorRequestFacets> {
    return this.deps.broker.facets({ ...query, kind: 'attention' });
  }

  /** Any open attention request for the session, optionally of one mode. */
  hasOpenAttention(sessionId: string, mode?: AttentionMode): boolean {
    return this.deps.broker.hasOpen(
      sessionId,
      (r) => r.kind === 'attention' && (mode === undefined || r.mode === mode),
    );
  }

  /**
   * Live-view input rule (spec 03 §6.3, D-10): `input` is accepted only while a `takeover`
   * attention request is open; `session.set_viewport` is never gated.
   */
  isInputPermitted(sessionId: string, command: LiveViewCommand): boolean {
    if (command === 'session.set_viewport') return true;
    return this.hasOpenAttention(sessionId, 'takeover');
  }

  /** @throws `INPUT_NOT_PERMITTED` when {@link isInputPermitted} is false. */
  assertInputPermitted(sessionId: string, command: LiveViewCommand): void {
    if (this.isInputPermitted(sessionId, command)) return;
    throw new AppError(
      'INPUT_NOT_PERMITTED',
      { session_id: sessionId },
      {
        publicMessage: `Input is not permitted on session '${sessionId}': no takeover attention request is open.`,
      },
    );
  }

  // --- internals ------------------------------------------------------------------------------

  private async block(
    requestId: string,
    promise: Promise<OperatorRequestOutcome>,
    timeoutMs: number | null,
    ctx: AttentionCallContext,
  ): Promise<AttentionOutcome> {
    const outcome = await waitWithHeartbeats(promise, {
      clock: this.deps.clock,
      ...(ctx.reportProgress !== undefined && { reportProgress: ctx.reportProgress }),
      totalMs: timeoutMs,
      onClientGone: async () => {
        this.deps.logger.debug('attention client gone', { request_id: requestId });
        await this.deps.broker.cancel(requestId);
      },
    });
    return toAttentionOutcome(outcome);
  }

  private async decide(
    requestId: string,
    status: 'resolved' | 'rejected',
    by: string,
    message: string | undefined,
  ): Promise<OperatorRequestTerminalStatus> {
    const result = await this.deps.broker.resolve(
      requestId,
      { status, ...(message !== undefined && { message }) },
      by,
    );
    if (result.ok) return result.outcome.status;
    if (result.status === null) throw new AppError('NOT_FOUND', {});
    throw new AppError(
      'ATTENTION_NOT_OPEN',
      { request_id: requestId, status: result.status },
      { publicMessage: `Attention request '${requestId}' is not open (status: ${result.status}).` },
    );
  }
}

/** Projects a broker outcome onto the tool shape (`message`/`resolved_by` omitted when absent). */
export function toAttentionOutcome(outcome: OperatorRequestOutcome): AttentionOutcome {
  return {
    status: outcome.status,
    ...(outcome.message !== null && { message: outcome.message }),
    ...(outcome.resolvedBy !== null && { resolved_by: outcome.resolvedBy }),
    resolved_at: outcome.resolvedAt,
    request_id: outcome.requestId,
  };
}
