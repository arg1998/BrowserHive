/** @module composition/adapters/degradation-relay — a `DegradationReporter` usable before storage exists: reports are buffered until the `DegradationService` is attached. */

import type {
  Degradation,
  DegradationReporter,
  DegradationService,
} from '@browserhive/core/runtime';

/** Reports made before {@link DegradationRelay.attach} that are kept (oldest dropped beyond). */
export const RELAY_BUFFER_LIMIT = 256;

type Pending =
  | { readonly kind: 'report'; readonly degradation: Degradation }
  | { readonly kind: 'recovered'; readonly code: string }
  | {
      readonly kind: 'unhandled';
      readonly error: unknown;
      readonly source: 'exception' | 'rejection';
    };

/**
 * Forwards to the `DegradationService` once storage is open (telemetry exporters, log sinks and
 * process handlers exist earlier). Never throws.
 */
export class DegradationRelay implements DegradationReporter {
  private target: Pick<DegradationService, 'report' | 'recovered' | 'unhandled'> | null = null;
  private readonly pending: Pending[] = [];

  /** Attaches the service and replays what was buffered. */
  attach(service: Pick<DegradationService, 'report' | 'recovered' | 'unhandled'>): void {
    this.target = service;
    for (const item of this.pending.splice(0)) this.deliver(item);
  }

  /** Detaches (shutdown): later reports are buffered again and dropped with the process. */
  detach(): void {
    this.target = null;
  }

  report(degradation: Degradation): void {
    this.deliver({ kind: 'report', degradation });
  }

  recovered(code: string): void {
    this.deliver({ kind: 'recovered', code });
  }

  /** `UNHANDLED` from the process handlers. */
  unhandled(error: unknown, source: 'exception' | 'rejection'): void {
    this.deliver({ kind: 'unhandled', error, source });
  }

  private deliver(item: Pending): void {
    const target = this.target;
    if (target === null) {
      if (this.pending.length >= RELAY_BUFFER_LIMIT) this.pending.shift();
      this.pending.push(item);
      return;
    }
    try {
      switch (item.kind) {
        case 'report':
          target.report(item.degradation);
          break;
        case 'recovered':
          target.recovered(item.code);
          break;
        case 'unhandled':
          target.unhandled(item.error, item.source);
          break;
      }
    } catch {
      // The reporter contract is never-throw; a broken target must not take the caller down.
    }
  }
}
