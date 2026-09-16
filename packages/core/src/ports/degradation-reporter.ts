/** @module ports/degradation-reporter — sink for background failures that become `system_events` rows (spec 10 §3). */

/** One degradation report; aggregated by `code` + stable `details` keys downstream. */
export interface Degradation {
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Records a degradation (never throws) and, later, its recovery. */
export interface DegradationReporter {
  report(degradation: Degradation): void;
  recovered(code: string): void;
}
