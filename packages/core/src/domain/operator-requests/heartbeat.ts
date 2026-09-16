/** @module domain/operator-requests/heartbeat — the agent-facing wait loop (progress every 25 s), floor/cap arithmetic, transport gate. */

import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';

/** Progress period while a tool blocks on an operator (under the 30 s client ceiling). */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** MCP `notifications/progress` payload. */
export interface ProgressReport {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

/** Options for {@link waitWithHeartbeats}. */
export interface HeartbeatOptions {
  readonly clock: Clock;
  /** Default {@link HEARTBEAT_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** Absent (fakes, stdio-less contexts) → plain await. A rejection means the client is gone. */
  readonly reportProgress?: (report: ProgressReport) => Promise<void>;
  /** Effective deadline, reported as `total`; `null` when waiting indefinitely. */
  readonly totalMs?: number | null;
  /** Invoked once when a heartbeat is rejected (the caller cancels the request). */
  readonly onClientGone?: () => Promise<void> | void;
}

/**
 * Awaits `promise`, sending a progress heartbeat every interval. A rejected heartbeat means the
 * client disconnected: `onClientGone` runs (which settles the request as `cancelled`) and the loop
 * stops ticking; the settled outcome is still returned.
 */
export async function waitWithHeartbeats<T>(
  promise: Promise<T>,
  options: HeartbeatOptions,
): Promise<T> {
  const report = options.reportProgress;
  if (report === undefined) return promise;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const startedAt = options.clock.now();
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  while (!settled) {
    const tick = new AbortController();
    const sleep = options.clock.sleep(intervalMs, tick.signal).then(
      () => 'tick' as const,
      () => 'tick' as const,
    );
    const winner = await Promise.race([tracked.then(() => 'settled' as const), sleep]);
    tick.abort();
    if (winner === 'settled') break;
    try {
      await report({
        progress: options.clock.now() - startedAt,
        ...(options.totalMs !== undefined &&
          options.totalMs !== null && { total: options.totalMs }),
      });
    } catch {
      await options.onClientGone?.();
      break;
    }
  }
  return tracked;
}

/**
 * Per-call wait from the agent's `max_wait_seconds` and the operator floor (`minAttentionWait`):
 * `undefined`/`0` → `undefined` (the server cap applies); positive → `max(value, floor)` in ms.
 */
export function effectiveAttentionWaitMs(
  maxWaitSeconds: number | undefined,
  minWaitMs: number,
): number | undefined {
  if (maxWaitSeconds === undefined || !(maxWaitSeconds > 0)) return undefined;
  return Math.max(Math.floor(maxWaitSeconds) * 1000, Math.max(0, minWaitMs));
}

/** The deadline actually armed: `max(0, min(cap, maxWaitMs ?? ∞))`. */
export function effectiveTimeoutMs(maxWaitMs: number | undefined, capMs: number): number {
  return Math.max(0, Math.min(capMs, maxWaitMs ?? Number.POSITIVE_INFINITY));
}

/**
 * Both attention tools stay registered under stdio and refuse first, before any session lookup.
 * @throws `ATTENTION_REQUIRES_HTTP`
 */
export function assertAttentionTransport(transport: string, tool: string): void {
  if (transport === 'http') return;
  throw new AppError(
    'ATTENTION_REQUIRES_HTTP',
    { tool },
    {
      publicMessage: `'${tool}' requires the http transport; human-in-the-loop attention is not available under stdio.`,
    },
  );
}
