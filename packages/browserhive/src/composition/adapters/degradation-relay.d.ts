/** @module composition/adapters/degradation-relay — a `DegradationReporter` usable before storage exists: reports are buffered until the `DegradationService` is attached. */
import type {
  Degradation,
  DegradationReporter,
  DegradationService,
} from '@browserhive/core/runtime';
/** Reports made before {@link DegradationRelay.attach} that are kept (oldest dropped beyond). */
export declare const RELAY_BUFFER_LIMIT = 256;
/**
 * Forwards to the `DegradationService` once storage is open (telemetry exporters, log sinks and
 * process handlers exist earlier). Never throws.
 */
export declare class DegradationRelay implements DegradationReporter {
  private target;
  private readonly pending;
  /** Attaches the service and replays what was buffered. */
  attach(service: Pick<DegradationService, 'report' | 'recovered' | 'unhandled'>): void;
  /** Detaches (shutdown): later reports are buffered again and dropped with the process. */
  detach(): void;
  report(degradation: Degradation): void;
  recovered(code: string): void;
  /** `UNHANDLED` from the process handlers. */
  unhandled(error: unknown, source: 'exception' | 'rejection'): void;
  private deliver;
}
//# sourceMappingURL=degradation-relay.d.ts.map
