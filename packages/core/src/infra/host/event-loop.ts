/** @module infra/host/event-loop — event-loop delay of this process over a window (spec 10 §7 `browserhive.process.event_loop_lag`). */

import { monitorEventLoopDelay } from 'node:perf_hooks';

/** A running event-loop delay monitor. */
export interface EventLoopLagMonitor {
  /** 99th percentile delay in ms since the previous call (or the start), then starts a new window; `null` without samples. */
  takeP99Ms(): number | null;
  /** Stops sampling. Idempotent. */
  stop(): void;
}

/**
 * Starts sampling the event-loop delay every `resolutionMs`. Returns `null` where the runtime has
 * no `monitorEventLoopDelay`; nothing runs until this is called.
 */
export function startEventLoopLagMonitor(resolutionMs = 20): EventLoopLagMonitor | null {
  let histogram: ReturnType<typeof monitorEventLoopDelay>;
  try {
    histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    histogram.enable();
  } catch {
    return null;
  }
  let stopped = false;
  return {
    takeP99Ms() {
      if (histogram.count === 0) return null;
      const p99 = histogram.percentile(99) / 1e6;
      histogram.reset();
      return Number.isFinite(p99) ? p99 : null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      histogram.disable();
    },
  };
}
