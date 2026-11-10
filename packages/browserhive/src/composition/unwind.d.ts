/** @module composition/unwind — the phase unwind stack: handles stop in reverse order, each within its own budget and the total deadline (spec 01 §6). */
import type { Logger } from '@browserhive/core/runtime';
/** What every composition phase returns. `stop` must be safe to call once and never hang past its budget on purpose. */
export interface PhaseHandle {
  stop(deadlineMs: number): Promise<void>;
}
/** Outcome of one handle's stop. */
export interface UnwindStep {
  readonly name: string;
  readonly ms: number;
  readonly outcome: 'ok' | 'failed' | 'timeout';
}
/** Minimal clock the unwinder needs. */
export interface UnwindClock {
  now(): number;
}
/** LIFO stack of phase handles. */
export declare class UnwindStack {
  private readonly entries;
  /** Registers a handle; it stops before everything pushed earlier. */
  push(name: string, handle: PhaseHandle, budgetMs: number): void;
  /** Names in registration order (tests). */
  names(): readonly string[];
  get size(): number;
  /**
   * Stops every handle in reverse order. A handle that throws or overruns is logged and the
   * unwind continues; the stack is empty afterwards, so a second call is a no-op.
   */
  unwind(options: {
    readonly deadlineMs: number;
    readonly clock: UnwindClock;
    readonly logger?: Logger;
  }): Promise<readonly UnwindStep[]>;
}
/** Floor for a single handle's stop once the total deadline is spent. */
export declare const MIN_STEP_MS = 250;
//# sourceMappingURL=unwind.d.ts.map
