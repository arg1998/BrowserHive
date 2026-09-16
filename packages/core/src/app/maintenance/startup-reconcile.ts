/** @module app/maintenance/startup-reconcile — boot-time recovery after an unclean exit: open session rows closed, orphan operator requests rejected, MCP connections closed, stale Chromium processes reported. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ClosedReason } from '../../ports/persistence/enums.ts';

/** Close reason stamped on sessions a previous process left open. */
export const RESTART_CLOSE_REASON: ClosedReason = 'interrupted';
/** Degradation code for leftover browser processes. */
export const STALE_BROWSER_PROCESSES = 'STALE_BROWSER_PROCESSES';

/** Dependencies of {@link reconcileOnStartup}; every step but `sessions` is optional. */
export interface StartupReconcileDeps {
  readonly sessions: { reconcileOpen(at: number, reason: ClosedReason): Promise<number> };
  /** `OperatorRequestBroker.recoverOrphans`. */
  readonly operatorRequests?: { recoverOrphans(now?: number): Promise<number> };
  /** `McpConnectionRepository.closeAll`. */
  readonly mcpConnections?: { closeAll(at: number): Promise<number> };
  /** Returns pids of Chromium processes launched by a previous run (platform probe). */
  readonly findStaleBrowserProcesses?: () => Promise<readonly number[]>;
  readonly degradations?: DegradationReporter;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What the reconcile pass did; a step that threw reports `null`. */
export interface StartupReconcileResult {
  readonly sessionsClosed: number | null;
  readonly requestsRejected: number | null;
  readonly connectionsClosed: number | null;
  readonly stalePids: readonly number[] | null;
}

/**
 * Runs every recovery step, each isolated (a failing step is logged and the rest still run).
 * Never throws.
 *
 * @returns Per-step counts.
 */
export async function reconcileOnStartup(
  deps: StartupReconcileDeps,
): Promise<StartupReconcileResult> {
  const log = deps.logger.child({ module: 'system.startup' });
  const at = deps.clock.now();

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      log.error('reconcile step failed', { step: name, err: serializeError(err) });
      return null;
    }
  }

  const sessionsClosed = await step('sessions', () =>
    deps.sessions.reconcileOpen(at, RESTART_CLOSE_REASON),
  );
  const orphans = deps.operatorRequests;
  const requestsRejected =
    orphans === undefined ? 0 : await step('operator_requests', () => orphans.recoverOrphans(at));
  const connections = deps.mcpConnections;
  const connectionsClosed =
    connections === undefined ? 0 : await step('mcp_connections', () => connections.closeAll(at));
  const probe = deps.findStaleBrowserProcesses;
  const stalePids = probe === undefined ? [] : await step('stale_browsers', probe);

  if (stalePids !== null && stalePids.length > 0) {
    log.warn('stale browsers found', { count: stalePids.length, pids: stalePids });
    deps.degradations?.report({
      code: STALE_BROWSER_PROCESSES,
      severity: 'warn',
      message: `${stalePids.length} browser process(es) from a previous run are still alive`,
      details: { count: stalePids.length },
    });
  } else if (stalePids !== null) {
    deps.degradations?.recovered(STALE_BROWSER_PROCESSES);
  }
  if ((sessionsClosed ?? 0) + (requestsRejected ?? 0) + (connectionsClosed ?? 0) > 0) {
    log.info('startup reconciled', { sessionsClosed, requestsRejected, connectionsClosed });
  }
  return { sessionsClosed, requestsRejected, connectionsClosed, stalePids };
}
