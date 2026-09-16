/** @module app/sessions/lease-sweeper — periodic reaper of lease-expired and crashed sessions, timer-safe per spec 05 §6. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { type Tracer, trace } from '@opentelemetry/api';
import type { Session } from '../../domain/session/session.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';

/** Default sweep cadence: once a minute. Fine-grained relative to the 2 h default lease. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** The slice of the session service the sweeper drives. */
export interface SweepTarget {
  listAll(): readonly Session[];
  close(sessionId: string, reason: ClosedReason): Promise<boolean>;
}

/** Timer seam so tests drive ticks without real time. */
export interface SweepScheduler {
  setInterval(fn: () => void, ms: number): () => void;
}

/** Dependencies of {@link LeaseSweeper}. */
export interface LeaseSweeperDeps {
  readonly target: SweepTarget;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly scheduler?: SweepScheduler;
  readonly tracer?: Tracer;
  /** Receives failures a tick could not handle itself (degradation reporting). */
  readonly report?: (error: unknown) => void;
}

/** One reaped session and why. */
export interface Reaped {
  readonly sessionId: string;
  readonly reason: 'crash' | 'lease_expired';
}

const defaultScheduler: SweepScheduler = {
  setInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    const maybe: { unref?: () => void } = timer;
    // Do not let the sweeper's timer hold the event loop open.
    maybe.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * On a fixed interval, scans the registry and reaps crashed sessions (`crash`) and lease-expired
 * ones (`lease_expired`). Paused leases never expire. Every tick is `void tick().catch(report)`;
 * every item is isolated so one failing close never aborts the sweep.
 */
export class LeaseSweeper {
  private readonly deps: LeaseSweeperDeps;
  private readonly tracer: Tracer;
  private stop_: (() => void) | undefined;
  private sweeping = false;

  constructor(deps: LeaseSweeperDeps) {
    this.deps = deps;
    this.tracer = deps.tracer ?? trace.getTracer('browserhive');
  }

  /** Begin periodic sweeping. Idempotent. */
  start(): void {
    if (this.stop_ !== undefined) return;
    const scheduler = this.deps.scheduler ?? defaultScheduler;
    this.stop_ = scheduler.setInterval(() => {
      void this.sweepOnce().catch((err: unknown) => this.report(err));
    }, this.deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  }

  /** Stop periodic sweeping. Idempotent. */
  stop(): void {
    this.stop_?.();
    this.stop_ = undefined;
  }

  /** One pass; overlapping calls coalesce (a pass in flight makes this a no-op returning `[]`). */
  async sweepOnce(): Promise<readonly Reaped[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    const log = this.deps.logger.child({ module: 'sessions.sweeper' });
    const reaped: Reaped[] = [];
    let failed = 0;
    try {
      const now = this.deps.clock.now();
      await this.tracer.startActiveSpan('lease.sweep', async (span) => {
        for (const session of this.deps.target.listAll()) {
          const reason = reasonFor(session, now);
          if (reason === undefined) continue;
          try {
            if (await this.deps.target.close(session.id, reason)) {
              reaped.push({ sessionId: session.id, reason });
              log.info('session reaped', { sessionId: session.id, reason });
            }
          } catch (err) {
            failed++;
            log.error('reap failed', { sessionId: session.id, reason, err: serializeError(err) });
          }
        }
        span.setAttribute('browserhive.pruned', reaped.length);
        span.setAttribute('browserhive.failed', failed);
        span.end();
      });
    } finally {
      this.sweeping = false;
    }
    return reaped;
  }

  private report(error: unknown): void {
    this.deps.logger.error('lease sweep failed', { err: serializeError(error) });
    try {
      this.deps.report?.(error);
    } catch {
      // Reporter failures are not ours to escalate.
    }
  }
}

function reasonFor(session: Session, now: number): Reaped['reason'] | undefined {
  if (session.dead) return 'crash';
  if (session.state.kind === 'live' && session.isLeaseExpired(now)) return 'lease_expired';
  return undefined;
}
