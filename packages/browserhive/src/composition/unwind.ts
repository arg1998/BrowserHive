/** @module composition/unwind — the phase unwind stack: handles stop in reverse order, each within its own budget and the total deadline (spec 01 §6). */

import type { Logger } from '@browserhive/core/runtime';
import { serializeError } from '@browserhive/core/runtime';

/** What every composition phase returns. `stop` must be safe to call once and never hang past its budget on purpose. */
export interface PhaseHandle {
  stop(deadlineMs: number): Promise<void>;
}

/** A handle registered on the stack. */
interface Entry {
  readonly name: string;
  readonly handle: PhaseHandle;
  /** Upper bound for this handle; the remaining total deadline caps it further. */
  readonly budgetMs: number;
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
export class UnwindStack {
  private readonly entries: Entry[] = [];

  /** Registers a handle; it stops before everything pushed earlier. */
  push(name: string, handle: PhaseHandle, budgetMs: number): void {
    this.entries.push({ name, handle, budgetMs });
  }

  /** Names in registration order (tests). */
  names(): readonly string[] {
    return this.entries.map((e) => e.name);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Stops every handle in reverse order. A handle that throws or overruns is logged and the
   * unwind continues; the stack is empty afterwards, so a second call is a no-op.
   */
  async unwind(options: {
    readonly deadlineMs: number;
    readonly clock: UnwindClock;
    readonly logger?: Logger;
  }): Promise<readonly UnwindStep[]> {
    const started = options.clock.now();
    const steps: UnwindStep[] = [];
    while (this.entries.length > 0) {
      const entry = this.entries.pop();
      if (entry === undefined) break;
      const remaining = Math.max(0, options.deadlineMs - (options.clock.now() - started));
      // A handle always gets a small slice, even past the total deadline, so files are closed.
      const budget = Math.max(Math.min(entry.budgetMs, remaining), MIN_STEP_MS);
      const at = options.clock.now();
      const outcome = await runWithin(entry, budget, options.logger);
      steps.push({ name: entry.name, ms: options.clock.now() - at, outcome });
    }
    return steps;
  }
}

/** Floor for a single handle's stop once the total deadline is spent. */
export const MIN_STEP_MS = 250;

async function runWithin(
  entry: Entry,
  budgetMs: number,
  logger: Logger | undefined,
): Promise<UnwindStep['outcome']> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  try {
    const result = await Promise.race([
      entry.handle.stop(budgetMs).then(() => 'ok' as const),
      timeout,
    ]);
    if (result === 'timeout') {
      logger?.warn('phase stop overran', { phase: entry.name, budget_ms: budgetMs });
    }
    return result;
  } catch (err) {
    logger?.error('phase stop failed', { phase: entry.name, err: serializeError(err) });
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
