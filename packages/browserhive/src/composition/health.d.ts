/** @module composition/health — the phase tracker behind `/health` (spec 03 §4.1): phase, readiness checks and the aggregate status. */
import type { BootPhase, HealthCheckState, HealthStatus } from '@browserhive/contracts/http';
import type { HealthProbe } from '@browserhive/core/server';
/** The three readiness checks `/health` reports. */
export type HealthCheckName = 'db' | 'browser' | 'listeners';
/** Tracks the composition phase; `/health` is `ready` (200) only once the `ready` phase completed. */
export declare class PhaseTracker implements HealthProbe {
  private phase_;
  private ready;
  private stopping;
  private readonly checks;
  private statusOf;
  /** The phase the process is in (or last completed). */
  get phase(): BootPhase;
  /** Enters a phase. */
  enter(phase: BootPhase): void;
  /** Sets one readiness check. */
  check(name: HealthCheckName, state: HealthCheckState): void;
  /** Marks the server ready; `status` supplies `ready`/`degraded` from the system status service. */
  markReady(status?: () => HealthStatus): void;
  /** Marks shutdown; `/health` answers `stopping` (503) from here on. */
  markStopping(): void;
  snapshot(): ReturnType<HealthProbe['snapshot']>;
}
//# sourceMappingURL=health.d.ts.map
