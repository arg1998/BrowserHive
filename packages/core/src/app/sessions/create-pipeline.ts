/** @module app/sessions/create-pipeline — the D-21 creation pipeline: named vetoable phases with spans, compensators on an AsyncDisposableStack, capacity under a short lock, launch outside it. */

import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import type { Session } from '../../domain/session/session.ts';
import type { LaunchPhase } from '../../domain/session/state.ts';
import { isDeadlineExceeded, timeoutError, withDeadline } from '../../kernel/deadline.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { buildPhases, type PipelineContext } from './create-phases.ts';
import type { PipelineDeps, PipelineHooks } from './pipeline-deps.ts';

/** Every phase of the pipeline, in execution order (D-21). */
export type PipelinePhase = 'validate' | 'admit' | 'reserve' | LaunchPhase;

/** The ordered phase list; `session.<phase>` spans use the snake_case form. */
export const PIPELINE_PHASES: readonly PipelinePhase[] = [
  'validate',
  'admit',
  'reserve',
  'prepareProfile',
  'resolveIdentity',
  'launch',
  'installPolicies',
  'startTracing',
  'applyIdentity',
  'register',
];

/** Options of one `create` call. */
export interface CreateOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
}

/** Wall time spent in one phase. */
export interface PhaseTiming {
  readonly phase: PipelinePhase;
  readonly ms: number;
}

/** What `create` returns: the live session and how long each phase took. */
export interface CreateOutcome {
  readonly session: Session;
  readonly timings: readonly PhaseTiming[];
}

function snake(phase: PipelinePhase): string {
  return phase.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function abortError(reason: unknown, deadlineMs: number): AppError {
  if (isDeadlineExceeded(reason)) return timeoutError('session launch', deadlineMs, reason);
  return new AppError(
    'INTERNAL_ERROR',
    { ref: 'launch-aborted' },
    { message: 'session launch aborted by caller', cause: reason },
  );
}

/**
 * Runs `validate → admit → reserve → prepareProfile → resolveIdentity → launch → installPolicies →
 * startTracing → applyIdentity → register`. Each phase is a `session.<phase>` span with
 * `browserhive.phase_ms`; every phase that acquires something registers its compensator before the
 * next phase runs; a veto or throw in phase N runs the compensators of phases < N in reverse exactly
 * once, finalizes the reserved session as `closed(launch_failed)`, and rethrows. The signal is
 * checked between phases and the driver launch is raced against it.
 */
export async function runCreatePipeline(
  deps: PipelineDeps,
  hooks: PipelineHooks,
  options: CreateOptions,
): Promise<CreateOutcome> {
  const deadline = withDeadline(options.signal, options.deadlineMs);
  const signal = deadline.signal;
  const log = deps.logger.child({ module: 'sessions.create' });
  const stack = new AsyncDisposableStack();
  const ctx: PipelineContext = { restoredSeed: null, proxy: null };
  const timings: PhaseTiming[] = [];
  const phases = buildPhases(deps, hooks, log, stack, signal, options.deadlineMs);
  try {
    for (const phase of PIPELINE_PHASES) {
      checkpoint(ctx, signal, options.deadlineMs);
      advance(ctx, phase, deps, hooks);
      const ms = await runPhase(deps.tracer, phase, ctx, () => deps.clock.now(), phases[phase]);
      timings.push({ phase, ms });
    }
    deadline.clear();
    const session = ctx.session;
    if (session === undefined) throw new AppError('INTERNAL_ERROR', { ref: 'pipeline-no-session' });
    return { session, timings };
  } catch (err) {
    deadline.clear();
    await stack.disposeAsync();
    finalizeFailure(ctx, deps, hooks);
    throw err;
  }
}

function checkpoint(ctx: PipelineContext, signal: AbortSignal, deadlineMs: number): void {
  if (signal.aborted) throw abortError(signal.reason, deadlineMs);
  const state = ctx.session?.state;
  if (state === undefined) return;
  if (state.kind === 'crashed') {
    throw new AppError(
      'BROWSER_CRASHED',
      { session_id: ctx.session?.id ?? '' },
      { message: `browser crashed during launch: ${state.detail}` },
    );
  }
  if (state.kind === 'draining' || state.kind === 'closed') {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'launch-interrupted' },
      { message: 'session was closed while launching' },
    );
  }
}

function advance(
  ctx: PipelineContext,
  phase: PipelinePhase,
  deps: PipelineDeps,
  hooks: PipelineHooks,
): void {
  const session = ctx.session;
  if (session === undefined || phase === 'validate' || phase === 'admit' || phase === 'reserve')
    return;
  session.apply({ type: 'launch', phase, at: deps.clock.now() });
  hooks.updated(session);
}

async function runPhase(
  tracer: Tracer,
  phase: PipelinePhase,
  ctx: PipelineContext,
  now: () => number,
  run: (ctx: PipelineContext) => Promise<void>,
): Promise<number> {
  const request = ctx.request;
  return tracer.startActiveSpan(
    `session.${snake(phase)}`,
    {
      attributes: {
        ...(ctx.session !== undefined && { 'browserhive.session_id': ctx.session.id }),
        ...(request !== undefined && {
          'browserhive.channel': request.channel,
          'browserhive.stealth': request.stealth,
          'browserhive.persistence_mode': request.persistenceMode,
        }),
      },
    },
    async (span) => {
      const started = now();
      try {
        await run(ctx);
        return now() - started;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: serializeError(err).message });
        throw err;
      } finally {
        span.setAttribute('browserhive.phase_ms', now() - started);
        span.end();
      }
    },
  );
}

function finalizeFailure(ctx: PipelineContext, deps: PipelineDeps, hooks: PipelineHooks): void {
  const session = ctx.session;
  if (session === undefined) return;
  const at = deps.clock.now();
  deps.registry.release(session.id);
  if (session.state.kind !== 'crashed') {
    session.tryApply({ type: 'drain', reason: 'launch_failed', at });
    session.tryApply({ type: 'closed', at });
  }
  session.detach();
  hooks.closed(session, 'launch_failed', at);
}
