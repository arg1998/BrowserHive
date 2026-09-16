/** @module composition/health — the phase tracker behind `/health` (spec 03 §4.1): phase, readiness checks and the aggregate status. */

import type { BootPhase, HealthCheckState, HealthStatus } from '@browserhive/contracts/http';
import type { HealthProbe } from '@browserhive/core/server';

/** The three readiness checks `/health` reports. */
export type HealthCheckName = 'db' | 'browser' | 'listeners';

/** Tracks the composition phase; `/health` is `ready` (200) only once the `ready` phase completed. */
export class PhaseTracker implements HealthProbe {
  private phase_: BootPhase = 'resolve-config';
  private ready = false;
  private stopping = false;
  private readonly checks: Record<HealthCheckName, HealthCheckState> = {
    db: 'pending',
    browser: 'pending',
    listeners: 'pending',
  };
  private statusOf: () => HealthStatus = () => 'ready';

  /** The phase the process is in (or last completed). */
  get phase(): BootPhase {
    return this.phase_;
  }

  /** Enters a phase. */
  enter(phase: BootPhase): void {
    if (this.stopping) return;
    this.phase_ = phase;
  }

  /** Sets one readiness check. */
  check(name: HealthCheckName, state: HealthCheckState): void {
    this.checks[name] = state;
  }

  /** Marks the server ready; `status` supplies `ready`/`degraded` from the system status service. */
  markReady(status?: () => HealthStatus): void {
    if (status !== undefined) this.statusOf = status;
    this.phase_ = 'ready';
    this.ready = true;
  }

  /** Marks shutdown; `/health` answers `stopping` (503) from here on. */
  markStopping(): void {
    this.stopping = true;
    this.phase_ = 'stopping';
  }

  snapshot(): ReturnType<HealthProbe['snapshot']> {
    let status: HealthStatus = 'starting';
    if (this.stopping) status = 'stopping';
    else if (this.ready) status = this.statusOf();
    return { status, phase: this.phase_, checks: { ...this.checks } };
  }
}
