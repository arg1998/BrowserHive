/** @module app/sessions/session-close — the close path: drain under the lock, teardown outside it (trace finalize, handle close, dir cleanup), settle through events. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { ownsSession, type SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session } from '../../domain/session/session.ts';
import type { SessionWarning } from '../../domain/session/warnings.ts';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { cleanupAfterClose, type SessionDirFs, type SessionDirLayout } from './profile-dir.ts';
import type { SessionRegistry } from './registry.ts';

/** Options of one `close` call. */
export interface CloseOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /** When given, a session owned by someone else answers `false` — indistinguishable from unknown (spec 02 §3.1). */
  readonly principal?: SessionPrincipal;
}

/** What the close path needs from the service. */
export interface CloseDeps {
  readonly registry: SessionRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly fs: SessionDirFs;
  readonly layout: SessionDirLayout;
  readonly closeTimeoutMs: number;
  updated(session: Session): void;
  warn(session: Session, warning: SessionWarning): void;
  closed(session: Session, reason: ClosedReason, at: number): void;
}

/**
 * Close and forget a session. Returns `true` if a session was removed, `false` if the id was
 * unknown or another close already owns it (idempotent). The registry removal happens under the
 * lock; the (slow) Playwright teardown runs outside it so one session never blocks the others.
 * A crashed session keeps `crashed` and settles with reason `crash`.
 */
export async function closeSession(
  sessionId: string,
  requested: ClosedReason,
  options: CloseOptions,
  deps: CloseDeps,
): Promise<boolean> {
  const session = await deps.registry.withLock(() => {
    const found = deps.registry.get(sessionId);
    if (found === undefined) return undefined;
    if (options.principal !== undefined && !ownsSession(options.principal, found.owner))
      return undefined;
    deps.registry.release(sessionId);
    return found;
  });
  if (session === undefined) return false;
  const reason: ClosedReason = session.state.kind === 'crashed' ? 'crash' : requested;
  const drained = session.tryApply({ type: 'drain', reason, at: deps.clock.now() });
  if (drained.ok) deps.updated(session);
  const deadlineMs = options.deadlineMs ?? deps.closeTimeoutMs;
  await deps.tracer.startActiveSpan(
    'session.close',
    { attributes: { 'browserhive.session_id': sessionId, 'browserhive.reason': reason } },
    async (span) => {
      try {
        await teardown(session, deadlineMs, options.signal, deps);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: serializeError(err).message });
      } finally {
        span.end();
      }
    },
  );
  const at = deps.clock.now();
  if (session.state.kind === 'draining') session.tryApply({ type: 'closed', at });
  session.detach();
  deps.closed(session, reason, at);
  return true;
}

async function teardown(
  session: Session,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  deps: CloseDeps,
): Promise<void> {
  const handle = session.handle;
  const dirs = deps.layout.forSession(session.id);
  if (handle !== null) {
    // Finalize the trace before tearing the context down; capped so a hung flush never blocks shutdown.
    if (handle.tracing !== null) {
      const deadline = withDeadline(signal, deadlineMs);
      try {
        await Promise.race([handle.tracing.stop(dirs.traceZip), rejectOnAbort(deadline.signal)]);
      } catch (err) {
        deps.warn(session, {
          code: 'TRACE_FINALIZE_FAILED',
          sessionId: session.id,
          message: 'tracing did not finalize, so this session has no trace.zip to view',
          details: { error: serializeError(err) },
        });
      } finally {
        deadline.clear();
      }
    }
    const warnings = await handle.close(deadlineMs, signal);
    for (const warning of warnings) {
      deps.warn(session, {
        code: warning.code,
        sessionId: session.id,
        message: warning.message,
        ...(warning.details !== undefined && { details: warning.details }),
      });
    }
  }
  try {
    await cleanupAfterClose(deps.fs, dirs, {
      persistent: session.request.persistenceMode === 'persistent',
    });
  } catch (err) {
    deps.logger.warn('session dir cleanup failed', {
      sessionId: session.id,
      err: serializeError(err),
    });
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
