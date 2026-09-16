/** @module composition/boot — `bootServer`: runs the named phases on an unwind stack; failure in phase N unwinds N-1…1 and rethrows the typed boot error; `stop()` unwinds within the shutdown budgets (spec 01 §6). */

import type { Clock } from '@browserhive/core/runtime';
import { AppError, createSystemClock, isAppError, serializeError } from '@browserhive/core/runtime';
import { DegradationRelay } from './adapters/degradation-relay.ts';
import type { BootContext } from './context.ts';
import { PhaseTracker } from './health.ts';
import { buildDomainPhase } from './phases/build-domain.ts';
import { bunServe, type ServeFn } from './phases/listeners-http.ts';
import { observabilityPhase } from './phases/observability.ts';
import { openListenersPhase } from './phases/open-listeners.ts';
import { openStoragePhase } from './phases/open-storage.ts';
import { readyPhase } from './phases/ready.ts';
import { resolveConfigPhase } from './phases/resolve-config.ts';
import { wireObserversPhase } from './phases/wire-observers.ts';
import { installProcessHandlers, type SignalTarget } from './process-handlers.ts';
import type { BootInput, RunningServer } from './types.ts';
import { type PhaseHandle, UnwindStack } from './unwind.ts';

/** Phase names in boot order. */
export type PhaseName =
  | 'resolve-config'
  | 'observability'
  | 'open-storage'
  | 'build-domain'
  | 'wire-observers'
  | 'open-listeners'
  | 'ready';

/** One composition phase. `budgetMs` caps its `stop` during shutdown. */
export interface PhaseDefinition {
  readonly name: PhaseName;
  readonly budgetMs: number;
  run(ctx: BootContext): Promise<PhaseHandle>;
}

/** Shutdown budgets (spec 01 §6): listeners 2 s, sessions drain 15 s, storage flush 5 s. */
export const STOP_BUDGETS: Readonly<Record<PhaseName, number>> = {
  'resolve-config': 250,
  observability: 2_000,
  'open-storage': 5_000,
  'build-domain': 15_000,
  'wire-observers': 1_000,
  'open-listeners': 2_000,
  ready: 250,
};

/** The production phase list. */
export function defaultPhases(serve: ServeFn = bunServe): readonly PhaseDefinition[] {
  const phase = (name: PhaseName, run: PhaseDefinition['run']): PhaseDefinition => ({
    name,
    budgetMs: STOP_BUDGETS[name],
    run,
  });
  return [
    phase('resolve-config', resolveConfigPhase),
    phase('observability', observabilityPhase),
    phase('open-storage', openStoragePhase),
    phase('build-domain', buildDomainPhase),
    phase('wire-observers', wireObserversPhase),
    phase('open-listeners', (ctx) => openListenersPhase(ctx, serve)),
    phase('ready', readyPhase),
  ];
}

/** Test and embedding seams of {@link bootServer}. */
export interface BootOverrides {
  readonly clock?: Clock;
  /** Replaces `Bun.serve` (bind failure tests). */
  readonly serve?: ServeFn;
  /** Replaces the phase list (phase-order and unwind tests). */
  readonly phases?: (defaults: readonly PhaseDefinition[]) => readonly PhaseDefinition[];
  /** Where process handlers attach (default `process`). */
  readonly signals?: SignalTarget;
  /** Immediate exit for the forced-stop path (default `process.exit`). */
  readonly exit?: (code: number) => void;
}

/** Wraps anything that is not an `AppError` as `INTERNAL_ERROR { ref: 'boot' }`. */
export function toBootError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError(
    'INTERNAL_ERROR',
    { ref: 'boot' },
    { cause: err, message: `boot failed: ${serializeError(err).message}` },
  );
}

/**
 * Boots the server. Resolves once the `ready` phase completed (listener bound, banner printed).
 *
 * @throws `AppError` with a boot code (`PORT_IN_USE`, `BIND_FAILED`, `DATA_DIR_LOCKED`,
 * `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`, `BLOCKLIST_LOAD_FAILED`, …); earlier phases are unwound.
 */
export async function bootServer(
  input: BootInput,
  overrides: BootOverrides = {},
): Promise<RunningServer> {
  const clock = overrides.clock ?? createSystemClock();
  const config = input.resolved.config;
  const stack = new UnwindStack();
  let exitCode = 0;
  let stopping: Promise<void> | undefined;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let uninstall: () => void = () => undefined;

  const ctx: BootContext = {
    input,
    config,
    transport: config.transport,
    clock,
    health: new PhaseTracker(),
    relay: new DegradationRelay(),
    startedAt: clock.now(),
    requestStop: (code) => {
      if (stopping === undefined) exitCode = code;
      void stop();
    },
  };

  const stop = (deadlineMs: number = config.shutdownTimeout): Promise<void> => {
    if (stopping !== undefined) return stopping;
    stopping = (async () => {
      ctx.health.markStopping();
      const logger = ctx.observability?.logger;
      logger?.child({ module: 'system' }).info('shutting down', { deadline_ms: deadlineMs });
      await stack.unwind({ deadlineMs, clock, ...(logger !== undefined && { logger }) });
      uninstall();
      resolveDone(exitCode);
    })();
    return stopping;
  };

  const phases =
    overrides.phases?.(defaultPhases(overrides.serve)) ?? defaultPhases(overrides.serve);
  for (const phase of phases) {
    try {
      stack.push(phase.name, await phase.run(ctx), phase.budgetMs);
    } catch (err) {
      const bootError = toBootError(err);
      const logger = ctx.observability?.logger;
      logger?.child({ module: 'system' }).error('boot failed', {
        phase: phase.name,
        code: bootError.code,
        err: serializeError(err),
      });
      ctx.health.markStopping();
      await stack.unwind({
        deadlineMs: config.shutdownTimeout,
        clock,
        ...(logger !== undefined && { logger }),
      });
      throw bootError;
    }
  }

  if (input.installProcessHandlers) {
    uninstall = installProcessHandlers({
      target: overrides.signals ?? process,
      stop: (code) => ctx.requestStop(code),
      output: input.output,
      unhandled: (error, kind) => ctx.relay.unhandled(error, kind),
      ...(overrides.exit !== undefined && { exit: overrides.exit }),
      ...(ctx.observability !== undefined && {
        logger: ctx.observability.logger.child({ module: 'system' }),
      }),
    });
  }

  return {
    url: ctx.listeners?.url ?? null,
    transport: config.transport,
    stop: (deadlineMs) => stop(deadlineMs),
    done,
  };
}
