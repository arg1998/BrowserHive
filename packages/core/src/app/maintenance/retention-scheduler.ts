/** @module app/maintenance/retention-scheduler — runs `MaintenanceService.retentionSweep` every `retentionIntervalMs` (6 h), isolates failures, raises/resolves `RETENTION_FAILED`, exposes `/system.retention` (spec 03 §7.1). */

import type { RetentionStatus } from '@browserhive/contracts/http';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  MaintenanceService,
  RetentionPolicy,
  RetentionResult,
} from '../../ports/persistence/maintenance.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { type IntervalScheduler, realIntervalScheduler } from './timer.ts';

/** Sweep cadence: every 6 hours (spec 03 §7.1); retention is day-granular, so more often buys nothing. */
export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Audit class window when no config key overrides it (spec 03 §7.1). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
/** Degradation code raised by failing passes. */
export const RETENTION_FAILED = 'RETENTION_FAILED';

/** Outcome label of one pass (`/system.retention.last_result`). */
export type RetentionOutcome = RetentionStatus['last_result'] & string;

/** Config slice the policy is built from (`ServerConfig` satisfies it). */
export interface RetentionConfig {
  readonly retentionDays: number;
  readonly retentionBytes: number;
  readonly auditRetentionDays?: number;
}

/**
 * Builds the sweep policy from config.
 *
 * @returns The persistence `RetentionPolicy`.
 */
export function retentionPolicyFromConfig(config: RetentionConfig): RetentionPolicy {
  return {
    retentionDays: config.retentionDays,
    retentionBytes: config.retentionBytes,
    auditRetentionDays: config.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    notificationSeenDays: 30,
    notificationDays: 90,
  };
}

/** Dependencies of {@link RetentionScheduler}. */
export interface RetentionSchedulerDeps {
  readonly maintenance: Pick<MaintenanceService, 'retentionSweep'>;
  readonly policy: RetentionPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly degradations: DegradationReporter;
  readonly bus?: EventPublisher<DomainEvents>;
  /** Artifact outbox depth for `artifacts_pending`. */
  readonly outbox?: { count(): Promise<number> };
  readonly intervalMs?: number;
  readonly scheduler?: IntervalScheduler;
}

/** Last pass as remembered in-process. */
export interface RetentionRun {
  readonly at: number;
  readonly outcome: RetentionOutcome;
  readonly prunedRows: number;
  readonly result: RetentionResult | null;
}

/**
 * Periodic retention. Each tick is `void tick().catch(report)`; a throwing sweep never kills
 * the timer. Per-item failures become one `RETENTION_FAILED` row per step (aggregated across
 * passes); the next clean pass resolves them.
 */
export class RetentionScheduler {
  private cancel: (() => void) | undefined;
  private running = false;
  private startedAt: number | undefined;
  private last: RetentionRun | undefined;
  private artifactsPending = 0;
  private readonly log: Logger;

  constructor(private readonly deps: RetentionSchedulerDeps) {
    this.log = deps.logger.child({ module: 'retention' });
  }

  /** Starts the timer; the first pass runs after one interval so startup does no sweep I/O. Idempotent. */
  start(): void {
    if (this.cancel !== undefined) return;
    this.startedAt = this.deps.clock.now();
    this.cancel = (this.deps.scheduler ?? realIntervalScheduler).setInterval(() => {
      void this.tick().catch((err: unknown) => this.report(err));
    }, this.intervalMs);
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /** The last completed pass, if any. */
  get lastRun(): RetentionRun | undefined {
    return this.last;
  }

  /**
   * One pass. Overlapping calls coalesce (returns `undefined` while one is in flight).
   *
   * @returns The run summary.
   */
  async tick(): Promise<RetentionRun | undefined> {
    if (this.running) return undefined;
    this.running = true;
    const at = this.deps.clock.now();
    try {
      let run: RetentionRun;
      try {
        const result = await this.deps.maintenance.retentionSweep(this.deps.policy);
        run = this.settle(at, result);
      } catch (err) {
        this.log.error('retention sweep failed', { err: serializeError(err) });
        this.deps.degradations.report({
          code: RETENTION_FAILED,
          severity: 'error',
          message: 'retention sweep failed',
          details: { step: 'sweep' },
        });
        run = { at, outcome: 'failed', prunedRows: 0, result: null };
      }
      this.last = run;
      await this.refreshPending();
      this.deps.bus?.publish('retention.completed', {
        type: 'retention.completed',
        at: run.at,
        pruned_rows: run.prunedRows,
        result: run.outcome,
        ...(run.outcome !== 'ok' && { severity: run.outcome === 'failed' ? 'error' : 'warn' }),
      });
      return run;
    } finally {
      this.running = false;
    }
  }

  /** `/system.retention` view. */
  status(): RetentionStatus {
    const base = this.last?.at ?? this.startedAt;
    return {
      days: this.deps.policy.retentionDays,
      bytes: this.deps.policy.retentionBytes,
      last_run_at: this.last?.at ?? null,
      last_result: this.last?.outcome ?? null,
      next_run_at: this.cancel === undefined || base === undefined ? null : base + this.intervalMs,
      pruned_rows: this.last?.prunedRows ?? 0,
      artifacts_pending: this.artifactsPending,
    };
  }

  private get intervalMs(): number {
    return this.deps.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
  }

  private settle(at: number, result: RetentionResult): RetentionRun {
    const prunedRows = Object.values(result.prunedRows).reduce((n, v) => n + v, 0);
    if (result.failures.length === 0) {
      this.deps.degradations.recovered(RETENTION_FAILED);
      if (prunedRows > 0) {
        this.log.info('retention pass', {
          prunedRows,
          artifactsEnqueued: result.artifactsEnqueued,
          bytesAfter: result.bytesAfter,
        });
      }
      return { at, outcome: 'ok', prunedRows, result };
    }
    for (const failure of result.failures) {
      this.log.warn('retention step failed', { step: failure.step, detail: failure.message });
      this.deps.degradations.report({
        code: RETENTION_FAILED,
        severity: 'warn',
        message: `retention step ${failure.step} failed: ${failure.message}`,
        details: { step: failure.step },
      });
    }
    return { at, outcome: 'partial', prunedRows, result };
  }

  private async refreshPending(): Promise<void> {
    if (this.deps.outbox === undefined) return;
    try {
      this.artifactsPending = await this.deps.outbox.count();
    } catch (err) {
      this.log.warn('outbox count failed', { err: serializeError(err) });
    }
  }

  private report(err: unknown): void {
    this.log.error('retention tick failed', { err: serializeError(err) });
  }
}
